/**
 * Project onboarding: turn answers into projects/<id>/project.yaml, guideline
 * templates and the knowledge folder layout.
 *
 * Onboarding may be partial. Anything not answered is written as null and
 * listed as missing; nothing is guessed. It validates what it can locally and
 * never contacts or writes to an external system.
 */

import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { parseRemoteUrl } from '../adapters/bitbucket/git.js';
import { AutoDevError, ErrorCodes } from '../core/errors.js';
import { parseManifest } from '../core/manifest.js';
import { containsSecret } from '../core/redact.js';
import { atomicWriteFile, ensureDir, safeId } from '../core/state-store.js';
import { projectDir } from '../core/workspace.js';

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
 * Build a manifest object from onboarding answers.
 * @param {Record<string, unknown>} answers
 */
export function buildManifest(answers) {
  const id = safeId(String(answers.id ?? ''), 'project id');
  for (const [key, value] of Object.entries(answers)) {
    if (typeof value === 'string' && (containsSecret(value) || /^https?:\/\/[^/\s]*:[^/\s]*@/.test(value))) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `The answer for "${key}" looks like a secret. Give the name of the environment variable or credential entry instead.`);
    }
  }
  const repositories = splitPairs(list(answers.repositories), 'repository').map(({ left, right }) => ({
    name: safeId(left, 'repository name'),
    urlEnv: right,
    localPath: `repos/${left}`,
    branchPolicy: 'story-release-branch-required',
  }));
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
    browser: { preferred: 'msedge', chromiumFallback: answers.chromiumApproved === true ? 'approved' : 'allowed-only-if-approved' },
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

/**
 * Write a new project folder. Refuses to replace an existing project.yaml.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {Record<string, unknown>} answers
 * @param {{ dryRun?: boolean, env?: NodeJS.ProcessEnv }} [options]
 */
export function onboardProject(workspace, answers, options = {}) {
  const draft = buildManifest(answers);
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

  const files = [
    'project.yaml',
    ...Object.keys(GUIDELINE_TEMPLATES).map((name) => `guidelines/${name}`),
    'knowledge/README.md',
    'repos/.gitkeep',
  ];
  const warnings = localChecks(manifest, options.env ?? process.env);
  if (options.dryRun) return { projectId: draft.id, dryRun: true, dir, wouldWrite: files, missing, warnings, manifest: yaml };

  ensureDir(dir);
  atomicWriteFile(manifestFile, yaml);
  for (const [name, content] of Object.entries(GUIDELINE_TEMPLATES)) {
    const file = path.join(dir, 'guidelines', name);
    if (!fs.existsSync(file)) atomicWriteFile(file, content);
  }
  atomicWriteFile(
    path.join(dir, 'knowledge', 'README.md'),
    '# Approved learnings\n\nOne folder per skill, each with an `approved.md`. Files here are written only by `autodev learn apply` after a person approves the exact text. A file edited by hand is detected and ignored by the agents.\n',
  );
  ensureDir(path.join(dir, 'repos'));
  fs.writeFileSync(path.join(dir, 'repos', '.gitkeep'), '');
  return { projectId: draft.id, dryRun: false, dir, written: files, missing, warnings };
}
