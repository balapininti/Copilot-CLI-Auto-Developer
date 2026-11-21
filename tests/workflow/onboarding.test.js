import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { Ajv } from 'ajv';
import YAML from 'yaml';

import { loadManifest, parseManifest } from '../../src/core/manifest.js';
import { AUTOMATION_ROOT } from '../../src/core/workspace.js';
import { buildManifest, localChecks, onboardProject, QUESTIONS } from '../../src/workflow/onboarding.js';
import { expectCode, tempWorkspace } from '../helpers.js';

const FULL = {
  id: 'orders',
  name: 'Orders',
  agilityBaseUrlEnv: 'AGILITY_BASE_URL',
  boardIds: '501, 502',
  teamNames: 'Orders',
  defectScope: 'Scope:1234',
  acceptanceCriteriaField: 'Custom_AcceptanceCriteria',
  releaseBranchPattern: 'Release branch:\\s*(\\S+)',
  bitbucketFlavor: 'server',
  bitbucketBaseUrlEnv: 'BITBUCKET_BASE_URL',
  bitbucketProjectKey: 'ORD',
  bitbucketAllowedHosts: 'Bitbucket.Example.Internal',
  repositories: 'service-api=SERVICE_API_REPO_URL, web-ui=WEB_UI_REPO_URL',
  db2ConnectionProfile: 'orders-dev',
  db2Schemas: 'app, common',
  services: 'orders-service=service-api',
  splunkBaseUrlEnv: 'SPLUNK_BASE_URL',
  splunkIndexes: 'app_nonprod',
  dynatraceBaseUrlEnv: 'DYNATRACE_BASE_URL',
  dynatraceEntitySelectors: 'type(SERVICE),tag(app:orders); type(SERVICE),tag(app:pay)',
  monitoringEnvironment: 'nonprod',
  javaVersion: '21',
  springBootVersion: '3.3.1',
  requiredTests: 'compile, unit, integration',
  chromiumApproved: true,
};

function schemaValidator() {
  const schema = JSON.parse(fs.readFileSync(path.join(AUTOMATION_ROOT, 'schemas', 'project.schema.json'), 'utf8'));
  return new Ajv({ allErrors: true, strict: false }).compile(schema);
}

