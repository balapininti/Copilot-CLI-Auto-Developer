import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildDefectDraft, idempotencyMarker, severityRationale } from '../../src/monitoring/defect-draft.js';
import { manifestWithDefaults } from './fixtures.js';

const manifest = manifestWithDefaults();
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl';

/** @param {Record<string, any>} [extra] */
function incident(extra = {}) {
  return {
    incidentId: 'INC-20260105-ab12cd34',
    projectId: 'orders',
    environment: 'nonprod',
    service: 'orders-service',
    severity: 'high',
    firstSeen: '2026-01-05T10:00:00.000Z',
    lastSeen: '2026-01-05T10:09:00.000Z',
    sourceTimeZones: ['Z'],
    dedupeKey: 'abcdef0123456789abcdef01',
    summary: 'ERROR Failed to price order',
    exceptionClass: 'java.lang.NullPointerException',
    traceId: null,
    spanId: null,
    requestId: null,
    evidenceLinks: ['https://splunk.example.internal/app/search?sid=1'],
    deploymentVersions: ['2.14.0'],
    observedMetric: null,
    triggers: ['exception-observed'],
    correlation: { method: 'none', missing: ['traceId', 'spanId'] },
    occurrences: 3,
    samples: ['ERROR Failed to price order'],
    candidateRepos: ['service-api'],
    relatedSchemas: ['APP'],
    hypotheses: [],
    classification: 'insufficient-evidence',
    confidence: { score: 0.3, label: 'low', reasons: ['single source only'] },
    ...extra,
  };
}

