import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import YAML from 'yaml';

import { decideApproval, getApproval, listApprovals } from '../../src/core/approvals.js';
import { readAudit } from '../../src/core/audit.js';
import { shellDenyReason } from '../../src/core/hook-policy.js';
import { loadManifest } from '../../src/core/manifest.js';
import { applyOnboarding, buildManifest, proposeOnboarding, readGuidelineDrafts } from '../../src/workflow/onboarding.js';
import { classifyUrl, sanitizeRemote, scanSources } from '../../src/workflow/onboarding-scan.js';
import { expectCode, git, setGitEnv, tempWorkspace } from '../helpers.js';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

const answers = () => ({
  id: 'orders',
  name: 'Orders platform',
  agilityBaseUrlEnv: 'AGILITY_BASE_URL',
  boardIds: '501',
  releaseBranchPattern: 'Release branch:\\s*(\\S+)',
  bitbucketFlavor: 'server',
  bitbucketBaseUrlEnv: 'BITBUCKET_BASE_URL',
  bitbucketProjectKey: 'ORD',
  bitbucketAllowedHosts: 'bitbucket.example.internal',
  repositories: 'service-api=SERVICE_API_REPO_URL, web-ui=WEB_UI_REPO_URL',
  repositoryDetails: {
    'service-api': { type: 'java-spring', schemas: ['app'], tests: { compile: [['mvnw.cmd', '-B', '-q', '-DskipTests', 'compile']], unit: [['mvnw.cmd', '-B', 'test']] } },
    'web-ui': { type: 'ui', tests: { unit: [['npm.cmd', 'test']] } },
  },
  browserAllowedHosts: 'orders-dev.example.internal',
  services: 'orders-service=service-api',
  db2Schemas: 'APP',
  environmentValues: {
    AGILITY_BASE_URL: 'https://agility.example.internal/Instance',
    SERVICE_API_REPO_URL: 'https://bitbucket.example.internal/scm/ord/service-api.git',
    WEB_UI_REPO_URL: 'https://git.elsewhere.example/ord/web-ui.git',
  },
});

describe('onboarding answers: structured details', () => {
  test('repositoryDetails supplies type, schemas and test commands, and nothing else', () => {
    const manifest = buildManifest({ ...answers(), repositoryDetails: { 'service-api': { type: 'java-spring', schemas: 'app, common', tests: { unit: [['mvnw.cmd', 'test']] }, branchPolicy: 'default-release-branch-allowed', policies: { createPR: 'allowed' } } } });
    const repo = manifest.repositories[0];
    assert.deepEqual(repo, { name: 'service-api', urlEnv: 'SERVICE_API_REPO_URL', localPath: 'repos/service-api', branchPolicy: 'story-release-branch-required', type: 'java-spring', schemas: ['APP', 'COMMON'], tests: { unit: [['mvnw.cmd', 'test']] } });
    assert.equal(manifest.policies.createPR, 'approval-required');
    assert.deepEqual(manifest.browser.allowedHosts, ['orders-dev.example.internal']);
  });

  test('malformed details are refused', async () => {
    const withDetails = (/** @type {unknown} */ repositoryDetails) => ({ ...answers(), repositoryDetails });
    await expectCode(() => buildManifest(withDetails([])), 'INVALID_ARGUMENT');
    await expectCode(() => buildManifest(withDetails({ 'not-a-repo': { type: 'ui' } })), 'INVALID_ARGUMENT', /not in "repositories"/);
    await expectCode(() => buildManifest(withDetails({ 'web-ui': { tests: { unit: 'npm test' } } })), 'INVALID_ARGUMENT', /array of arguments/);
    await expectCode(() => buildManifest(withDetails({ 'web-ui': { tests: { smoke: [['npm', 'test']] } } })), 'INVALID_ARGUMENT');
    await expectCode(() => buildManifest(withDetails({ 'web-ui': { tests: { unit: [[]] } } })), 'INVALID_ARGUMENT');
  });

  test('a secret anywhere in the answers is refused, including nested ones', async () => {
    await expectCode(() => buildManifest({ ...answers(), name: `Orders ${TOKEN}` }), 'INVALID_ARGUMENT', /looks like a secret/);
    await expectCode(() => buildManifest({ ...answers(), repositoryDetails: { 'web-ui': { tests: { unit: [['npm.cmd', 'test', `--token=${TOKEN}`]] } } } }), 'INVALID_ARGUMENT', /looks like a secret/);
    await expectCode(() => buildManifest({ ...answers(), securityRestrictions: ['see https://alice:hunter2pass@wiki.example.internal/x'] }), 'INVALID_ARGUMENT');
  });
});