describe('onboarding: buildManifest', () => {
  test('a manifest built from full answers validates against the JSON schema', () => {
    const validate = schemaValidator();
    const manifest = buildManifest(FULL);
    assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
    assert.deepEqual(manifest.agility.boardIds, ['501', '502']);
    assert.deepEqual(manifest.repositories.map((/** @type {any} */ r) => [r.name, r.urlEnv, r.localPath]), [
      ['service-api', 'SERVICE_API_REPO_URL', 'repos/service-api'],
      ['web-ui', 'WEB_UI_REPO_URL', 'repos/web-ui'],
    ]);
    assert.deepEqual(manifest.database.schemas, ['APP', 'COMMON']);
    assert.equal(manifest.database.engine, 'db2');
    assert.deepEqual(manifest.bitbucket.allowedHosts, ['bitbucket.example.internal']);
    assert.deepEqual(manifest.monitoring.dynatrace.entitySelectors, ['type(SERVICE),tag(app:orders)', 'type(SERVICE),tag(app:pay)']);
    assert.equal(manifest.browser.chromiumFallback, 'approved');
    assert.deepEqual(manifest.tests.required, ['compile', 'unit', 'integration']);
  });

  test('a manifest built from only an id validates against the schema and guesses nothing', () => {
    const validate = schemaValidator();
    const manifest = buildManifest({ id: 'bare' });
    assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
    assert.equal(manifest.agility.baseUrlEnv, null);
    assert.equal(manifest.bitbucket.flavor, null);
    assert.equal(manifest.database.engine, null);
    assert.deepEqual(manifest.repositories, []);
    assert.deepEqual(manifest.services, []);
  });

  test('every default is the restrictive choice', () => {
    const manifest = buildManifest({ id: 'bare' });
    assert.equal(manifest.policies.createPR, 'approval-required');
    assert.equal(manifest.policies.createDefect, 'approval-required');
    assert.equal(manifest.policies.dbWrites, 'prohibited');
    assert.equal(manifest.policies.productionChanges, 'prohibited');
    assert.equal(manifest.database.writeAccess, false);
    assert.equal(manifest.monitoring.enabled, false);
    assert.equal(manifest.monitoring.incidentPolicy.autoStartDevelopment, false);
    assert.equal(manifest.monitoring.incidentPolicy.productionRemediation, 'prohibited');
    assert.equal(manifest.browser.chromiumFallback, 'allowed-only-if-approved');
    assert.equal(manifest.learning.persistence, 'explicit-approval-only');
    assert.deepEqual(manifest.monitoring.thresholds, { errorCount: null, errorRatePercent: null, p95LatencyMs: null });
  });

  test('chromium is approved only by an explicit boolean true', () => {
    for (const value of ['yes', 'true', 1, 'approved', null]) {
      assert.equal(buildManifest({ id: 'x', chromiumApproved: value }).browser.chromiumFallback, 'allowed-only-if-approved');
    }
  });

  test('invalid or path-like project ids are rejected', async () => {
    for (const id of ['', '../evil', 'a/b', 'a\\b', '.hidden', 'x'.repeat(101), 'has space', undefined, null]) {
      await expectCode(() => buildManifest({ id }), 'INVALID_ARGUMENT');
    }
  });

  test('a repository name that could traverse paths is rejected', async () => {
    await expectCode(() => buildManifest({ id: 'x', repositories: '../../outside=URL_ENV' }), 'INVALID_ARGUMENT');
    await expectCode(() => buildManifest({ id: 'x', repositories: 'a/b=URL_ENV' }), 'INVALID_ARGUMENT');
  });

  test('malformed pairs are rejected rather than guessed', async () => {
    await expectCode(() => buildManifest({ id: 'x', repositories: 'a=b=c' }), 'INVALID_ARGUMENT');
    await expectCode(() => buildManifest({ id: 'x', services: '=service-api' }), 'INVALID_ARGUMENT');
    assert.equal(buildManifest({ id: 'x', repositories: 'api' }).repositories[0].urlEnv, null);
  });

  describe('secrets in answers are rejected', () => {
    const cases = {
      'a bearer token': { agilityBaseUrlEnv: 'Bearer abcdefghijklmnop123456' },
      'a password assignment': { name: 'password=hunter2hunter2' },
      'a URL with credentials': { bitbucketBaseUrlEnv: 'https://user:s3cretpass@bitbucket.example.internal' },
      'a JWT': { splunkProfile: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' },
      'a GitHub token': { dynatraceProfile: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
      'a private key': { name: '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----' },
    };
    for (const [label, answers] of Object.entries(cases)) {
      test(`rejects ${label}`, async () => {
        const error = await expectCode(() => buildManifest({ id: 'x', ...answers }), 'INVALID_ARGUMENT', /looks like a secret/);
        assert.ok(!JSON.stringify(error.details ?? {}).includes('hunter2hunter2'));
      });
    }

    test('a secret hidden inside a list answer never reaches disk', async () => {
      const ws = tempWorkspace();
      try {
        let threw = false;
        try {
          onboardProject(ws.workspace, { id: 'x', securityRestrictions: ['password=hunter2hunter2'] }, { env: {} });
        } catch (error) {
          threw = true;
          assert.ok(['INVALID_ARGUMENT', 'CONFIG_INVALID'].includes(/** @type {any} */ (error).code));
        }
        assert.ok(threw, 'onboarding must refuse a secret inside a list answer');
        assert.equal(fs.existsSync(path.join(ws.workspace.projectsDir, 'x')), false);
      } finally {
        ws.cleanup();
      }
    });
  });

  test('the questionnaire has unique keys and starts with the project id', () => {
    const keys = QUESTIONS.map((q) => q.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(keys[0], 'id');
  });
});

describe('onboarding: onboardProject', () => {
  /** @type {ReturnType<typeof tempWorkspace>} */
  let ws;
  beforeEach(() => { ws = tempWorkspace(); });
  afterEach(() => ws.cleanup());

  test('dry run writes nothing and lists what it would write', () => {
    const result = onboardProject(ws.workspace, FULL, { dryRun: true, env: {} });
    assert.equal(result.dryRun, true);
    assert.ok(/** @type {any} */ (result).wouldWrite.includes('project.yaml'));
    assert.ok(/** @type {any} */ (result).wouldWrite.includes('guidelines/architecture.md'));
    assert.match(/** @type {any} */ (result).manifest, /^# Auto Developer project manifest/);
    assert.equal(fs.existsSync(ws.workspace.projectsDir), false);
    assert.equal(fs.existsSync(ws.workspace.stateDir), false);
    assert.deepEqual(fs.readdirSync(ws.root), []);
  });

  test('writes project.yaml, guideline templates and knowledge layout; the result loads as a manifest', () => {
    const result = onboardProject(ws.workspace, FULL, { env: {} });
    assert.equal(result.dryRun, false);
    for (const relative of ['project.yaml', 'guidelines/architecture.md', 'guidelines/coding-standards.md', 'guidelines/development-workflow.md', 'guidelines/testing-standards.md', 'knowledge/README.md', 'repos/.gitkeep']) {
      assert.ok(fs.existsSync(path.join(result.dir, ...relative.split('/'))), relative);
    }
    const { manifest, missing } = loadManifest(ws.workspace, 'orders');
    assert.equal(manifest.id, 'orders');
    assert.equal(manifest.policies.productionChanges, 'prohibited');
    assert.deepEqual(missing, result.missing);
    assert.ok(!fs.readFileSync(path.join(result.dir, 'project.yaml'), 'utf8').includes('http'));
  });

  test('partial onboarding succeeds and populates the missing list', () => {
    const result = onboardProject(ws.workspace, { id: 'partial', name: 'Partial' }, { env: {} });
    const fields = result.missing.map((item) => item.field);
    for (const expected of ['agility.baseUrlEnv', 'agility.boardId', 'agility.defectScope', 'repositories', 'bitbucket.allowedHosts', 'bitbucket.flavor', 'bitbucket.projectKey', 'services']) {
      assert.ok(fields.includes(expected), `missing list should include ${expected}: ${fields.join(', ')}`);
    }
    assert.ok(result.missing.every((item) => item.neededFor.length > 0));
    const yaml = YAML.parse(fs.readFileSync(path.join(result.dir, 'project.yaml'), 'utf8'));
    assert.equal(yaml.agility.baseUrlEnv, null);
  });

  test('full answers leave only what was genuinely not answered as missing', () => {
    const result = onboardProject(ws.workspace, FULL, { dryRun: true, env: {} });
    const fields = result.missing.map((item) => item.field);
    assert.ok(!fields.includes('agility.baseUrlEnv'));
    assert.ok(!fields.includes('repositories'));
    assert.ok(!fields.some((field) => field.startsWith('repositories[')));
  });

  test('an existing project is not overwritten (also not by a dry run)', async () => {
    const first = onboardProject(ws.workspace, FULL, { env: {} });
    const file = path.join(first.dir, 'project.yaml');
    fs.appendFileSync(file, '# hand edit\n');
    const before = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(path.join(first.dir, 'guidelines', 'architecture.md'), 'filled in by the team\n');
    const error = await expectCode(() => onboardProject(ws.workspace, { ...FULL, name: 'Replaced' }, { env: {} }), 'CONFLICT', /already exists/);
    assert.equal(error.details.file, file);
    await expectCode(() => onboardProject(ws.workspace, { ...FULL, name: 'Replaced' }, { dryRun: true, env: {} }), 'CONFLICT');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(first.dir, 'guidelines', 'architecture.md'), 'utf8'), 'filled in by the team\n');
  });

  test('guideline files already filled in are kept when the project.yaml is absent', () => {
    const dir = path.join(ws.workspace.projectsDir, 'orders');
    fs.mkdirSync(path.join(dir, 'guidelines'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'guidelines', 'architecture.md'), 'ours\n');
    onboardProject(ws.workspace, FULL, { env: {} });
    assert.equal(fs.readFileSync(path.join(dir, 'guidelines', 'architecture.md'), 'utf8'), 'ours\n');
  });

  test('a service mapped to an unknown repository is rejected and nothing is written', async () => {
    await expectCode(() => onboardProject(ws.workspace, { ...FULL, services: 'orders-service=no-such-repo' }, { env: {} }), 'CONFIG_INVALID');
    assert.equal(fs.existsSync(ws.workspace.projectsDir), false);
  });

  test('an invalid bitbucket flavor or test stage is rejected by the schema, nothing written', async () => {
    await expectCode(() => onboardProject(ws.workspace, { ...FULL, bitbucketFlavor: 'gitlab' }, { env: {} }), 'CONFIG_INVALID');
    await expectCode(() => onboardProject(ws.workspace, { ...FULL, requiredTests: 'unit, vibes' }, { env: {} }), 'CONFIG_INVALID');
    await expectCode(() => onboardProject(ws.workspace, { ...FULL, agilityBaseUrlEnv: 'https://agility.example.internal' }, { env: {} }), 'CONFIG_INVALID');
    await expectCode(() => onboardProject(ws.workspace, { ...FULL, featureBranchPattern: 'feature/no-story-token' }, { env: {} }), 'CONFIG_INVALID');
    assert.equal(fs.existsSync(ws.workspace.projectsDir), false);
  });

  test('answers containing YAML metacharacters round-trip as plain strings', () => {
    const name = 'Orders: "the" #1 project\n- injected: true\npolicies: {dbWrites: approval-required}';
    const result = onboardProject(ws.workspace, { ...FULL, name }, { env: {} });
    const { manifest } = loadManifest(ws.workspace, 'orders');
    assert.equal(manifest.name, name.trim());
    assert.equal(manifest.policies.dbWrites, 'prohibited');
    assert.equal(result.projectId, 'orders');
  });

  test('local checks warn about unset variables and unapproved repository hosts without failing', () => {
    const unset = onboardProject(ws.workspace, FULL, { dryRun: true, env: {} });
    assert.ok(unset.warnings.some((w) => /AGILITY_BASE_URL/.test(w)));
    assert.ok(unset.warnings.some((w) => /SERVICE_API_REPO_URL/.test(w)));
    const { manifest } = parseManifest(YAML.stringify(buildManifest(FULL)));
    const warnings = localChecks(manifest, {
      AGILITY_BASE_URL: 'x', BITBUCKET_BASE_URL: 'x', SPLUNK_BASE_URL: 'x', DYNATRACE_BASE_URL: 'x',
      SERVICE_API_REPO_URL: 'https://github.com/someone/service-api.git',
      WEB_UI_REPO_URL: 'https://bitbucket.example.internal/scm/ord/web-ui.git',
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /github\.com.*not in bitbucket\.allowedHosts/);
    const credWarnings = localChecks(manifest, { SERVICE_API_REPO_URL: 'https://user:pw@bitbucket.example.internal/x.git', WEB_UI_REPO_URL: 'git@bitbucket.example.internal:ord/web-ui.git' });
    assert.ok(credWarnings.some((w) => /service-api: .*credentials/.test(w)));
    assert.ok(!credWarnings.some((w) => /web-ui/.test(w)));
  });
});