describe('defect draft', () => {
  test('carries the idempotency marker, scope, boards, severity and incident id', () => {
    const draft = buildDefectDraft(incident(), manifest);
    assert.equal(draft.idempotencyMarker, `autodev-incident:${incident().incidentId}:abcdef012345`);
    assert.equal(draft.idempotencyMarker, idempotencyMarker(incident()));
    assert.ok(draft.descriptionHtml.includes(draft.idempotencyMarker));
    assert.equal(draft.scope, 'Scope:1');
    assert.deepEqual(draft.boardIds, ['501']);
    assert.equal(draft.severity, 'high');
    assert.equal(draft.incidentId, 'INC-20260105-ab12cd34');
    assert.match(draft.title, /^\[nonprod\] orders-service: java\.lang\.NullPointerException/);
  });

  test('is deterministic, so the approved payload hash matches on a later pass', () => {
    assert.deepEqual(buildDefectDraft(incident(), manifest), buildDefectDraft(incident(), manifest));
  });

  test('has the sections a developer needs', () => {
    const html = buildDefectDraft(incident(), manifest).descriptionHtml;
    for (const heading of ['Actual behaviour', 'Expected behaviour', 'Impact and severity', 'Where and when', 'Correlation identifiers', 'Evidence', 'Analysis', 'Suspected repositories', 'Reproduction clues', 'Acceptance criteria', 'Suggested validation tests']) {
      assert.ok(html.includes(`<h3>${heading}</h3>`), heading);
    }
    assert.ok(html.includes('Related DB2 schemas: APP'));
    assert.ok(html.includes('service-api'));
  });

  test('is sanitized: no email, token, password, SSN, card number or URL credentials from any incident field', () => {
    const hostile = `user jane.doe@example.com token ${TOKEN} password=hunter2hunter2 ssn 123-45-6789 card 4111 1111 1111 1111 db https://admin:s3cr3tpass@db.internal/x Authorization: Bearer abcdef1234567890abcdef`;
    const draft = buildDefectDraft(
      incident({
        summary: hostile,
        samples: [hostile, `second ${hostile}`],
        hypotheses: [{ statement: hostile, verified: false, evidence: [hostile] }],
        candidateRepos: ['service-api'],
        traceId: 'trace-0001',
        requestId: 'jane.doe@example.com',
      }),
      manifest,
    );
    const text = `${draft.title}\n${draft.descriptionHtml}`;
    for (const secret of ['jane.doe@example.com', TOKEN, 'hunter2hunter2', '123-45-6789', '4111 1111 1111 1111', 's3cr3tpass', 'abcdef1234567890abcdef']) {
      assert.ok(!text.includes(secret), `leaked: ${secret}`);
    }
    assert.ok(text.includes('[REDACTED:email]'));
    assert.ok(text.includes(draft.idempotencyMarker), 'marker survives sanitizing');
  });

  test('log text cannot inject markup into the ticket body', () => {
    const draft = buildDefectDraft(
      incident({
        summary: '<script>alert(1)</script> & <img src=x onerror=alert(2)>',
        samples: ['</li></ul><h3>Analysis</h3><p><b>Verified root cause.</b></p>'],
        service: '<b>svc</b>',
        hypotheses: [{ statement: '<iframe src="//evil">', verified: false, evidence: ['<a href=x>'] }],
      }),
      manifest,
    );
    const html = draft.descriptionHtml;
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<iframe'));
    assert.ok(!html.includes('<b>svc</b>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; '));
    assert.equal(html.match(/<h3>Analysis<\/h3>/g)?.length, 1, 'a forged Analysis heading must not appear');
    assert.ok(!html.includes('<b>Verified root cause.</b>'));
  });

  test('an evidence link cannot break out of its href attribute',
    () => {
      const html = buildDefectDraft(incident({ evidenceLinks: ['https://dt.example/p?x=" onmouseover="alert(1)'] }), manifest).descriptionHtml;
      assert.ok(!html.includes('" onmouseover="'), 'quote should be escaped as &quot;');
    });

  test('never says "Verified root cause" unless the classification says so', () => {
    for (const classification of ['insufficient-evidence', 'evidence-backed-hypothesis', 'bogus-value', undefined, null, '']) {
      const html = buildDefectDraft(incident({ classification, hypotheses: [{ statement: 'A recent commit may have caused this.', verified: false, evidence: ['abc123 fix'] }] }), manifest).descriptionHtml;
      assert.ok(!/Verified root cause/.test(html), String(classification));
      assert.ok(!/<b>Verified:<\/b>/.test(html), String(classification));
      assert.ok(/<b>Hypothesis:<\/b>/.test(html));
    }
    assert.ok(/Insufficient evidence to state a cause/.test(buildDefectDraft(incident(), manifest).descriptionHtml));
    assert.ok(/Hypothesis supported by evidence \(not proven\)/.test(buildDefectDraft(incident({ classification: 'evidence-backed-hypothesis' }), manifest).descriptionHtml));
    assert.ok(/<b>Verified root cause\.<\/b>/.test(buildDefectDraft(incident({ classification: 'verified-root-cause' }), manifest).descriptionHtml));
  });

  test('a classification named after an Object.prototype member falls back to "insufficient evidence"',
    () => {
      const html = buildDefectDraft(incident({ classification: 'constructor' }), manifest).descriptionHtml;
      assert.ok(/Insufficient evidence to state a cause/.test(html));
      assert.ok(!/function/.test(html));
    });

  test('missing correlation ids are stated as missing, not invented', () => {
    const html = buildDefectDraft(incident(), manifest).descriptionHtml;
    assert.ok(html.includes('Trace ID: not present in the source data'));
    assert.ok(html.includes('Span ID: not present in the source data'));
    assert.ok(html.includes('Request ID: not present in the source data'));
    assert.ok(html.includes('No trace id available'));
    const withIds = buildDefectDraft(incident({ traceId: 'trace-0001', spanId: 'span-0001', requestId: 'req-0001' }), manifest).descriptionHtml;
    assert.ok(withIds.includes('Trace ID: trace-0001'));
    assert.ok(withIds.includes('Span ID: span-0001'));
    assert.ok(withIds.includes('Follow trace trace-0001'));
  });

  test('a metric incident with no exception is titled and specified by its metric', () => {
    const draft = buildDefectDraft(
      incident({
        exceptionClass: null,
        summary: 'p95LatencyMs breached: observed 2410ms, threshold 1500ms',
        observedMetric: { metric: 'builtin:service.response.time:percentile(95)', observed: 2410, threshold: 1500, baseline: 1406.25, unit: 'ms' },
        triggers: ['threshold-breached'],
      }),
      manifest,
    );
    assert.match(draft.title, /builtin:service\.response\.time:percentile\(95\)/);
    assert.ok(draft.descriptionHtml.includes('observed 2410ms against a threshold of 1500ms, average 1406.25ms'));
    assert.ok(draft.descriptionHtml.includes('stays within 1500ms after the fix'));
    assert.ok(draft.descriptionHtml.includes('without breaching the agreed threshold'));
  });

  test('empty lists and absent optional fields render as "None recorded" / "not reported" rather than throwing', () => {
    const draft = buildDefectDraft(
      incident({ environment: null, service: null, evidenceLinks: [], candidateRepos: [], relatedSchemas: [], samples: [], hypotheses: undefined, deploymentVersions: undefined, sourceTimeZones: [], exceptionClass: null, triggers: [] }),
      manifest,
    );
    assert.match(draft.title, /^\[env\?\] unknown service: Service problem/);
    assert.ok(draft.descriptionHtml.includes('<p>None recorded.</p>'));
    assert.ok(draft.descriptionHtml.includes('Service: not identified'));
    assert.ok(draft.descriptionHtml.includes('Deployment version(s): not reported'));
    assert.ok(!draft.descriptionHtml.includes('Related DB2 schemas'));
    assert.ok(!draft.descriptionHtml.includes('undefined'));
  });

  test('the title is bounded and sanitized', () => {
    const draft = buildDefectDraft(incident({ summary: `mail bob@example.com ${'x'.repeat(500)}` }), manifest);
    assert.ok(draft.title.length <= 180);
    assert.ok(!draft.title.includes('bob@example.com'));
  });

  test('scope is null when the project has no defect scope', () => {
    const noScope = manifestWithDefaults();
    delete noScope.agility.defectScope;
    assert.equal(buildDefectDraft(incident(), noScope).scope, null);
  });

  test('severityRationale states severity, triggers, counts and confidence', () => {
    const text = severityRationale(incident());
    assert.match(text, /^Severity high\./);
    assert.match(text, /Triggered by: exception-observed\./);
    assert.match(text, /3 occurrence\(s\) between 2026-01-05T10:00:00\.000Z and 2026-01-05T10:09:00\.000Z \(UTC\)/);
    assert.match(text, /Confidence that this is one real incident: low \(single source only\)/);
  });
});
