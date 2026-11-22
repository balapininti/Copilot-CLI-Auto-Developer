import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import YAML from 'yaml';

import {
  applyDefaults,
  envValue,
  findMissing,
  isMissing,
  loadManifest,
  parseManifest,
  requireEnvValue,
} from '../../src/core/manifest.js';
import { expectCode, fullManifest, tempWorkspace, writeProject } from '../helpers.js';

/**
 * The project.yaml template from the product specification (reconstructed
 * here; the repository does not ship a copy of it).
 */
const SPEC_TEMPLATE = `
id: project-a
name: Project A

agility:
  boardId: BOARD_ID
  baseUrlEnv: AGILITY_BASE_URL

repositories:
  - name: service-api
    urlEnv: PROJECT_A_SERVICE_API_REPO_URL
    localPath: repos/service-api
    branchPolicy: story-release-branch-required

database:
  engine: db2
  connectionProfile: project-a-nonprod
  schemas:
    - APP
    - COMMON
  writeAccess: false

observability:
  splunkProfile: project-a
  dynatraceProfile: project-a

browser:
  preferred: msedge
  chromiumFallback: allowed-only-if-approved

learning:
  persistence: explicit-approval-only

policies:
  createPR: approval-required
  createDefect: approval-required
  schemaChanges: approval-required
  dbWrites: prohibited
  productionChanges: prohibited

monitoring:
  enabled: true
  schedule: "*/15 * * * *"
  environment: nonprod
  services:
    - service-api
  splunk:
    profile: project-a
    indexes:
      - app_nonprod
    savedSearches: []
  dynatrace:
    profile: project-a
    entitySelectors:
      - type(SERVICE),tag(project:project-a)
  correlation:
    traceIdFields: [trace_id, traceId]
    spanIdFields: [span_id, spanId]
    requestIdFields: [request_id, requestId]
    serviceNameFields: [service, application]
  thresholds:
    errorCount: null
    errorRatePercent: null
    p95LatencyMs: null
  incidentPolicy:
    dedupeWindowMinutes: 60
    createTicket: approval-required
    autoStartDevelopment: false
    productionRemediation: prohibited
`;

const yaml = (/** @type {unknown} */ value) => YAML.stringify(value);
const fields = (/** @type {Array<{ field: string }>} */ missing) => missing.map((item) => item.field);

