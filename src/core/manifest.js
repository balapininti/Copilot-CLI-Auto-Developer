/**
 * Loading and validating project.yaml.
 *
 * Validation has three parts: the JSON schema (shape), a secret scan (a
 * manifest names where a secret lives and never contains one), and a
 * completeness report (onboarding may be partial, so missing fields are listed
 * rather than rejected).
 */

import fs from 'node:fs';
import path from 'node:path';

import { Ajv } from 'ajv';
import YAML from 'yaml';

import { AutoDevError, ErrorCodes } from './errors.js';
import { containsSecret } from './redact.js';
import { AUTOMATION_ROOT, projectDir } from './workspace.js';

const SCHEMA_FILE = path.join(AUTOMATION_ROOT, 'schemas', 'project.schema.json');

/** @type {import('ajv').ValidateFunction | null} */
let validator = null;

function getValidator() {
  if (!validator) {
    const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false });
    validator = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')));
  }
  return validator;
}

/** Values onboarding writes for "not answered yet". */
const PLACEHOLDER = /^(todo|tbd|changeme|board_id|<.*>)$/i;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isMissing(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '' || PLACEHOLDER.test(value.trim());
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Defaults applied after validation. Every default is the restrictive choice.
 * @param {Record<string, any>} manifest
 * @returns {Record<string, any>}
 */
export function applyDefaults(manifest) {
  const m = structuredClone(manifest);
  m.agility = { browserFallback: true, boardIds: [], fields: {}, ...m.agility };
  if (!isMissing(m.agility.boardId) && !m.agility.boardIds.includes(m.agility.boardId)) {
    m.agility.boardIds = [m.agility.boardId, ...m.agility.boardIds];
  }
  m.bitbucket = { flavor: null, allowedHosts: [], ...m.bitbucket };
  m.repositories = (m.repositories ?? []).map((/** @type {Record<string, any>} */ repo) => ({
    branchPolicy: 'story-release-branch-required',
    schemas: [],
    tests: {},
    ...repo,
  }));
  m.services = m.services ?? [];
  m.database = { engine: null, schemas: [], writeAccess: false, maxRows: 200, timeoutSeconds: 30, redactColumns: [], ...m.database };
  m.observability = { ...m.observability };
  m.browser = { preferred: 'msedge', chromiumFallback: 'allowed-only-if-approved', allowedHosts: [], ...m.browser };
  m.branching = { featurePattern: 'feature/{storyId}-{slug}', protected: ['main', 'master', 'develop', 'release/*'], ...m.branching };
  m.tests = { required: ['compile', 'unit'], timeoutMinutes: 30, ...m.tests };
  m.guidelines = m.guidelines ?? [];
  m.learning = { persistence: 'explicit-approval-only' };
  m.policies = {
    createPR: 'approval-required',
    createDefect: 'approval-required',
    updateTicket: 'approval-required',
    schemaChanges: 'approval-required',
    dbWrites: 'prohibited',
    planReview: 'required',
    ...m.policies,
    productionChanges: 'prohibited',
  };
  const monitoring = m.monitoring ?? {};
  m.monitoring = {
    enabled: false,
    schedule: null,
    environment: null,
    services: [],
    ...monitoring,
    limits: { maxWindowMinutes: 60, maxEventsPerQuery: 500, minSecondsBetweenQueries: 1, ...monitoring.limits },
    splunk: { profile: null, indexes: [], sourcetypes: [], savedSearches: [], errorFilter: null, ...monitoring.splunk },
    dynatrace: { profile: null, entitySelectors: [], metricSelectors: [], ...monitoring.dynatrace },
    correlation: {
      traceIdFields: ['trace_id', 'traceId'],
      spanIdFields: ['span_id', 'spanId'],
      requestIdFields: ['request_id', 'requestId'],
      serviceNameFields: ['service', 'application'],
      windowSeconds: 300,
      ...monitoring.correlation,
    },
    thresholds: { errorCount: null, errorRatePercent: null, p95LatencyMs: null, ...monitoring.thresholds },
    incidentPolicy: {
      dedupeWindowMinutes: 60,
      createTicket: 'approval-required',
      autoStartDevelopment: false,
      ...monitoring.incidentPolicy,
      productionRemediation: 'prohibited',
    },
  };
  return m;
}

/**
 * List what onboarding still has to supply, grouped by the capability that
 * needs it. Nothing here is guessed or filled in.
 * @param {Record<string, any>} m manifest with defaults applied
 * @returns {Array<{ field: string, neededFor: string }>}
 */
export function findMissing(m) {
  /** @type {Array<{ field: string, neededFor: string }>} */
  const missing = [];
  /** @param {unknown} value @param {string} field @param {string} neededFor */
  const need = (value, field, neededFor) => {
    if (isMissing(value)) missing.push({ field, neededFor });
  };

  need(m.agility.baseUrlEnv, 'agility.baseUrlEnv', 'reading Agility stories');
  need(m.agility.boardIds, 'agility.boardId', 'mapping a board to this project');
  need(m.agility.fields.releaseBranch ?? m.agility.releaseBranchPattern, 'agility.fields.releaseBranch or agility.releaseBranchPattern', 'finding the release branch a story names');
  need(m.agility.fields.acceptanceCriteria, 'agility.fields.acceptanceCriteria', 'reading acceptance criteria');
  need(m.agility.defectScope, 'agility.defectScope', 'creating defects');
  need(m.repositories, 'repositories', 'cloning and changing code');
  need(m.bitbucket.allowedHosts, 'bitbucket.allowedHosts', 'cloning repositories');
  need(m.bitbucket.flavor, 'bitbucket.flavor', 'creating pull requests');
  need(m.bitbucket.baseUrlEnv, 'bitbucket.baseUrlEnv', 'creating pull requests');
  need(m.bitbucket.projectKey, 'bitbucket.projectKey', 'creating pull requests');
  for (const [index, repo] of m.repositories.entries()) {
    need(repo.urlEnv, `repositories[${index}].urlEnv (${repo.name})`, 'cloning this repository');
  }
  if (m.database.engine) {
    need(m.database.connectionProfile, 'database.connectionProfile', 'DB2 introspection');
    need(m.database.schemas, 'database.schemas', 'DB2 introspection');
  }
  need(m.guidelines, 'guidelines', 'loading coding and testing standards');
  need(m.services, 'services', 'mapping incidents and stories to repositories');
  for (const [index, service] of m.services.entries()) {
    need(service.repository, `services[${index}].repository (${service.name})`, 'mapping this service to code');
  }
  if (m.monitoring.enabled) {
    need(m.monitoring.environment, 'monitoring.environment', 'scoping monitoring queries');
    need(m.observability.splunkBaseUrlEnv, 'observability.splunkBaseUrlEnv', 'Splunk queries');
    need(m.monitoring.splunk.indexes, 'monitoring.splunk.indexes', 'scoping Splunk searches');
    need(m.observability.dynatraceBaseUrlEnv, 'observability.dynatraceBaseUrlEnv', 'Dynatrace queries');
    need(m.monitoring.dynatrace.entitySelectors, 'monitoring.dynatrace.entitySelectors', 'scoping Dynatrace queries');
    const thresholds = Object.values(m.monitoring.thresholds).filter((value) => value !== null);
    if (thresholds.length === 0) {
      missing.push({ field: 'monitoring.thresholds', neededFor: 'threshold-based incidents (none are set, so none will fire)' });
    }
  }
  return missing;
}

/**
 * Cross-field checks the schema cannot express.
 * @param {Record<string, any>} m
 * @returns {string[]}
 */
function semanticErrors(m) {
  const errors = [];
  const repoNames = new Set();
  for (const repo of m.repositories) {
    if (repoNames.has(repo.name)) errors.push(`Duplicate repository name "${repo.name}".`);
    repoNames.add(repo.name);
    const normalized = path.normalize(repo.localPath);
    if (path.isAbsolute(repo.localPath) || normalized.startsWith('..')) {
      errors.push(`Repository "${repo.name}" localPath must stay inside the project folder.`);
    }
  }
  const schemas = new Set(m.database.schemas.map((/** @type {string} */ s) => s.toUpperCase()));
  for (const service of m.services) {
    if (!isMissing(service.repository) && !repoNames.has(service.repository)) {
      errors.push(`Service "${service.name}" maps to unknown repository "${service.repository}".`);
    }
    for (const schema of service.schemas ?? []) {
      if (!schemas.has(schema.toUpperCase())) {
        errors.push(`Service "${service.name}" references schema "${schema}" that is not in database.schemas.`);
      }
    }
  }
  for (const repo of m.repositories) {
    for (const schema of repo.schemas) {
      if (!schemas.has(schema.toUpperCase())) {
        errors.push(`Repository "${repo.name}" references schema "${schema}" that is not in database.schemas.`);
      }
    }
  }
  for (const guideline of m.guidelines) {
    if (path.isAbsolute(guideline) || path.normalize(guideline).startsWith('..')) {
      errors.push(`Guideline path "${guideline}" must stay inside the project folder.`);
    }
  }
  if (m.agility.releaseBranchPattern) {
    try {
      new RegExp(m.agility.releaseBranchPattern);
    } catch {
      errors.push('agility.releaseBranchPattern is not a valid regular expression.');
    }
  }
  return errors;
}

/**
 * Parse and validate manifest text.
 * @param {string} text YAML source
 * @param {{ expectedId?: string, source?: string }} [options]
 * @returns {{ manifest: Record<string, any>, missing: Array<{ field: string, neededFor: string }> }}
 */
export function parseManifest(text, options = {}) {
  const source = options.source ?? 'project.yaml';
  let raw;
  try {
    raw = YAML.parse(text);
  } catch (error) {
    throw new AutoDevError(ErrorCodes.CONFIG_INVALID, `${source} is not valid YAML: ${/** @type {Error} */ (error).message}`, {
      details: { source },
    });
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AutoDevError(ErrorCodes.CONFIG_INVALID, `${source} must be a YAML mapping.`, { details: { source } });
  }
  const validate = getValidator();
  if (!validate(raw)) {
    const problems = (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message}`);
    throw new AutoDevError(ErrorCodes.CONFIG_INVALID, `${source} does not match the manifest schema.`, {
      details: { source, problems },
    });
  }
  // Checked after the shape, so an unknown field is reported as exactly that.
  if (containsSecret(text)) {
    throw new AutoDevError(
      ErrorCodes.CONFIG_INVALID,
      `${source} appears to contain a secret. Manifests hold the names of environment variables or credential entries, never their values.`,
      { details: { source } },
    );
  }
  const manifest = applyDefaults(raw);
  if (options.expectedId && manifest.id !== options.expectedId) {
    throw new AutoDevError(
      ErrorCodes.CONFIG_INVALID,
      `${source} declares id "${manifest.id}" but lives in the folder for "${options.expectedId}".`,
      { details: { source } },
    );
  }
  const problems = semanticErrors(manifest);
  if (problems.length > 0) {
    throw new AutoDevError(ErrorCodes.CONFIG_INVALID, `${source} has inconsistent mappings.`, { details: { source, problems } });
  }
  return { manifest, missing: findMissing(manifest) };
}

/**
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} projectId
 * @returns {{ manifest: Record<string, any>, missing: Array<{ field: string, neededFor: string }>, dir: string }}
 */
export function loadManifest(workspace, projectId) {
  const dir = projectDir(workspace, projectId);
  const file = path.join(dir, 'project.yaml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      throw new AutoDevError(
        ErrorCodes.PROJECT_NOT_FOUND,
        `Project "${projectId}" is not onboarded: no project.yaml under the workspace projects folder.`,
        { details: { projectId, howToFix: 'Run: autodev onboard-project' } },
      );
    }
    throw error;
  }
  return { ...parseManifest(text, { expectedId: projectId, source: `projects/${projectId}/project.yaml` }), dir };
}

/**
 * Read a value named by an `...Env` manifest field. Returns null when the
 * field or the variable is unset; callers report that as NOT_CONFIGURED.
 * @param {string | null | undefined} envName
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function envValue(envName, env = process.env) {
  if (isMissing(envName)) return null;
  const value = env[/** @type {string} */ (envName)];
  return value && value.trim() !== '' ? value.trim() : null;
}

/**
 * Like envValue, but throws NOT_CONFIGURED naming exactly what is absent.
 * @param {string | null | undefined} envName
 * @param {string} field manifest field, for the message
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function requireEnvValue(envName, field, env = process.env) {
  if (isMissing(envName)) {
    throw new AutoDevError(ErrorCodes.NOT_CONFIGURED, `Manifest field ${field} is not set.`, { details: { field } });
  }
  const value = envValue(envName, env);
  if (!value) {
    throw new AutoDevError(ErrorCodes.NOT_CONFIGURED, `Environment variable ${envName} (from ${field}) is not set.`, {
      details: { field, envName },
    });
  }
  return value;
}