describe('assisted onboarding', () => {
  /** @type {ReturnType<typeof tempWorkspace>} */
  let ws;
  beforeEach(() => {
    ws = tempWorkspace();
  });
  afterEach(() => ws.cleanup());

  const projectDir = () => path.join(ws.workspace.projectsDir, 'orders');
  const approve = (/** @type {string} */ id) => decideApproval(ws.workspace, { projectId: 'orders', id, decision: 'approved', decidedBy: 'tester' });
  const propose = (/** @type {Record<string, any>} */ extra = {}) =>
    /** @type {Promise<any>} */ (proposeOnboarding(ws.workspace, { answers: answers(), env: {}, sources: ['C:\\old\\skill.md'], ...extra }));

  test('propose creates nothing under projects and returns what a person needs to decide', async () => {
    const proposal = await propose();
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.projectId, 'orders');
    assert.equal(fs.existsSync(ws.workspace.projectsDir) && fs.existsSync(projectDir()), false);
    assert.deepEqual(proposal.files, ['project.yaml', 'guidelines/architecture.md', 'guidelines/coding-standards.md', 'guidelines/development-workflow.md', 'guidelines/testing-standards.md', 'knowledge/README.md', 'repos/.gitkeep']);
    assert.deepEqual(proposal.draftedGuidelines, []);
    assert.equal(proposal.templateGuidelines.length, 4);
    assert.ok(proposal.missing.some((/** @type {any} */ item) => item.field.includes('acceptanceCriteria')));
    assert.deepEqual(proposal.setEnvironmentCommands, [
      "[Environment]::SetEnvironmentVariable('AGILITY_BASE_URL', 'https://agility.example.internal/Instance', 'User')",
      "[Environment]::SetEnvironmentVariable('SERVICE_API_REPO_URL', 'https://bitbucket.example.internal/scm/ord/service-api.git', 'User')",
      "[Environment]::SetEnvironmentVariable('WEB_UI_REPO_URL', 'https://git.elsewhere.example/ord/web-ui.git', 'User')",
    ]);
    // Hosts are checked against the URLs that were found, not only what is set in the shell.
    assert.ok(proposal.warnings.some((/** @type {string} */ warning) => /web-ui is on host "git\.elsewhere\.example"/.test(warning)));
    assert.equal(proposal.warnings.some((/** @type {string} */ warning) => /SERVICE_API_REPO_URL/.test(warning)), false);
    assert.ok(proposal.warnings.some((/** @type {string} */ warning) => /BITBUCKET_BASE_URL/.test(warning)));
  });

  test('the approval shows every file, the URLs, what is missing and the sources', async () => {
    const proposal = await propose();
    const approval = getApproval(ws.workspace, 'orders', proposal.approvalId);
    assert.equal(approval.action, 'project.onboard');
    assert.match(approval.summary, /Create project "orders" \(2 repositories, 0 drafted guideline files, \d+ fields still missing\)/);
    const preview = /** @type {Record<string, string>} */ (approval.preview);
    assert.match(preview['project.yaml'], /createPR: approval-required/);
    assert.match(preview['project.yaml'], /- mvnw\.cmd/);
    assert.match(preview['guidelines/architecture.md'], /# Architecture/);
    assert.match(preview['environment variables you will set yourself (not written to the project)'], /AGILITY_BASE_URL = https:\/\/agility\.example\.internal\/Instance/);
    assert.match(preview['still missing after this (reported, not guessed)'], /needed for/);
    assert.match(preview['sources the agent read'], /skill\.md/);
  });

  test('apply needs the approval, then writes exactly the approved files', async () => {
    const proposal = await propose();
    await expectCode(() => applyOnboarding(ws.workspace, { projectId: 'orders', approvalId: proposal.approvalId }), 'APPROVAL_REQUIRED');
    assert.equal(fs.existsSync(projectDir()), false);
    await approve(proposal.approvalId);
    const dry = /** @type {any} */ (await applyOnboarding(ws.workspace, { projectId: 'orders', approvalId: proposal.approvalId, dryRun: true }));
    assert.equal(dry.dryRun, true);
    assert.equal(fs.existsSync(projectDir()), false);

    const applied = /** @type {any} */ (await applyOnboarding(ws.workspace, { projectId: 'orders', approvalId: proposal.approvalId }));
    assert.equal(applied.created, true);
    assert.equal(fs.readFileSync(path.join(projectDir(), 'project.yaml'), 'utf8'), proposal.manifest);
    assert.ok(fs.existsSync(path.join(projectDir(), 'repos', '.gitkeep')));
    assert.ok(fs.existsSync(path.join(projectDir(), 'knowledge', 'README.md')));
    const { manifest } = loadManifest(ws.workspace, 'orders');
    assert.deepEqual(manifest.repositories[0].tests.unit, [['mvnw.cmd', '-B', 'test']]);
    assert.equal(manifest.policies.dbWrites, 'prohibited');
    // URLs are for the person to set; they are not in the project.
    assert.equal(fs.readFileSync(path.join(projectDir(), 'project.yaml'), 'utf8').includes('agility.example.internal'), false);
    assert.equal(readAudit(ws.workspace, 'orders').some((item) => item.action === 'project.onboarded'), true);
    await expectCode(() => applyOnboarding(ws.workspace, { projectId: 'orders', approvalId: proposal.approvalId }), 'NOT_FOUND');
  });

  test('a denied proposal creates nothing', async () => {
    const proposal = await propose();
    await decideApproval(ws.workspace, { projectId: 'orders', id: proposal.approvalId, decision: 'denied', decidedBy: 'tester' });
    await expectCode(() => applyOnboarding(ws.workspace, { projectId: 'orders', approvalId: proposal.approvalId }), 'APPROVAL_DENIED');
    assert.equal(fs.existsSync(projectDir()), false);
  });

  test('staged files altered after approval are refused', async () => {
    const proposal = await propose();
    await approve(proposal.approvalId);
    const staged = path.join(ws.workspace.stateDir, 'onboarding', 'orders', 'proposals', `${proposal.approvalId}.json`);
    const original = fs.readFileSync(staged, 'utf8');

    const onlyFiles = JSON.parse(original);
    onlyFiles.files['project.yaml'] = onlyFiles.files['project.yaml'].replace('createPR: approval-required', 'createPR: allowed');
    fs.writeFileSync(staged, JSON.stringify(onlyFiles));
    await expectCode(() => applyOnboarding(ws.workspace, { projectId: 'orders', approvalId: proposal.approvalId }), 'INTEGRITY_VIOLATION');

    const both = JSON.parse(original);
    both.files['project.yaml'] = both.files['project.yaml'].replace('createPR: approval-required', 'createPR: allowed');
    both.payload['project.yaml'] = both.files['project.yaml'];
    fs.writeFileSync(staged, JSON.stringify(both));
    await expectCode(() => applyOnboarding(ws.workspace, { projectId: 'orders', approvalId: proposal.approvalId }), 'APPROVAL_MISMATCH');

    const extra = JSON.parse(original);
    extra.files['../../outside.txt'] = 'x';
    extra.payload['../../outside.txt'] = 'x';
    fs.writeFileSync(staged, JSON.stringify(extra));
    await expectCode(() => applyOnboarding(ws.workspace, { projectId: 'orders', approvalId: proposal.approvalId }), 'INTEGRITY_VIOLATION');
    assert.equal(fs.existsSync(projectDir()), false);
  });

  test('an existing project is never replaced', async () => {
    const proposal = await propose();
    await approve(proposal.approvalId);
    await applyOnboarding(ws.workspace, { projectId: 'orders', approvalId: proposal.approvalId });
    await expectCode(() => propose(), 'CONFLICT', /already exists/);
  });

  test('a project created in the meantime is not overwritten by an older approval', async () => {
    const proposal = await propose();
    await approve(proposal.approvalId);
    fs.mkdirSync(projectDir(), { recursive: true });
    fs.writeFileSync(path.join(projectDir(), 'project.yaml'), 'id: orders\n');
    await expectCode(() => applyOnboarding(ws.workspace, { projectId: 'orders', approvalId: proposal.approvalId }), 'CONFLICT');
    assert.equal(fs.readFileSync(path.join(projectDir(), 'project.yaml'), 'utf8'), 'id: orders\n');
  });

  test('drafted guidelines are part of what is approved and written', async () => {
    const drafts = path.join(ws.root, 'drafts');
    fs.mkdirSync(drafts);
    fs.writeFileSync(path.join(drafts, 'architecture.md'), '# Architecture\n\nControllers never call repositories directly.');
    const guidelines = readGuidelineDrafts(drafts);
    assert.deepEqual(Object.keys(guidelines), ['architecture.md']);
    const proposal = await propose({ guidelines });
    assert.deepEqual(proposal.draftedGuidelines, ['guidelines/architecture.md']);
    assert.equal(proposal.templateGuidelines.length, 3);
    const preview = /** @type {Record<string, string>} */ (getApproval(ws.workspace, 'orders', proposal.approvalId).preview);
    assert.match(preview['guidelines/architecture.md'], /Controllers never call repositories directly/);
    await approve(proposal.approvalId);
    await applyOnboarding(ws.workspace, { projectId: 'orders', approvalId: proposal.approvalId });
    assert.equal(fs.readFileSync(path.join(projectDir(), 'guidelines', 'architecture.md'), 'utf8'), '# Architecture\n\nControllers never call repositories directly.\n');
    assert.match(fs.readFileSync(path.join(projectDir(), 'guidelines', 'coding-standards.md'), 'utf8'), /Fill this in/);
  });

  test('guideline drafts with a secret, an unknown name or excessive size are refused', async () => {
    const drafts = path.join(ws.root, 'drafts');
    fs.mkdirSync(drafts);
    fs.writeFileSync(path.join(drafts, 'architecture.md'), `Use token ${TOKEN} for the build.`);
    await expectCode(() => readGuidelineDrafts(drafts), 'INVALID_ARGUMENT', /appears to contain a secret/);
    fs.writeFileSync(path.join(drafts, 'architecture.md'), 'x'.repeat(70 * 1024));
    await expectCode(() => readGuidelineDrafts(drafts), 'INVALID_ARGUMENT', /at most 64 KB/);
    fs.writeFileSync(path.join(drafts, 'architecture.md'), '# ok\n');
    fs.writeFileSync(path.join(drafts, 'policies.md'), '# not a guideline\n');
    await expectCode(() => readGuidelineDrafts(drafts), 'INVALID_ARGUMENT', /Not recognised: policies\.md/);
    await expectCode(() => readGuidelineDrafts(path.join(ws.root, 'nope')), 'NOT_FOUND');
  });

  test('environment values must be clean URLs for variables the project names', async () => {
    const withEnv = (/** @type {Record<string, string>} */ environmentValues) => proposeOnboarding(ws.workspace, { answers: { ...answers(), environmentValues }, env: {} });
    await expectCode(() => withEnv({ UNRELATED_URL: 'https://x.example.internal' }), 'INVALID_ARGUMENT', /does not refer to a variable/);
    await expectCode(() => withEnv({ AGILITY_BASE_URL: 'http://agility.example.internal' }), 'INVALID_ARGUMENT');
    await expectCode(() => withEnv({ AGILITY_BASE_URL: "https://agility.example.internal/'); calc; ('" }), 'INVALID_ARGUMENT');
    await expectCode(() => withEnv({ AGILITY_BASE_URL: 'https://agility.example.internal/$(whoami)' }), 'INVALID_ARGUMENT');
    await expectCode(() => withEnv({ SERVICE_API_REPO_URL: 'https://alice:hunter2pass@bitbucket.example.internal/scm/ord/a.git' }), 'INVALID_ARGUMENT');
    const ssh = /** @type {any} */ (await withEnv({ SERVICE_API_REPO_URL: 'git@bitbucket.example.internal:ord/service-api.git' }));
    assert.equal(ssh.environment[0].value, 'git@bitbucket.example.internal:ord/service-api.git');
    assert.equal(listApprovals(ws.workspace, 'orders').length, 1);
  });

  test('a dry-run proposal stages nothing', async () => {
    const proposal = await propose({ dryRun: true });
    assert.equal(proposal.dryRun, true);
    assert.match(proposal.manifest, /id: orders/);
    assert.equal(fs.existsSync(ws.workspace.stateDir), false);
  });

  test('the generated manifest is valid YAML with restrictive policies whatever the answers say', async () => {
    const proposal = await propose({ answers: { ...answers(), policies: { createPR: 'allowed' }, monitoring: { enabled: true } } });
    const manifest = YAML.parse(proposal.manifest);
    assert.equal(manifest.policies.createPR, 'approval-required');
    assert.equal(manifest.monitoring.enabled, false);
  });

  test('the hook sends an agent to "onboard propose" and still allows a dry run', () => {
    assert.match(String(shellDenyReason('node scripts/autodev.mjs onboard-project --answers a.json')), /onboard propose/);
    assert.equal(shellDenyReason('node scripts/autodev.mjs onboard-project --answers a.json --dry-run'), null);
    assert.equal(shellDenyReason('node scripts/autodev.mjs onboard propose --answers a.json'), null);
    assert.equal(shellDenyReason('node scripts/autodev.mjs onboard scan --path C:\\old'), null);
  });
});