describe('parseManifest: accepted manifests', () => {
  test("the spec's template manifest parses", () => {
    const { manifest, missing } = parseManifest(SPEC_TEMPLATE, { expectedId: 'project-a' });
    assert.equal(manifest.id, 'project-a');
    assert.equal(manifest.repositories[0].branchPolicy, 'story-release-branch-required');
    assert.deepEqual(manifest.database.schemas, ['APP', 'COMMON']);
    assert.equal(manifest.database.writeAccess, false);
    assert.equal(manifest.policies.productionChanges, 'prohibited');
    assert.equal(manifest.policies.dbWrites, 'prohibited');
    assert.equal(manifest.monitoring.incidentPolicy.productionRemediation, 'prohibited');
    assert.equal(manifest.monitoring.thresholds.p95LatencyMs, null);
    assert.ok(Array.isArray(missing));
  });

  test('BOARD_ID placeholder counts as missing and is not used as a board id', () => {
    const { manifest, missing } = parseManifest(SPEC_TEMPLATE);
    assert.ok(fields(missing).includes('agility.boardId'));
    assert.deepEqual(manifest.agility.boardIds, []);
    assert.equal(isMissing('BOARD_ID'), true);
    for (const placeholder of ['todo', 'TBD', ' changeme ', '<board id>', '', '   ', null, undefined, []]) assert.equal(isMissing(placeholder), true, String(placeholder));
    for (const real of ['501', 'B-1', 0, false, ['x']]) assert.equal(isMissing(real), false, String(real));
  });

  test('a real boardId is folded into boardIds once', () => {
    const { manifest, missing } = parseManifest(yaml({ id: 'p', agility: { boardId: '501', boardIds: ['777', '501'] } }));
    assert.deepEqual(manifest.agility.boardIds, ['777', '501']);
    assert.deepEqual(parseManifest(yaml({ id: 'p', agility: { boardId: '501', boardIds: ['777'] } })).manifest.agility.boardIds, ['501', '777']);
    assert.ok(!fields(missing).includes('agility.boardId'));
  });

  test('a complete manifest has nothing missing', () => {
    const { missing } = parseManifest(yaml(fullManifest()));
    assert.deepEqual(missing, []);
  });

  test('partial manifests load with a `missing` list naming what each field is needed for', () => {
    const { manifest, missing } = parseManifest('id: tiny\n');
    assert.equal(manifest.id, 'tiny');
    const names = fields(missing);
    for (const expected of ['agility.baseUrlEnv', 'agility.boardId', 'agility.defectScope', 'repositories', 'bitbucket.allowedHosts', 'bitbucket.flavor', 'bitbucket.baseUrlEnv', 'bitbucket.projectKey', 'guidelines', 'services']) {
      assert.ok(names.includes(expected), `missing list should include ${expected}`);
    }
    for (const item of missing) assert.ok(item.neededFor.length > 0);
    assert.ok(!names.some((name) => name.startsWith('monitoring.')), 'monitoring is off, so its fields are not demanded');
    assert.ok(!names.some((name) => name.startsWith('database.')), 'no database engine, so no database fields are demanded');
  });

  test('missing list covers per-repository, per-service, database and monitoring gaps', () => {
    const { missing } = parseManifest(yaml({
      id: 'p',
      repositories: [{ name: 'api', localPath: 'repos/api', urlEnv: null }],
      services: [{ name: 'svc', repository: null }],
      database: { engine: 'db2' },
      monitoring: { enabled: true },
    }));
    const names = fields(missing);
    assert.ok(names.includes('repositories[0].urlEnv (api)'));
    assert.ok(names.includes('services[0].repository (svc)'));
    assert.ok(names.includes('database.connectionProfile'));
    assert.ok(names.includes('database.schemas'));
    for (const expected of ['monitoring.environment', 'observability.splunkBaseUrlEnv', 'monitoring.splunk.indexes', 'observability.dynatraceBaseUrlEnv', 'monitoring.dynatrace.entitySelectors', 'monitoring.thresholds']) {
      assert.ok(names.includes(expected), expected);
    }
  });

  test('defaults are the restrictive choice', () => {
    const { manifest } = parseManifest('id: p\n');
    assert.deepEqual(manifest.policies, {
      createPR: 'approval-required', createDefect: 'approval-required', updateTicket: 'approval-required',
      schemaChanges: 'approval-required', dbWrites: 'prohibited', planReview: 'required', productionChanges: 'prohibited',
    });
    assert.equal(manifest.database.writeAccess, false);
    assert.equal(manifest.monitoring.enabled, false);
    assert.equal(manifest.monitoring.incidentPolicy.createTicket, 'approval-required');
    assert.equal(manifest.monitoring.incidentPolicy.autoStartDevelopment, false);
    assert.equal(manifest.monitoring.incidentPolicy.productionRemediation, 'prohibited');
    assert.equal(manifest.learning.persistence, 'explicit-approval-only');
    assert.equal(manifest.browser.chromiumFallback, 'allowed-only-if-approved');
    assert.deepEqual(manifest.branching.protected, ['main', 'master', 'develop', 'release/*']);
    assert.deepEqual(manifest.tests.required, ['compile', 'unit']);
    assert.deepEqual(manifest.monitoring.thresholds, { errorCount: null, errorRatePercent: null, p95LatencyMs: null });
  });

  test('applyDefaults forces productionChanges and productionRemediation to prohibited even for unvalidated input', () => {
    const m = applyDefaults({ id: 'p', policies: { productionChanges: 'allowed', createPR: 'allowed' }, monitoring: { incidentPolicy: { productionRemediation: 'allowed' } }, learning: { persistence: 'automatic' } });
    assert.equal(m.policies.productionChanges, 'prohibited');
    assert.equal(m.policies.createPR, 'allowed');
    assert.equal(m.monitoring.incidentPolicy.productionRemediation, 'prohibited');
    assert.equal(m.learning.persistence, 'explicit-approval-only');
  });

  test('applyDefaults does not mutate its input', () => {
    const input = { id: 'p', agility: { boardId: '501' } };
    applyDefaults(input);
    assert.deepEqual(input, { id: 'p', agility: { boardId: '501' } });
  });

  test('findMissing reports nothing invented: thresholds all null is called out only when monitoring is on', () => {
    const m = applyDefaults(fullManifest());
    m.monitoring.thresholds = { errorCount: null, errorRatePercent: null, p95LatencyMs: null };
    assert.deepEqual(fields(findMissing(m)), ['monitoring.thresholds']);
    m.monitoring.enabled = false;
    assert.deepEqual(findMissing(m), []);
  });
});

