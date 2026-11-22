/**
 * Project onboarding: turn answers into projects/<id>/project.yaml, guideline
 * templates and the knowledge folder layout.
 *
 * Onboarding may be partial. Anything not answered is written as null and
 * listed as missing; nothing is guessed. It validates what it can locally and
 * never contacts or writes to an external system.
 *
 * Two ways in:
 *   - a person answers the questions at a terminal (onboardProject), or
 *   - an agent gathers the answers from material the person points it at and
 *     proposes the project (proposeOnboarding). Nothing is created until a
 *     person has approved the exact files (applyOnboarding).
 */

import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { parseRemoteUrl } from '../adapters/bitbucket/git.js';
import { STAGES } from '../adapters/testing/runner.js';
import { Actions, consumeApproval, getApproval, requestApproval } from '../core/approvals.js';
import { appendAudit } from '../core/audit.js';
import { AutoDevError, ErrorCodes } from '../core/errors.js';
import { parseManifest } from '../core/manifest.js';
import { containsSecret } from '../core/redact.js';
import { atomicWriteFile, atomicWriteJson, ensureDir, readJson, safeId } from '../core/state-store.js';
import { projectDir, stateDirFor } from '../core/workspace.js';

/**
 * The onboarding questionnaire. `key` is the answer name; list answers are
 * comma-separated when typed interactively.
 * @type {Array<{ key: string, prompt: string, kind?: 'list' | 'boolean' | 'number', help?: string }>}
 */
