/**
 * Drafting an Agility defect from an incident.
 *
 * The draft is built only from sanitized incident fields. It states what was
 * observed and what is suspected, keeps the two apart, and carries an
 * idempotency marker so the same incident can never produce two tickets.
 */

import { redactString } from '../core/redact.js';

/**
 * @param {Record<string, any>} incident
 * @returns {string}
 */
export function idempotencyMarker(incident) {
  return `autodev-incident:${incident.dedupeKey}`;
}

/** @param {unknown} value */
function esc(value) {
  return redactString(String(value ?? ''), { pii: true })
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {string[]} items
 */
function ul(items) {
  return items.length > 0 ? `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>` : '<p>None recorded.</p>';
}

const CLASSIFICATION_LABEL = Object.freeze({
  'verified-root-cause': 'Verified root cause',
  'evidence-backed-hypothesis': 'Hypothesis supported by evidence (not proven)',
  'insufficient-evidence': 'Insufficient evidence to state a cause',
});

/**
 * @param {Record<string, any>} incident
 * @returns {string}
 */
export function severityRationale(incident) {
  const parts = [`Severity ${incident.severity}.`];
  if (incident.triggers.length > 0) parts.push(`Triggered by: ${incident.triggers.join(', ')}.`);
  parts.push(`${incident.occurrences} occurrence(s) between ${incident.firstSeen} and ${incident.lastSeen} (UTC).`);
  if (incident.observedMetric) {
    const m = incident.observedMetric;
    parts.push(`${m.metric}: observed ${m.observed}${m.unit ?? ''} against a threshold of ${m.threshold}${m.unit ?? ''}${m.baseline === null ? '' : `, average ${m.baseline}${m.unit ?? ''}`}.`);
  }
  parts.push(`Confidence that this is one real incident: ${incident.confidence.label} (${incident.confidence.reasons.join('; ')}).`);
  return parts.join(' ');
}

/**
 * @param {Record<string, any>} incident
 * @param {Record<string, any>} manifest
 * @returns {{ title: string, descriptionHtml: string, idempotencyMarker: string, boardIds: string[], scope: string | null, severity: string, incidentId: string }}
 */
export function buildDefectDraft(incident, manifest) {
  const what = incident.exceptionClass ?? incident.observedMetric?.metric ?? 'Service problem';
  const title = redactString(`[${incident.environment ?? 'env?'}] ${incident.service ?? 'unknown service'}: ${what} – ${incident.summary}`, { pii: true }).slice(0, 180);
  const marker = idempotencyMarker(incident);
  const classification = Object.hasOwn(CLASSIFICATION_LABEL, incident.classification)
    ? CLASSIFICATION_LABEL[/** @type {keyof typeof CLASSIFICATION_LABEL} */ (incident.classification)]
    : CLASSIFICATION_LABEL['insufficient-evidence'];

  const correlationIds = [
    incident.traceId ? `Trace ID: ${esc(incident.traceId)}` : 'Trace ID: not present in the source data',
    incident.spanId ? `Span ID: ${esc(incident.spanId)}` : 'Span ID: not present in the source data',
    incident.requestId ? `Request ID: ${esc(incident.requestId)}` : 'Request ID: not present in the source data',
  ];
  const hypotheses = (incident.hypotheses ?? []).map(
    (/** @type {any} */ h) => `<b>${h.verified ? 'Verified' : 'Hypothesis'}:</b> ${esc(h.statement)}${h.evidence?.length ? ` (evidence: ${h.evidence.map(esc).join('; ')})` : ''}`,
  );

  const descriptionHtml = [
    `<p><b>Raised by the monitoring worker from incident ${esc(incident.incidentId)}.</b> Evidence below is sanitized; open the links for full detail.</p>`,
    '<h3>Actual behaviour</h3>',
    `<p>${esc(incident.summary)}</p>`,
    ul(incident.samples.slice(0, 3).map(esc)),
    '<h3>Expected behaviour</h3>',
    `<p>${esc(incident.service ?? 'The service')} handles these requests without ${incident.observedMetric ? 'breaching the agreed threshold' : 'this error'}.</p>`,
    '<h3>Impact and severity</h3>',
    `<p>${esc(severityRationale(incident))}</p>`,
    '<h3>Where and when</h3>',
    ul([
      `Environment: ${esc(incident.environment ?? 'not configured')}`,
      `Service: ${esc(incident.service ?? 'not identified')}`,
      `First seen (UTC): ${esc(incident.firstSeen)}`,
      `Last seen (UTC): ${esc(incident.lastSeen)}`,
      `Source time zone(s): ${esc(incident.sourceTimeZones.join(', ') || 'not reported')}`,
      `Deployment version(s): ${esc((incident.deploymentVersions ?? []).join(', ') || 'not reported')}`,
    ]),
    '<h3>Correlation identifiers</h3>',
    ul(correlationIds),
    `<p>Correlation method: ${esc(incident.correlation.method)}.</p>`,
    '<h3>Evidence</h3>',
    ul(incident.evidenceLinks.map((/** @type {string} */ link) => `<a href="${esc(link)}">${esc(link)}</a>`)),
    '<h3>Analysis</h3>',
    `<p><b>${classification}.</b></p>`,
    ul(hypotheses),
    '<h3>Suspected repositories</h3>',
    ul(incident.candidateRepos.map(esc)),
    incident.relatedSchemas.length > 0 ? `<p>Related DB2 schemas: ${incident.relatedSchemas.map(esc).join(', ')}</p>` : '',
    '<h3>Reproduction clues</h3>',
    ul([
      incident.traceId ? `Follow trace ${esc(incident.traceId)} in the tracing tool.` : 'No trace id available; search logs by service and time window.',
      `Search the service logs for: ${esc(incident.exceptionClass ?? incident.summary)}`,
    ]),
    '<h3>Acceptance criteria</h3>',
    ul([
      'The root cause is identified and documented on this defect.',
      incident.observedMetric
        ? `${esc(incident.observedMetric.metric)} stays within ${esc(incident.observedMetric.threshold)}${esc(incident.observedMetric.unit ?? '')} after the fix.`
        : `The error no longer occurs in ${esc(incident.environment ?? 'the affected environment')} after the fix is deployed.`,
      'An automated test reproduces the failure and passes with the fix.',
    ]),
    '<h3>Suggested validation tests</h3>',
    ul([
      'A unit or integration test that reproduces the failing path.',
      'A regression run of the affected service\'s existing test suite.',
      'A post-deployment telemetry check over at least one dedupe window.',
    ]),
    `<p><small>${marker}</small></p>`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    title,
    descriptionHtml,
    idempotencyMarker: marker,
    boardIds: manifest.agility.boardIds,
    scope: manifest.agility.defectScope ?? null,
    severity: incident.severity,
    incidentId: incident.incidentId,
  };
}