describe('parseManifest: rejected manifests', () => {
  /** @param {string} text @param {RegExp} [problem] */
  const rejects = async (text, problem) => {
    const error = await expectCode(() => parseManifest(text), 'CONFIG_INVALID');
    if (problem) assert.match([error.message, ...(error.details.problems ?? [])].join('\n'), problem);
    return error;
  };

  test('secrets in YAML are rejected, and the message does not echo the secret', async () => {
    for (const text of [
      'id: p\ndescription: "password=hunter2hunter2"\n',
      'id: p\nagility:\n  tokenSecret: AGILITY_TOKEN\n# Authorization: Bearer abcdefgh12345678\n',
      'id: p\ntech:\n  repo: https://svc:s3cretpass@bitbucket.example.internal/scm/a/b.git\n',
      'id: p\ntech:\n  jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U\n',
      'id: p\ntech:\n  password: hunter2hunter2\n',
      'id: p\ntech:\n  key: |\n    -----BEGIN PRIVATE KEY-----\n    MIIEvQIBADANBg\n    -----END PRIVATE KEY-----\n',
    ]) {
      const error = await expectCode(() => parseManifest(text, { source: 'projects/p/project.yaml' }), 'CONFIG_INVALID', /appears to contain a secret/);
      assert.ok(!/hunter2|abcdefgh12345678|s3cretpass|dozjgNry|MIIEvQ/.test(JSON.stringify({ m: error.message, d: error.details })));
      assert.equal(error.details.source, 'projects/p/project.yaml');
    }
  });

  test('names of secrets and env variables are not mistaken for secrets', () => {
    assert.doesNotThrow(() => parseManifest(yaml(fullManifest())));
  });

  test('unknown keys are rejected at every level', async () => {
    await rejects('id: p\nunknownTopLevel: 1\n', /additional properties/);
    await rejects(yaml({ id: 'p', agility: { apiToken: 'X' } }), /additional properties/);
    await rejects(yaml({ id: 'p', repositories: [{ name: 'a', localPath: 'r', url: 'X' }] }), /additional properties/);
    await rejects(yaml({ id: 'p', policies: { mergePR: 'allowed' } }), /additional properties/);
    await rejects(yaml({ id: 'p', monitoring: { incidentPolicy: { autoRemediate: true } } }), /additional properties/);
    await rejects(yaml({ id: 'p', database: { port: 50000 } }), /additional properties/);
    await rejects(yaml({ id: 'p', database: { password: null } }));
  });

  test('`productionChanges` can only be prohibited', async () => {
    for (const value of ['allowed', 'approval-required', 'Prohibited', true, null]) {
      await rejects(yaml({ id: 'p', policies: { productionChanges: value } }), /policies\/productionChanges/);
    }
    assert.equal(parseManifest(yaml({ id: 'p', policies: { productionChanges: 'prohibited' } })).manifest.policies.productionChanges, 'prohibited');
  });

  test('other always-restricted settings cannot be loosened', async () => {
    await rejects(yaml({ id: 'p', policies: { dbWrites: 'allowed' } }), /dbWrites/);
    await rejects(yaml({ id: 'p', policies: { schemaChanges: 'allowed' } }), /schemaChanges/);
    await rejects(yaml({ id: 'p', monitoring: { incidentPolicy: { productionRemediation: 'allowed' } } }), /productionRemediation/);
    await rejects(yaml({ id: 'p', learning: { persistence: 'automatic' } }), /persistence/);
    await rejects(yaml({ id: 'p', policies: { createPR: 'auto' } }), /createPR/);
  });

  test('service -> unknown repo is rejected', async () => {
    const error = await rejects(yaml({ id: 'p', repositories: [{ name: 'api', localPath: 'repos/api' }], services: [{ name: 'svc', repository: 'web' }] }), /Service "svc" maps to unknown repository "web"/);
    assert.match(error.message, /inconsistent mappings/);
  });

  test('repo -> unknown schema and service -> unknown schema are rejected', async () => {
    await rejects(yaml({ id: 'p', database: { engine: 'db2', schemas: ['APP'] }, repositories: [{ name: 'api', localPath: 'repos/api', schemas: ['BILLING'] }] }), /Repository "api" references schema "BILLING"/);
    await rejects(yaml({ id: 'p', database: { engine: 'db2', schemas: ['APP'] }, repositories: [{ name: 'api', localPath: 'repos/api' }], services: [{ name: 'svc', repository: 'api', schemas: ['OTHER'] }] }), /Service "svc" references schema "OTHER"/);
    await rejects(yaml({ id: 'p', repositories: [{ name: 'api', localPath: 'repos/api', schemas: ['APP'] }] }), /not in database\.schemas/);
  });

  test('schema references are matched case-insensitively', () => {
    assert.doesNotThrow(() => parseManifest(yaml({ id: 'p', database: { engine: 'db2', schemas: ['App'] }, repositories: [{ name: 'api', localPath: 'repos/api', schemas: ['APP'] }] })));
  });

  test('path traversal in localPath is rejected', async () => {
    for (const localPath of ['../outside', '..', 'repos/../../outside', path.resolve('abs', 'repo'), 'a/../..']) {
      await rejects(yaml({ id: 'p', repositories: [{ name: 'api', localPath }] }), /localPath must stay inside the project folder/);
    }
  });

  test('path traversal in guidelines is rejected', async () => {
    for (const guideline of ['../other-project/guidelines/architecture.md', 'guidelines/../../x.md', path.resolve('abs', 'x.md')]) {
      await rejects(yaml({ id: 'p', guidelines: [guideline] }), /must stay inside the project folder/);
    }
  });

  test('Windows-style traversal and drive paths are rejected on Windows', { skip: process.platform !== 'win32' && 'Windows path semantics only' }, async () => {
    await rejects(yaml({ id: 'p', repositories: [{ name: 'api', localPath: '..\\outside' }] }), /localPath/);
    await rejects(yaml({ id: 'p', repositories: [{ name: 'api', localPath: 'C:\\repos\\api' }] }), /localPath/);
    await rejects(yaml({ id: 'p', guidelines: ['..\\x.md'] }), /Guideline/);
  });

  test('duplicate repository names are rejected', async () => {
    await rejects(yaml({ id: 'p', repositories: [{ name: 'api', localPath: 'a' }, { name: 'api', localPath: 'b' }] }), /Duplicate repository name "api"/);
  });

  test('an invalid release-branch pattern is rejected', async () => {
    await rejects(yaml({ id: 'p', agility: { releaseBranchPattern: 'Release: ((' } }), /not a valid regular expression/);
  });

  test('ids, env names and secret names must be well formed', async () => {
    await rejects('id: "../evil"\n');
    await rejects('id: ""\n');
    await rejects('name: no id\n', /required property 'id'/);
    await rejects(yaml({ id: 'p', agility: { baseUrlEnv: 'https://agility.example.com' } }), /baseUrlEnv/);
    await rejects(yaml({ id: 'p', agility: { tokenSecret: 'has space' } }), /tokenSecret/);
    await rejects(yaml({ id: 'p', repositories: [{ name: '../x', localPath: 'r' }] }), /name/);
  });

  test('test commands must be argument arrays, not shell strings', async () => {
    await rejects(yaml({ id: 'p', repositories: [{ name: 'api', localPath: 'r', tests: { unit: ['mvn test'] } }] }), /unit/);
    await rejects(yaml({ id: 'p', repositories: [{ name: 'api', localPath: 'r', tests: { deploy: [['x']] } }] }), /additional properties/);
    assert.doesNotThrow(() => parseManifest(yaml({ id: 'p', repositories: [{ name: 'api', localPath: 'r', tests: { unit: [['mvn', 'test']] } }] })));
  });

  test('invalid YAML and non-mapping documents are CONFIG_INVALID', async () => {
    await expectCode(() => parseManifest('id: p\n  bad: [unclosed\n'), 'CONFIG_INVALID', /not valid YAML/);
    await expectCode(() => parseManifest('- a\n- b\n'), 'CONFIG_INVALID', /must be a YAML mapping/);
    await expectCode(() => parseManifest(''), 'CONFIG_INVALID', /must be a YAML mapping/);
    await expectCode(() => parseManifest('just a string'), 'CONFIG_INVALID');
  });

  test('a manifest whose id differs from its folder is rejected', async () => {
    await expectCode(() => parseManifest('id: billing\n', { expectedId: 'orders' }), 'CONFIG_INVALID', /declares id "billing"/);
  });
});