export const QUESTIONS = [
  { key: 'id', prompt: 'Project id (letters, digits, dashes)' },
  { key: 'name', prompt: 'Project display name' },
  { key: 'agilityBaseUrlEnv', prompt: 'Name of the environment variable holding the Agility base URL', help: 'e.g. AGILITY_BASE_URL (the variable name, not the URL)' },
  { key: 'boardIds', prompt: 'Agility board / team room id(s) for this project', kind: 'list' },
  { key: 'teamNames', prompt: 'Agility team name(s)', kind: 'list' },
  { key: 'defectScope', prompt: 'Agility scope OID where defects are created (e.g. Scope:1234)' },
  { key: 'acceptanceCriteriaField', prompt: 'Agility attribute holding acceptance criteria (custom field name)' },
  { key: 'releaseBranchField', prompt: 'Agility attribute holding the release branch (leave empty if none)' },
  { key: 'releaseBranchPattern', prompt: 'Regex with one capture group to read the release branch from story text', help: 'e.g. Release branch:\\s*(\\S+)' },
  { key: 'bitbucketFlavor', prompt: 'Bitbucket flavor (server or cloud)' },
  { key: 'bitbucketBaseUrlEnv', prompt: 'Name of the environment variable holding the Bitbucket base URL' },
  { key: 'bitbucketProjectKey', prompt: 'Bitbucket project key (or workspace, for cloud)' },
  { key: 'bitbucketAllowedHosts', prompt: 'Approved Bitbucket host name(s) repositories may be cloned from', kind: 'list' },
  { key: 'repositories', prompt: 'Repositories as name=URL_ENV_VAR pairs', kind: 'list', help: 'e.g. service-api=SERVICE_API_REPO_URL, web-ui=WEB_UI_REPO_URL' },
  { key: 'featureBranchPattern', prompt: 'Feature branch naming pattern', help: 'tokens {storyId} and {slug}; default feature/{storyId}-{slug}' },
  { key: 'db2ConnectionProfile', prompt: 'DB2 connection profile name (leave empty if no database)' },
  { key: 'db2Schemas', prompt: 'DB2 schema(s) owned by this project', kind: 'list' },
  { key: 'services', prompt: 'Services as service=repository pairs', kind: 'list', help: 'e.g. orders-service=service-api' },
  { key: 'splunkBaseUrlEnv', prompt: 'Name of the environment variable holding the Splunk API URL' },
  { key: 'splunkProfile', prompt: 'Splunk profile name' },
  { key: 'splunkIndexes', prompt: 'Splunk index(es) this project may search', kind: 'list' },
  { key: 'splunkSourcetypes', prompt: 'Splunk sourcetype(s)', kind: 'list' },
  { key: 'dynatraceBaseUrlEnv', prompt: 'Name of the environment variable holding the Dynatrace environment URL' },
  { key: 'dynatraceProfile', prompt: 'Dynatrace profile name' },
  { key: 'dynatraceEntitySelectors', prompt: 'Dynatrace entity selector(s)', kind: 'list', help: 'e.g. type(SERVICE),tag(app:orders)  (use ; between selectors)' },
  { key: 'monitoringEnvironment', prompt: 'Environment the monitoring worker watches (e.g. nonprod)' },
  { key: 'javaVersion', prompt: 'Java version' },
  { key: 'springBootVersion', prompt: 'Spring Boot version' },
  { key: 'uiFramework', prompt: 'UI framework and version' },
  { key: 'securityRestrictions', prompt: 'Security restrictions the agents must respect', kind: 'list' },
  { key: 'requiredTests', prompt: 'Test stages required before a PR', kind: 'list', help: 'from: compile, static, unit, integration, contract, regression, e2e; default compile, unit' },
  { key: 'chromiumApproved', prompt: 'Is Chromium approved in addition to Edge? (yes/no)', kind: 'boolean' },
];

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function text(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * @param {unknown} value
 * @param {string} [separator]
 * @returns {string[]}
 */
function list(value, separator = ',') {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  const single = text(value);
  return single ? single.split(separator).map((item) => item.trim()).filter(Boolean) : [];
}

/**
 * @param {string[]} entries "left=right"
 * @param {string} label
 */
function splitPairs(entries, label) {
  return entries.map((pair) => {
    const [left, right, ...rest] = pair.split('=').map((part) => part.trim());
    if (!left || rest.length > 0) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Could not read ${label} entry "${pair}". Use name=value.`);
    return { left, right: right || null };
  });
}

/**
 * Optional structured detail per repository, for answers that do not fit a
 * typed reply: what kind of repository it is, its schemas and its test
 * commands. Only these three keys are taken; policy can never be set here.
 * @param {unknown} value
 * @returns {Record<string, { type?: string, schemas?: string[], tests?: Record<string, string[][]> }>}
 */
function repositoryDetails(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'repositoryDetails must be an object keyed by repository name.');
  }
  /** @type {Record<string, { type?: string, schemas?: string[], tests?: Record<string, string[][]> }>} */
  const out = {};
  for (const [name, raw] of Object.entries(/** @type {Record<string, any>} */ (value))) {
    safeId(name, 'repository name');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `repositoryDetails.${name} must be an object with type, schemas and tests.`);
    }
    /** @type {{ type?: string, schemas?: string[], tests?: Record<string, string[][]> }} */
    const detail = {};
    if (raw.type !== undefined && raw.type !== null) detail.type = String(raw.type);
    if (raw.schemas !== undefined) detail.schemas = list(raw.schemas).map((schema) => schema.toUpperCase());
    if (raw.tests !== undefined) {
      if (!raw.tests || typeof raw.tests !== 'object' || Array.isArray(raw.tests)) {
        throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `repositoryDetails.${name}.tests must map a stage to a list of commands.`);
      }
      detail.tests = {};
      for (const [stage, commands] of Object.entries(raw.tests)) {
        const valid =
          STAGES.includes(stage) &&
          Array.isArray(commands) &&
          commands.length > 0 &&
          commands.every((command) => Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === 'string' && part.length > 0));
        if (!valid) {
          throw new AutoDevError(
            ErrorCodes.INVALID_ARGUMENT,
            `repositoryDetails.${name}.tests.${stage}: each stage (${STAGES.join(', ')}) takes a list of commands, each an array of arguments, e.g. [["mvnw.cmd", "-B", "test"]].`,
          );
        }
        detail.tests[stage] = /** @type {string[][]} */ (commands);
      }
    }
    out[name] = detail;
  }
  return out;
}

/**
 * Build a manifest object from onboarding answers.
 * @param {Record<string, unknown>} answers
 */
export function buildManifest(answers) {
  const id = safeId(String(answers.id ?? ''), 'project id');
  for (const [key, value] of Object.entries(answers)) {
    const flat = typeof value === 'string' ? value : value !== null && typeof value === 'object' ? JSON.stringify(value) : '';
    if (flat && (containsSecret(flat) || /https?:\/\/[^/\s"]*:[^/\s"]*@/.test(flat))) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `The answer for "${key}" looks like a secret. Give the name of the environment variable or credential entry instead.`);
    }
  }
  const details = repositoryDetails(answers.repositoryDetails);
  const repositories = splitPairs(list(answers.repositories), 'repository').map(({ left, right }) => ({
    name: safeId(left, 'repository name'),
    urlEnv: right,
    localPath: `repos/${left}`,
    branchPolicy: 'story-release-branch-required',
    ...(Object.hasOwn(details, left) ? details[left] : {}),
  }));
  const unknownDetails = Object.keys(details).filter((name) => !repositories.some((repo) => repo.name === name));
  if (unknownDetails.length > 0) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `repositoryDetails names repositories that are not in "repositories": ${unknownDetails.join(', ')}.`);
  }
  const services = splitPairs(list(answers.services), 'service').map(({ left, right }) => ({ name: left, repository: right }));
  const schemas = list(answers.db2Schemas).map((schema) => schema.toUpperCase());
  const required = list(answers.requiredTests);

  /** @type {Record<string, any>} */
  const manifest = {
    id,
    name: text(answers.name),
    agility: {
      baseUrlEnv: text(answers.agilityBaseUrlEnv),
      boardIds: list(answers.boardIds),
      teamNames: list(answers.teamNames),
      defectScope: text(answers.defectScope),
      fields: { acceptanceCriteria: text(answers.acceptanceCriteriaField), releaseBranch: text(answers.releaseBranchField) },
      releaseBranchPattern: text(answers.releaseBranchPattern),
    },
    bitbucket: {
      flavor: text(answers.bitbucketFlavor),
      baseUrlEnv: text(answers.bitbucketBaseUrlEnv),
      projectKey: text(answers.bitbucketProjectKey),
      allowedHosts: list(answers.bitbucketAllowedHosts).map((host) => host.toLowerCase()),
    },
    repositories,
    services,
    database: {
      engine: text(answers.db2ConnectionProfile) || schemas.length > 0 ? 'db2' : null,
      connectionProfile: text(answers.db2ConnectionProfile),
      schemas,
      writeAccess: false,
    },
    observability: {
      splunkProfile: text(answers.splunkProfile),
      splunkBaseUrlEnv: text(answers.splunkBaseUrlEnv),
      dynatraceProfile: text(answers.dynatraceProfile),
      dynatraceBaseUrlEnv: text(answers.dynatraceBaseUrlEnv),
    },
    browser: {
      preferred: 'msedge',
      chromiumFallback: answers.chromiumApproved === true ? 'approved' : 'allowed-only-if-approved',
      allowedHosts: list(answers.browserAllowedHosts).map((host) => host.toLowerCase()),
    },
    branching: { featurePattern: text(answers.featureBranchPattern) ?? 'feature/{storyId}-{slug}' },
    tech: { java: text(answers.javaVersion), springBoot: text(answers.springBootVersion), ui: text(answers.uiFramework) },
    tests: { required: required.length > 0 ? required : ['compile', 'unit'] },
    guidelines: ['guidelines/architecture.md', 'guidelines/coding-standards.md', 'guidelines/development-workflow.md', 'guidelines/testing-standards.md'],
    securityRestrictions: list(answers.securityRestrictions),
    learning: { persistence: 'explicit-approval-only' },
    policies: {
      createPR: 'approval-required',
      createDefect: 'approval-required',
      updateTicket: 'approval-required',
      schemaChanges: 'approval-required',
      dbWrites: 'prohibited',
      productionChanges: 'prohibited',
    },
    monitoring: {
      enabled: false,
      schedule: '*/15 * * * *',
      environment: text(answers.monitoringEnvironment),
      splunk: { profile: text(answers.splunkProfile), indexes: list(answers.splunkIndexes), sourcetypes: list(answers.splunkSourcetypes), savedSearches: [] },
      dynatrace: { profile: text(answers.dynatraceProfile), entitySelectors: list(answers.dynatraceEntitySelectors, ';'), metricSelectors: [] },
      correlation: { traceIdFields: ['trace_id', 'traceId'], spanIdFields: ['span_id', 'spanId'], serviceNameFields: ['service', 'application'] },
      thresholds: { errorCount: null, errorRatePercent: null, p95LatencyMs: null },
      incidentPolicy: { dedupeWindowMinutes: 60, createTicket: 'approval-required', autoStartDevelopment: false, productionRemediation: 'prohibited' },
    },
  };
  return manifest;
}

/**
 * Local checks on what was answered. No network, no writes.
 * @param {Record<string, any>} manifest
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]} warnings
 */
export function localChecks(manifest, env) {
  /** @type {string[]} */
  const warnings = [];
  /** @param {string | null} name @param {string} what */
  const checkEnv = (name, what) => {
    if (name && !env[name]) warnings.push(`Environment variable ${name} (${what}) is not set in this shell yet.`);
  };
  checkEnv(manifest.agility.baseUrlEnv, 'Agility base URL');
  checkEnv(manifest.bitbucket.baseUrlEnv, 'Bitbucket base URL');
  checkEnv(manifest.observability.splunkBaseUrlEnv, 'Splunk URL');
  checkEnv(manifest.observability.dynatraceBaseUrlEnv, 'Dynatrace URL');
  for (const repo of manifest.repositories) {
    if (!repo.urlEnv) continue;
    const url = env[repo.urlEnv];
    if (!url) {
      warnings.push(`Environment variable ${repo.urlEnv} (URL of ${repo.name}) is not set in this shell yet.`);
      continue;
    }
    try {
      const { host, protocol } = parseRemoteUrl(url);
      if (protocol !== 'file:' && !manifest.bitbucket.allowedHosts.includes(host)) {
        warnings.push(`Repository ${repo.name} is on host "${host}", which is not in bitbucket.allowedHosts; cloning it will be refused.`);
      }
    } catch (error) {
      warnings.push(`Repository ${repo.name}: ${/** @type {Error} */ (error).message}`);
    }
  }
  return warnings;
}

/** @type {Record<string, string>} */
const GUIDELINE_TEMPLATES = {
  'architecture.md': `# Architecture

> Fill this in. The agents read it before planning or changing code. Leave a section empty rather than guessing; empty sections are reported as gaps.

## System overview
<!-- What the system does and its main components. -->

## Services and ownership
<!-- One line per service: purpose, owning team, repository. Keep in step with services: in project.yaml. -->

## Data
<!-- DB2 schemas, which service owns which tables, and rules for cross-schema access. -->

## Integration points
<!-- Upstream and downstream systems, message formats, API contracts. -->

## Constraints
<!-- Things that must not change without an architecture review. -->
`,
  'coding-standards.md': `# Coding standards

> Fill this in. Reviews are checked against it.

## Java / Spring Boot
<!-- Package layout, layering rules, exception handling, logging, configuration, dependency injection style. -->

## UI
<!-- Framework conventions, state management, accessibility requirements. -->

## Database access
<!-- Repository pattern, transaction boundaries, bind parameters only, naming. -->

## Security
<!-- Input validation, authorization checks, what must never be logged. -->

## Dependencies
<!-- How new libraries are approved; banned libraries. -->
`,
  'development-workflow.md': `# Development workflow

> Fill this in.

## Branching
<!-- Release branch naming, how a story names its release branch, feature branch naming. -->

## Commits and pull requests
<!-- Commit message format, required PR content, reviewers, merge rules. -->

## Definition of done
<!-- What must be true before a story is complete. -->

## Environments
<!-- Which environments exist and who may deploy to each. Agents never deploy. -->
`,
  'testing-standards.md': `# Testing standards

> Fill this in. Configure the matching commands under repositories[].tests in project.yaml.

## Required stages
<!-- Which of compile, static, unit, integration, contract, regression, e2e are required before a PR. -->

## Unit tests
<!-- Frameworks, naming, coverage expectations. -->

## Integration and contract tests
<!-- How they run locally, what they need (containers, test schemas). -->

## End-to-end tests
<!-- Playwright conventions, test data, environments they may target. -->

## Test data
<!-- Where test data comes from. No production data. -->
`,
};

const GUIDELINE_NAMES = Object.freeze(Object.keys(GUIDELINE_TEMPLATES));
const KNOWLEDGE_README =
  '# Approved learnings\n\nOne folder per skill, each with an `approved.md`. Files here are written only by `autodev learn apply` after a person approves the exact text. A file edited by hand is detected and ignored by the agents.\n';
const MAX_GUIDELINE_BYTES = 64 * 1024;

/**
 * Everything a new project folder will contain, as text, without writing it.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {Record<string, unknown>} answers
 * @param {{ env?: NodeJS.ProcessEnv, guidelines?: Record<string, string> }} [options]
 *   `guidelines`: drafted guideline text by file name, used in place of the template.
 */
export function renderProject(workspace, answers, options = {}) {
  const { environmentValues: _environmentValues, ...manifestAnswers } = answers;
  const draft = buildManifest(manifestAnswers);
  const yaml = [
    '# Auto Developer project manifest.',
    '# Holds names of environment variables and credential entries, never secret values.',
    '# null means "not answered yet"; run `autodev project validate` to see what is missing.',
    '',
    YAML.stringify(draft, { lineWidth: 0 }),
  ].join('\n');
  const { manifest, missing } = parseManifest(yaml, { expectedId: draft.id, source: 'generated project.yaml' });
  const dir = projectDir(workspace, draft.id);
  const manifestFile = path.join(dir, 'project.yaml');
  if (fs.existsSync(manifestFile)) {
    throw new AutoDevError(
      ErrorCodes.CONFLICT,
      `Project "${draft.id}" already exists. Edit its project.yaml directly, then run: autodev project validate --project ${draft.id}`,
      { details: { file: manifestFile } },
    );
  }
  /** @type {Record<string, string>} */
  const files = { 'project.yaml': yaml };
  for (const name of GUIDELINE_NAMES) files[`guidelines/${name}`] = options.guidelines?.[name] ?? GUIDELINE_TEMPLATES[name];
  files['knowledge/README.md'] = KNOWLEDGE_README;
  return { projectId: draft.id, dir, manifest, missing, files, warnings: localChecks(manifest, options.env ?? process.env) };
}

/**
 * @param {string} dir project folder
 * @param {Record<string, string>} files relative path -> content
 * @param {{ keepExistingGuidelines?: boolean }} [options]
 */
function writeProjectFiles(dir, files, options = {}) {
  ensureDir(dir);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, ...relative.split('/'));
    if (options.keepExistingGuidelines && relative.startsWith('guidelines/') && fs.existsSync(file)) continue;
    atomicWriteFile(file, content);
  }
  ensureDir(path.join(dir, 'repos'));
  fs.writeFileSync(path.join(dir, 'repos', '.gitkeep'), '');
}

/**
 * Write a new project folder. Refuses to replace an existing project.yaml.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {Record<string, unknown>} answers
 * @param {{ dryRun?: boolean, env?: NodeJS.ProcessEnv }} [options]
 */
export function onboardProject(workspace, answers, options = {}) {
  const rendered = renderProject(workspace, answers, { env: options.env });
  const { projectId, dir, missing, warnings } = rendered;
  const files = [...Object.keys(rendered.files), 'repos/.gitkeep'];
  if (options.dryRun) return { projectId, dryRun: true, dir, wouldWrite: files, missing, warnings, manifest: rendered.files['project.yaml'] };
  writeProjectFiles(dir, rendered.files, { keepExistingGuidelines: true });
  return { projectId, dryRun: false, dir, written: files, missing, warnings };
}

/* ----------------------------------------------------------------------------
 * Assisted onboarding: an agent proposes, a person approves
 * ------------------------------------------------------------------------- */

/**
 * Drafted guideline files from a folder. Only the four known names are read.
 * @param {string} dir
 * @returns {Record<string, string>}
 */
export function readGuidelineDrafts(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    throw new AutoDevError(ErrorCodes.NOT_FOUND, 'The guideline drafts folder was not found.');
  }
  const unknown = entries.filter((name) => name.endsWith('.md') && !GUIDELINE_NAMES.includes(name));
  if (unknown.length > 0) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Guideline drafts must be named ${GUIDELINE_NAMES.join(', ')}. Not recognised: ${unknown.join(', ')}.`);
  }
  /** @type {Record<string, string>} */
  const drafts = {};
  for (const name of GUIDELINE_NAMES) {
    if (!entries.includes(name)) continue;
    const file = path.join(dir, name);
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > MAX_GUIDELINE_BYTES) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `${name} must be a file of at most ${MAX_GUIDELINE_BYTES / 1024} KB.`);
    }
    const content = fs.readFileSync(file, 'utf8');
    if (containsSecret(content) || /https?:\/\/[^/\s"]*:[^/\s"]*@/.test(content)) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `${name} appears to contain a secret. Guidelines describe how the team works; remove the value and name where it is stored instead.`);
    }
    drafts[name] = content.endsWith('\n') ? content : `${content}\n`;
  }
  return drafts;
}