describe('onboarding scan', () => {
  /** @type {ReturnType<typeof tempWorkspace>} */
  let ws;
  /** @type {() => void} */
  let restoreGit;
  beforeEach(() => {
    ws = tempWorkspace();
    restoreGit = setGitEnv(ws.root);
  });
  afterEach(() => {
    restoreGit();
    ws.cleanup();
  });

  test('sanitizeRemote removes credentials and queries and keeps ssh forms', () => {
    assert.deepEqual(sanitizeRemote(`https://alice:${TOKEN}@bitbucket.example.internal/scm/ord/api.git?x=1`), { url: 'https://bitbucket.example.internal/scm/ord/api.git', host: 'bitbucket.example.internal', credentialsRemoved: true });
    assert.deepEqual(sanitizeRemote('https://bitbucket.example.internal/scm/ord/api.git'), { url: 'https://bitbucket.example.internal/scm/ord/api.git', host: 'bitbucket.example.internal', credentialsRemoved: false });
    assert.deepEqual(sanitizeRemote('git@bitbucket.example.internal:ord/api.git'), { url: 'git@bitbucket.example.internal:ord/api.git', host: 'bitbucket.example.internal', credentialsRemoved: false });
    assert.equal(sanitizeRemote('ssh://git@bitbucket.example.internal:7999/ord/api.git').credentialsRemoved, false);
    assert.equal(sanitizeRemote('file:///tmp/x.git').url, null);
    assert.equal(sanitizeRemote('').url, null);
    assert.equal(sanitizeRemote('not a url').url, null);
  });

  test('classifyUrl gives a hint, not a verdict', () => {
    assert.equal(classifyUrl('bitbucket.example.internal', '/scm/ord/a.git'), 'bitbucket');
    assert.equal(classifyUrl('code.example.internal', '/scm/ord/a.git'), 'bitbucket');
    assert.equal(classifyUrl('www7.v1host.com', '/Acme/rest-1.v1/Data/Story'), 'agility');
    assert.equal(classifyUrl('splunk.example.internal', '/'), 'splunk');
    assert.equal(classifyUrl('abc123.live.dynatrace.com', '/'), 'dynatrace');
    assert.equal(classifyUrl('login.example.internal', '/'), 'identity-provider');
    assert.equal(classifyUrl('wiki.example.internal', '/x'), 'unknown');
  });

  test('finds clones, their remotes and build commands, and hosts mentioned in documents', async () => {
    const root = path.join(ws.root, 'existing');
    const api = path.join(root, 'work', 'service-api');
    const ui = path.join(root, 'work', 'web-ui');
    fs.mkdirSync(api, { recursive: true });
    fs.mkdirSync(ui, { recursive: true });
    fs.writeFileSync(path.join(api, 'pom.xml'), '<project><parent><artifactId>spring-boot-starter-parent</artifactId><version>3.3.1</version></parent><properties><java.version>21</java.version></properties></project>');
    fs.writeFileSync(path.join(api, 'mvnw.cmd'), '');
    fs.writeFileSync(path.join(ui, 'package.json'), JSON.stringify({ scripts: { build: 'vite build', test: 'vitest run', lint: 'eslint .' } }));
    fs.mkdirSync(path.join(ui, 'node_modules', 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(ui, 'node_modules', 'left-pad', 'README.md'), 'https://registry.vendor.example/left-pad');
    for (const [dir, remote] of /** @type {Array<[string, string]>} */ ([[api, `https://alice:${TOKEN}@bitbucket.example.internal/scm/ord/Service-API.git`], [ui, 'git@bitbucket.example.internal:ord/web-ui.git']])) {
      await git(['init', '--quiet'], dir);
      await git(['remote', 'add', 'origin', remote], dir);
    }
    fs.mkdirSync(path.join(root, 'old-skill'));
    fs.writeFileSync(path.join(root, 'old-skill', 'SKILL.md'), [
      'Stories live at https://agility.example.internal/Instance/TeamRoom.mvc/Show/501 .',
      'Logs: https://splunk.example.internal:8089/services/search/jobs',
      `Do not copy: https://bob:${TOKEN}@wiki.example.internal/secret?token=${TOKEN}`,
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'old-skill', '.env'), `AGILITY_TOKEN=${TOKEN}\nURL=https://hidden.example.internal/`);

    const result = await scanSources([root, path.join(ws.root, 'does-not-exist')]);
    assert.equal(JSON.stringify(result).includes(TOKEN), false, 'no credential leaves the scan');
    assert.equal(JSON.stringify(result).includes('hunter'), false);
    assert.deepEqual(result.notFound, [path.join(ws.root, 'does-not-exist')]);

    const byName = Object.fromEntries(result.repositories.map((repo) => [repo.name, repo]));
    assert.deepEqual(Object.keys(byName).sort(), ['service-api', 'web-ui']);
    assert.equal(byName['service-api'].remote, 'https://bitbucket.example.internal/scm/ord/Service-API.git');
    assert.equal(byName['service-api'].credentialsRemovedFromRemote, true);
    assert.equal(byName['service-api'].buildTool, 'maven');
    assert.equal(byName['service-api'].javaVersion, '21');
    assert.equal(byName['service-api'].springBootVersion, '3.3.1');
    assert.equal(byName['service-api'].suggestedType, 'java-spring');
    assert.deepEqual(byName['service-api'].suggestedTests.unit, [['mvnw.cmd', '-B', 'test']]);
    assert.equal(byName['web-ui'].remote, 'git@bitbucket.example.internal:ord/web-ui.git');
    assert.equal(byName['web-ui'].suggestedType, 'ui');
    assert.deepEqual(byName['web-ui'].suggestedTests.compile, [['npm.cmd', 'run', 'build']]);

    const hosts = Object.fromEntries(result.hosts.map((host) => [host.host, host]));
    assert.equal(hosts['agility.example.internal'].looksLike, 'agility');
    assert.equal(hosts['agility.example.internal'].example, 'https://agility.example.internal/Instance/TeamRoom.mvc/Show');
    assert.equal(hosts['splunk.example.internal'].looksLike, 'splunk');
    assert.equal(hosts['wiki.example.internal'].example, 'https://wiki.example.internal/secret');
    assert.equal('hidden.example.internal' in hosts, false, '.env files are never read');
    assert.equal('registry.vendor.example' in hosts, false, 'dependency folders are skipped');

    assert.equal(result.suggestedAnswers.repositories.split(', ').sort().join(', '), 'service-api=SERVICE_API_REPO_URL, web-ui=WEB_UI_REPO_URL');
    assert.equal(result.suggestedAnswers.bitbucketAllowedHosts, 'bitbucket.example.internal');
    assert.equal(result.suggestedAnswers.environmentValues.SERVICE_API_REPO_URL, 'https://bitbucket.example.internal/scm/ord/Service-API.git');
    assert.equal(result.suggestedAnswers.repositoryDetails['service-api'].type, 'java-spring');

    // The suggestion is directly usable as the start of an answers file.
    const proposal = /** @type {any} */ (await proposeOnboarding(ws.workspace, { answers: { id: 'orders', name: 'Orders', ...result.suggestedAnswers }, env: {}, dryRun: true }));
    assert.equal(proposal.projectId, 'orders');
    assert.equal(proposal.environment.length, 2);
  });

  test('a single file can be scanned, and bad input is refused', async () => {
    const file = path.join(ws.root, 'notes.md');
    fs.writeFileSync(file, 'Dynatrace: https://abc12345.live.dynatrace.com/api/v2/problems');
    const result = await scanSources([file]);
    assert.deepEqual(result.repositories, []);
    assert.equal(result.hosts[0].looksLike, 'dynatrace');
    await expectCode(() => scanSources([]), 'INVALID_ARGUMENT');
    await expectCode(() => scanSources([path.join(ws.root, 'nope')]), 'NOT_FOUND');
  });
});