describe('loadManifest and env helpers', () => {
  /** @type {ReturnType<typeof tempWorkspace>} */
  let ws;
  before(() => {
    ws = tempWorkspace();
    writeProject(ws.workspace, fullManifest());
    writeProject(ws.workspace, { id: 'imposter' });
    fs.writeFileSync(path.join(ws.workspace.projectsDir, 'imposter', 'project.yaml'), 'id: orders\n');
  });
  after(() => ws.cleanup());

  test('loads projects/<id>/project.yaml and returns its folder', () => {
    const { manifest, missing, dir } = loadManifest(ws.workspace, 'orders');
    assert.equal(manifest.id, 'orders');
    assert.deepEqual(missing, []);
    assert.equal(dir, path.join(ws.workspace.projectsDir, 'orders'));
  });

  test('an unknown project is PROJECT_NOT_FOUND with a fix hint', async () => {
    const error = await expectCode(() => loadManifest(ws.workspace, 'nope'), 'PROJECT_NOT_FOUND');
    assert.match(error.details.howToFix, /onboard-project/);
  });

  test('a manifest copied into another project folder is refused', async () => {
    await expectCode(() => loadManifest(ws.workspace, 'imposter'), 'CONFIG_INVALID', /lives in the folder for "imposter"/);
  });

  test('a hostile project id never reaches the file system', async () => {
    await expectCode(() => loadManifest(ws.workspace, '../orders'), 'INVALID_ARGUMENT');
  });

  test('envValue returns the trimmed value, or null when unset, blank or a placeholder name', () => {
    const env = { A: ' value ', BLANK: '   ' };
    assert.equal(envValue('A', env), 'value');
    assert.equal(envValue('BLANK', env), null);
    assert.equal(envValue('UNSET', env), null);
    assert.equal(envValue(null, env), null);
    assert.equal(envValue('TODO', { TODO: 'x' }), null);
  });

  test('requireEnvValue names exactly what is absent', async () => {
    const noField = await expectCode(() => requireEnvValue(null, 'agility.baseUrlEnv', {}), 'NOT_CONFIGURED', /agility\.baseUrlEnv is not set/);
    assert.deepEqual(noField.details, { field: 'agility.baseUrlEnv' });
    const noEnv = await expectCode(() => requireEnvValue('AGILITY_URL', 'agility.baseUrlEnv', {}), 'NOT_CONFIGURED', /AGILITY_URL/);
    assert.deepEqual(noEnv.details, { field: 'agility.baseUrlEnv', envName: 'AGILITY_URL' });
    assert.equal(requireEnvValue('AGILITY_URL', 'agility.baseUrlEnv', { AGILITY_URL: 'https://x' }), 'https://x');
  });
});