/**
 * URLs the person will need to set as environment variables. They are not
 * secrets and are not written into the project; they are shown for approval
 * and returned as commands for the person to run.
 * @param {unknown} value
 * @param {Record<string, any>} manifest
 * @returns {Array<{ name: string, value: string, usedFor: string }>}
 */
function environmentToSet(value, manifest) {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'environmentValues must be an object of VARIABLE_NAME: "https://...".');
  }
  /** @type {Map<string, string>} */
  const referenced = new Map();
  const note = (/** @type {string | null | undefined} */ name, /** @type {string} */ usedFor) => {
    if (name) referenced.set(name, usedFor);
  };
  note(manifest.agility.baseUrlEnv, 'Agility base URL');
  note(manifest.bitbucket.baseUrlEnv, 'Bitbucket base URL');
  note(manifest.observability.splunkBaseUrlEnv, 'Splunk API URL');
  note(manifest.observability.dynatraceBaseUrlEnv, 'Dynatrace environment URL');
  for (const repo of manifest.repositories) note(repo.urlEnv, `clone URL of ${repo.name}`);

  const out = [];
  for (const [name, raw] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    if (!referenced.has(name)) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `environmentValues.${name}: project.yaml does not refer to a variable of that name.`, { details: { referenced: [...referenced.keys()] } });
    }
    const url = String(raw ?? '').trim();
    const ssh = /^(ssh:\/\/|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:)/.test(url);
    let parsed = null;
    try {
      parsed = ssh ? null : new URL(url);
    } catch {
      // reported below
    }
    const acceptable = ssh ? !/\s/.test(url) : parsed !== null && parsed.protocol === 'https:' && !parsed.username && !parsed.password;
    if (!acceptable || containsSecret(url) || /['"`$\r\n]/.test(url)) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `environmentValues.${name} must be an https URL (or an ssh clone URL) with no credentials in it.`);
    }
    out.push({ name, value: url, usedFor: /** @type {string} */ (referenced.get(name)) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {string} approvalId
 */
function onboardingProposalFile(workspace, projectId, approvalId) {
  return path.join(stateDirFor(workspace, 'onboarding', projectId), 'proposals', `${safeId(approvalId, 'approval id')}.json`);
}

/**
 * Stage a new project for a person's approval. Creates nothing under projects/.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ answers: Record<string, unknown>, guidelines?: Record<string, string>, sources?: string[], env?: NodeJS.ProcessEnv, dryRun?: boolean }} input
 */
export async function proposeOnboarding(workspace, input) {
  const rendered = renderProject(workspace, input.answers, { env: input.env, guidelines: input.guidelines });
  const environment = environmentToSet(input.answers.environmentValues, rendered.manifest);
  // Check repository hosts against the URLs that were found, not only the ones already set in this shell.
  const env = { ...(input.env ?? process.env), ...Object.fromEntries(environment.map((item) => [item.name, item.value])) };
  const warnings = localChecks(rendered.manifest, env);
  const sources = (input.sources ?? []).map((source) => String(source).slice(0, 300)).slice(0, 50);
  const drafted = Object.keys(input.guidelines ?? {}).map((name) => `guidelines/${name}`);
  const setCommands = environment.map((item) => `[Environment]::SetEnvironmentVariable('${item.name}', '${item.value}', 'User')`);

  // The approval covers every file exactly as it will be written. The
  // environment values and sources are shown with it so the reviewer can see
  // where the facts came from; they are not written into the project.
  /** @type {Record<string, unknown>} */
  const payload = {
    ...rendered.files,
    'environment variables you will set yourself (not written to the project)': environment.length > 0 ? environment.map((item) => `${item.name} = ${item.value}   (${item.usedFor})`).join('\n') : '(none proposed)',
    'still missing after this (reported, not guessed)': rendered.missing.length > 0 ? rendered.missing.map((item) => `${item.field}   needed for: ${item.neededFor}`).join('\n') : '(nothing)',
    'sources the agent read': sources.length > 0 ? sources.join('\n') : '(none recorded)',
  };
  const summary = {
    projectId: rendered.projectId,
    files: [...Object.keys(rendered.files), 'repos/.gitkeep'],
    draftedGuidelines: drafted,
    templateGuidelines: GUIDELINE_NAMES.map((name) => `guidelines/${name}`).filter((file) => !drafted.includes(file)),
    missing: rendered.missing,
    warnings,
    environment,
    setEnvironmentCommands: setCommands,
  };
  if (input.dryRun) return { dryRun: true, ...summary, manifest: rendered.files['project.yaml'] };

  const approval = await requestApproval(workspace, {
    projectId: rendered.projectId,
    action: Actions.PROJECT_ONBOARD,
    summary: `Create project "${rendered.projectId}" (${rendered.manifest.repositories.length} repositories, ${drafted.length} drafted guideline files, ${rendered.missing.length} fields still missing)`,
    payload,
  });
  const file = onboardingProposalFile(workspace, rendered.projectId, approval.id);
  ensureDir(path.dirname(file));
  atomicWriteJson(file, { approvalId: approval.id, projectId: rendered.projectId, payload, files: rendered.files, stagedAt: new Date().toISOString() });
  return {
    approvalId: approval.id,
    status: approval.status,
    ...summary,
    manifest: rendered.files['project.yaml'],
    next: `A person reviews every file in their own terminal: autodev approvals review ${approval.id} --project ${rendered.projectId}. Then: autodev onboard apply --approval ${approval.id} --project ${rendered.projectId}`,
  };
}

/**
 * Create the project a person approved. Writes exactly the approved files.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ projectId: string, approvalId: string, dryRun?: boolean }} input
 */
export async function applyOnboarding(workspace, input) {
  const projectId = safeId(input.projectId, 'project id');
  const proposal = readJson(onboardingProposalFile(workspace, projectId, input.approvalId), /** @type {Record<string, any> | null} */ (null));
  if (!proposal || proposal.projectId !== projectId) throw new AutoDevError(ErrorCodes.NOT_FOUND, `No staged onboarding for approval ${input.approvalId} and project ${projectId}.`);
  const dir = projectDir(workspace, projectId);
  if (fs.existsSync(path.join(dir, 'project.yaml'))) {
    throw new AutoDevError(ErrorCodes.CONFLICT, `Project "${projectId}" was created after this proposal was staged. Nothing was changed.`);
  }
  // Only files that are part of the approved payload, byte for byte, and only inside the known layout.
  const allowed = new Set(['project.yaml', 'knowledge/README.md', ...GUIDELINE_NAMES.map((name) => `guidelines/${name}`)]);
  /** @type {Record<string, string>} */
  const files = {};
  for (const [relative, content] of Object.entries(/** @type {Record<string, string>} */ (proposal.files))) {
    if (!allowed.has(relative) || proposal.payload[relative] !== content) {
      throw new AutoDevError(ErrorCodes.INTEGRITY_VIOLATION, 'The staged onboarding does not match what was put forward for approval.');
    }
    files[relative] = content;
  }
  parseManifest(files['project.yaml'] ?? '', { expectedId: projectId, source: 'approved project.yaml' });
  if (input.dryRun) {
    return { dryRun: true, approvalStatus: getApproval(workspace, projectId, input.approvalId).status, wouldWrite: [...Object.keys(files), 'repos/.gitkeep'] };
  }
  await consumeApproval(workspace, { projectId, id: input.approvalId, action: Actions.PROJECT_ONBOARD, payload: proposal.payload });
  writeProjectFiles(dir, files);
  fs.rmSync(onboardingProposalFile(workspace, projectId, input.approvalId), { force: true });
  await appendAudit(workspace, projectId, {
    action: 'project.onboarded',
    outcome: 'success',
    details: { approvalId: input.approvalId, files: Object.keys(files) },
  });
  return {
    created: true,
    projectId,
    dir,
    written: [...Object.keys(files), 'repos/.gitkeep'],
    next: [
      'Set the environment variables listed in the proposal, then open a new terminal.',
      'Store the tokens yourself: .\\scripts\\Set-AutoDevCredential.ps1 -Name <SECRET_NAME>',
      `Check what is still missing: autodev project validate --project ${projectId}`,
      `Start a session for the project: .\\scripts\\Start-AutoDev.ps1 -Project ${projectId}`,
    ],
  };
}
