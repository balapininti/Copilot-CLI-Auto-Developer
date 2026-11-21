/**
 * Commands that talk to project systems on behalf of the auto-developer
 * workflow: auth, agility, repo, java, db2, test, review, pr, run, browser.
 */

import fs from 'node:fs';
import path from 'node:path';

import * as agility from '../../adapters/agility/client.js';
import * as git from '../../adapters/bitbucket/git.js';
import { openBrowser, runSteps } from '../../adapters/browser/playwright.js';
import * as db2 from '../../adapters/db2/client.js';
import { describeLayout } from '../../adapters/java/detect.js';
import { parseDiff, reviewDiff } from '../../adapters/review/checks.js';
import { runStages } from '../../adapters/testing/runner.js';
import { Actions, enforcePolicy } from '../../core/approvals.js';
import { appendAudit } from '../../core/audit.js';
import { createTransport, SERVICES } from '../../core/auth.js';
import { AutoDevError, ErrorCodes } from '../../core/errors.js';
import { hostOf } from '../../core/http.js';
import { envValue, isMissing } from '../../core/manifest.js';
import { redactString } from '../../core/redact.js';
import { getSecret } from '../../core/secrets.js';
import { atomicWriteJson, resolveInside, safeId } from '../../core/state-store.js';
import { stateDirFor } from '../../core/workspace.js';
import { createPullRequest } from '../../workflow/pull-request.js';
import { addHistory, checkGates, loadRun, recordGate, repoState, updateRun } from '../../workflow/run-store.js';

const MAX_PATCH_CHARS = 200_000;

/**
 * @template T
 * @param {import('../main.js').CommandContext} ctx
 * @param {string} service
 * @param {(transport: import('../../core/auth.js').Transport, project: ReturnType<import('../main.js').CommandContext['project']>) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTransport(ctx, service, fn) {
  const project = ctx.project();
  const transport = await createTransport(service, project.manifest, {
    projectId: project.projectId,
    env: ctx.env,
    logger: ctx.logger,
    browserChannel: ctx.flags.browser,
    interactive: process.stdin.isTTY === true || ctx.env.AUTODEV_INTERACTIVE === '1',
  });
  try {
    return await fn(transport, project);
  } finally {
    await transport.close();
  }
}

/**
 * Resolve --repo to its manifest entry and local path, refusing repositories
 * that are not part of the scoped project.
 * @param {import('../main.js').CommandContext} ctx
 */
function repoOf(ctx) {
  const project = ctx.project();
  const name = ctx.need('repo');
  const repo = project.manifest.repositories.find((/** @type {any} */ candidate) => candidate.name === name);
  if (!repo) {
    throw new AutoDevError(ErrorCodes.PROJECT_SCOPE_VIOLATION, `Repository "${name}" is not mapped to project "${project.projectId}".`, {
      details: { repositories: project.manifest.repositories.map((/** @type {any} */ candidate) => candidate.name) },
    });
  }
  return { ...project, repo, repoPath: resolveInside(project.dir, repo.localPath) };
}

/**
 * @param {import('../main.js').CommandContext} ctx
 */
function storyOf(ctx) {
  return safeId(String(ctx.need('story')).toUpperCase(), 'story id');
}

/**
 * @param {import('../main.js').CommandContext} ctx
 * @param {string} projectId
 * @param {string} storyId
 * @param {string} name
 * @param {unknown} content
 */
function writeEvidence(ctx, projectId, storyId, name, content) {
  const file = path.join(stateDirFor(ctx.workspace, 'evidence', projectId), storyId, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  atomicWriteJson(file, content);
  return file;
}

/**
 * A session works on one project, so a ticket it reads or writes must belong
 * to one of that project's teams. Where the project lists no team names this
 * cannot be checked, and the result says so.
 * @param {Record<string, any>} manifest
 * @param {{ id: string, team: string | null }} story
 * @returns {string} how the check went
 */
function assertStoryInProject(manifest, story) {
  const teams = (manifest.agility.teamNames ?? []).map((/** @type {string} */ name) => name.toLowerCase());
  if (teams.length === 0) return 'not checked: agility.teamNames is empty in project.yaml';
  if (!story.team || !teams.includes(String(story.team).toLowerCase())) {
    throw new AutoDevError(
      ErrorCodes.PROJECT_SCOPE_VIOLATION,
      `${story.id} belongs to team "${story.team ?? 'none'}", which is not one of this project's teams. It is outside this session's project.`,
      { details: { workitem: story.id, team: story.team ?? null, projectTeams: manifest.agility.teamNames } },
    );
  }
  return 'team matches project';
}

/** @type {Record<string, import('../main.js').Command>} */
export const integrationCommands = {
  'auth status': {
    summary: 'Show, per service, whether a token is available and what the fallback would be. Never prints secrets.',
    run: async (ctx) => {
      const { manifest } = ctx.project();
      const services = [];
      for (const [name, spec] of Object.entries(SERVICES)) {
        const baseUrl = envValue(spec.baseUrlEnv(manifest), ctx.env);
        const secretName = spec.tokenSecret(manifest);
        const token = await getSecret(secretName, { env: ctx.env });
        services.push({
          service: name,
          baseUrlConfigured: Boolean(baseUrl),
          host: hostOf(baseUrl)[0] ?? null,
          tokenSecret: secretName,
          tokenAvailable: Boolean(token),
          withoutToken: spec.browserFallback(manifest) ? 'signed-in browser session (Edge), interactive SSO if needed' : 'not available: a token is required',
        });
      }
      const database = manifest.database;
      const db2Secret = database.connectionProfile ? db2.connectionSecretName(database.connectionProfile) : null;
      services.push({
        service: 'db2',
        configured: database.engine === 'db2',
        connectionSecret: db2Secret,
        connectionAvailable: db2Secret ? Boolean(await getSecret(db2Secret, { env: ctx.env })) : false,
        withoutToken: 'not applicable: DB2 uses its native authentication only',
      });
      return { services };
    },
  },
  'auth login': {
    summary: 'Open the approved browser so the user can sign in to a service; the session is kept in the project profile.',
    usage: 'auth login --service agility',
    run: (ctx) => {
      const service = ctx.need('service');
      if (!Object.hasOwn(SERVICES, service) || !SERVICES[service].browserFallback(ctx.project().manifest)) {
        throw new AutoDevError(ErrorCodes.UNSUPPORTED, `Browser sign-in is not supported for "${service}". Provide an API token instead (docs/secrets.md).`);
      }
      return withTransport(ctx, service, async (transport) => ({ service, signedIn: true, mode: transport.mode }));
    },
  },

  'agility verify': {
    summary: 'Read-only proof that Agility is reachable and the account is recognised.',
    run: (ctx) => withTransport(ctx, 'agility', (transport) => agility.verifyAccess(transport)),
  },
  'agility boards': {
    summary: 'List Agility team rooms and teams visible to the account.',
    run: (ctx) => withTransport(ctx, 'agility', (transport) => agility.listBoards(transport)),
  },
  'agility story': {
    summary: 'Read a story or defect: title, description, acceptance criteria, comments, attachments, dependencies, release branch.',
    usage: 'agility story <S-01234>',
    run: (ctx) =>
      withTransport(ctx, 'agility', async (transport, { projectId, manifest }) => {
        if (!ctx.args[0]) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'Usage: autodev agility story <S-01234>');
        const story = await agility.readStory(transport, manifest, ctx.args[0]);
        const projectCheck = assertStoryInProject(manifest, story);
        await updateRun(ctx.workspace, projectId, story.id, (run) => {
          run.story = { id: story.id, oid: story.oid, title: story.title, url: story.url, releaseBranch: story.releaseBranch, releaseBranchSource: story.releaseBranchSource, dependencies: story.dependencies, fetchedAt: story.fetchedAt };
          addHistory(run, 'story-read', { via: story.fetchedVia });
        });
        /** @type {string[]} */
        const gaps = [];
        if (!story.releaseBranch) gaps.push(`Release branch: ${story.releaseBranchSource}. Ask the user which release branch to use.`);
        if (!story.acceptanceCriteria) gaps.push(`Acceptance criteria: ${story.acceptanceCriteriaSource === 'not configured' ? 'the field is not configured in project.yaml' : 'empty on the story'}.`);
        if (projectCheck.startsWith('not checked')) gaps.push(`Project membership ${projectCheck}, so it could not be confirmed that this ticket belongs to the session's project.`);
        return { ...story, projectCheck, gaps };
      }),
  },
  'agility comment': {
    summary: 'Add a comment to a story or defect (follows the updateTicket policy).',
    usage: 'agility comment <S-01234> --text "..." [--approval <id>]',
    run: (ctx) =>
      withTransport(ctx, 'agility', async (transport, { projectId, manifest }) => {
        if (!ctx.args[0]) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'Usage: autodev agility comment <S-01234> --text "..."');
        const text = redactString(ctx.need('text'), { pii: true });
        const story = await agility.readStory(transport, manifest, ctx.args[0]);
        assertStoryInProject(manifest, story);
        const payload = { workitem: story.id, oid: story.oid, text };
        const gate = await enforcePolicy(ctx.workspace, {
          projectId, action: Actions.UPDATE_TICKET, policy: manifest.policies.updateTicket,
          summary: `Comment on ${story.id}`, payload, approvalId: ctx.flags.approval, dryRun: ctx.dryRun,
        });
        if (!gate.proceed) return { dryRun: true, wouldComment: payload };
        const result = await agility.addComment(transport, story.oid, text);
        await appendAudit(ctx.workspace, projectId, { action: 'agility.comment.added', outcome: 'success', details: { workitem: story.id, approvalId: gate.approvalId } });
        return { ...result, workitem: story.id };
      }),
  },
  'agility status': {
    summary: 'Set the status of a story or defect (follows the updateTicket policy).',
    usage: 'agility status <S-01234> --status "In Progress" [--approval <id>]',
    run: (ctx) =>
      withTransport(ctx, 'agility', async (transport, { projectId, manifest }) => {
        if (!ctx.args[0]) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'Usage: autodev agility status <S-01234> --status "<name>"');
        const statusName = ctx.need('status');
        const story = await agility.readStory(transport, manifest, ctx.args[0]);
        assertStoryInProject(manifest, story);
        const payload = { workitem: story.id, oid: story.oid, status: statusName };
        const gate = await enforcePolicy(ctx.workspace, {
          projectId, action: Actions.UPDATE_TICKET, policy: manifest.policies.updateTicket,
          summary: `Set ${story.id} to "${statusName}"`, payload, approvalId: ctx.flags.approval, dryRun: ctx.dryRun,
        });
        if (!gate.proceed) return { dryRun: true, wouldSet: payload };
        const result = await agility.setStatus(transport, story.oid, statusName);
        await appendAudit(ctx.workspace, projectId, { action: 'agility.status.set', outcome: 'success', details: { workitem: story.id, status: statusName, approvalId: gate.approvalId } });
        return { ...result, workitem: story.id };
      }),
  },

  'repo status': {
    summary: 'State of a repository clone: branch, uncommitted changes, remote.',
    usage: 'repo status --repo <name>',
    run: async (ctx) => {
      const { repo, repoPath } = repoOf(ctx);
      return { repository: repo.name, path: repoPath, ...(await git.inspectRepo(repoPath)) };
    },
  },
  'repo prepare': {
    summary: 'Clone or reuse the repository, verify the story release branch and create the story feature branch.',
    usage: 'repo prepare --story <S-01234> --repo <name> [--release-branch <branch named by the user>]',
    run: async (ctx) => {
      const { projectId, manifest, repo, repoPath } = repoOf(ctx);
      const storyId = storyOf(ctx);
      const run = loadRun(ctx.workspace, projectId, storyId);
      if (!run.story) {
        throw new AutoDevError(ErrorCodes.GATE_FAILED, `Story ${storyId} has not been read in this workspace yet. Run: autodev agility story ${storyId}`);
      }
      const url = git.approvedRepoUrl(manifest, repo, ctx.env);
      const clone = await git.ensureClone({ repoPath, url, name: repo.name, dryRun: ctx.dryRun });
      const named = ctx.flags['release-branch'];
      if (named && run.story.releaseBranch && named !== run.story.releaseBranch) {
        throw new AutoDevError(
          ErrorCodes.POLICY_PROHIBITED,
          `Story ${storyId} names release branch "${run.story.releaseBranch}"; --release-branch cannot replace it with "${named}". If the story is wrong, it is corrected in Agility.`,
        );
      }
      const base = named && !run.story.releaseBranch
        ? { branch: git.assertBranchName(named, 'release branch'), source: 'named by the user on the command line (the story names none)' }
        : git.resolveBaseBranch(repo, run.story);
      if (ctx.dryRun && clone.action === 'would-clone') {
        return { dryRun: true, clone, baseBranch: base, note: 'The release branch can be verified only after cloning.' };
      }
      const baseSha = await git.verifyReleaseBranch(repoPath, base.branch);

      const existing = run.repos[repo.name];
      const state = await git.inspectRepo(repoPath);
      if (existing?.featureBranch && existing.baseBranch === base.branch && state.currentBranch === existing.featureBranch) {
        return { repository: repo.name, clone, baseBranch: base, baseSha, featureBranch: existing.featureBranch, created: false, note: 'Already on the story branch.' };
      }
      const branch = await git.createFeatureBranch({
        repoPath, name: repo.name, baseBranch: base.branch, storyId, title: run.story.title ?? '',
        pattern: manifest.branching.featurePattern, protectedBranches: manifest.branching.protected, dryRun: ctx.dryRun,
      });
      if (!ctx.dryRun) {
        await updateRun(ctx.workspace, projectId, storyId, (current) => {
          const repoRun = repoState(current, repo.name);
          repoRun.baseBranch = base.branch;
          repoRun.baseBranchSource = base.source;
          repoRun.featureBranch = branch.branch;
          repoRun.gates = {};
          addHistory(current, 'branch-created', { repo: repo.name, branch: branch.branch, base: base.branch });
        });
        await appendAudit(ctx.workspace, projectId, { action: 'repo.branch.created', outcome: 'success', details: { storyId, repository: repo.name, branch: branch.branch, base: base.branch } });
      }
      return { repository: repo.name, clone, baseBranch: base, baseSha, featureBranch: branch.branch, created: branch.created, dryRun: ctx.dryRun };
    },
  },
  'repo diff': {
    summary: 'Everything that differs from the release branch (committed and uncommitted).',
    usage: 'repo diff --story <S-01234> --repo <name>',
    run: async (ctx) => {
      const { projectId, repo, repoPath } = repoOf(ctx);
      const run = loadRun(ctx.workspace, projectId, storyOf(ctx));
      const base = run.repos[repo.name]?.baseBranch;
      if (!base) throw new AutoDevError(ErrorCodes.GATE_FAILED, 'No release branch recorded for this repository and story. Run: autodev repo prepare');
      const diff = await git.diffAgainstBase(repoPath, base);
      return { ...diff, patch: redactString(diff.patch.slice(0, MAX_PATCH_CHARS)), patchTruncated: diff.patchIncomplete || diff.patch.length > MAX_PATCH_CHARS };
    },
  },
  'repo commit': {
    summary: 'Commit the change on the story branch. Refused until tests and both reviews pass for the current code.',
    usage: 'repo commit --story <S-01234> --repo <name> --message "S-01234: ..."',
    run: async (ctx) => {
      const { projectId, manifest, repo, repoPath } = repoOf(ctx);
      const storyId = storyOf(ctx);
      const run = loadRun(ctx.workspace, projectId, storyId);
      const state = run.repos[repo.name];
      if (!state?.featureBranch) throw new AutoDevError(ErrorCodes.GATE_FAILED, 'No story branch prepared. Run: autodev repo prepare');
      const status = await git.inspectRepo(repoPath);
      if (status.currentBranch !== state.featureBranch) {
        throw new AutoDevError(ErrorCodes.GATE_FAILED, `"${repo.name}" is on "${status.currentBranch}", not the story branch "${state.featureBranch}".`);
      }
      const gates = checkGates(run, repo.name, await git.worktreeTreeId(repoPath));
      if (!gates.ok) {
        throw new AutoDevError(ErrorCodes.GATE_FAILED, 'Commit refused: required checks have not passed for the current code.', { details: { blockers: gates.blockers } });
      }
      const result = await git.commitAll({
        repoPath, name: repo.name, message: ctx.need('message'), storyId, protectedBranches: manifest.branching.protected, dryRun: ctx.dryRun,
      });
      if (result.committed) {
        await updateRun(ctx.workspace, projectId, storyId, (current) => addHistory(current, 'committed', { repo: repo.name, sha: result.headSha }));
        await appendAudit(ctx.workspace, projectId, { action: 'repo.commit', outcome: 'success', details: { storyId, repository: repo.name, sha: result.headSha } });
      }
      return result;
    },
  },

  'java detect': {
    summary: 'Detect build tool, Java and Spring Boot versions, modules and source layout of a repository.',
    usage: 'java detect --repo <name>',
    run: (ctx) => {
      const { repo, repoPath } = repoOf(ctx);
      if (!fs.existsSync(repoPath)) throw new AutoDevError(ErrorCodes.NOT_FOUND, `No clone of "${repo.name}" exists. Run: autodev repo prepare`);
      return { repository: repo.name, ...describeLayout(repoPath) };
    },
  },

  'db2 tables': {
    summary: 'List tables in one of the project\'s DB2 schemas (read-only).',
    usage: 'db2 tables --schema <SCHEMA>',
    run: (ctx) => db2.listTables(ctx.project().manifest, ctx.need('schema'), { env: ctx.env }),
  },
  'db2 describe': {
    summary: 'Describe the columns of a table (read-only). Use this instead of assuming column names.',
    usage: 'db2 describe --schema <SCHEMA> --table <TABLE>',
    run: (ctx) => db2.describeTable(ctx.project().manifest, ctx.need('schema'), ctx.need('table'), { env: ctx.env }),
  },
  'db2 query': {
    summary: 'Run one guarded, parameterised SELECT against the project\'s schemas, with row and time limits.',
    usage: 'db2 query --sql "SELECT ... WHERE ID = ?" --param 42 [--max-rows 50]',
    run: async (ctx) => {
      const { projectId, manifest } = ctx.project();
      const sql = ctx.need('sql');
      const result = await db2.runSelect(
        manifest,
        { sql, params: ctx.flags.param ?? [], maxRows: ctx.flags['max-rows'] ? Number(ctx.flags['max-rows']) : undefined },
        { env: ctx.env },
      );
      await appendAudit(ctx.workspace, projectId, { action: 'db2.select', outcome: 'success', details: { schemas: result.schemas, rowCount: result.rowCount } });
      return result;
    },
  },

  'test run': {
    summary: 'Run build and test stages for a repository and record the result as the tests gate.',
    usage: 'test run --story <S-01234> --repo <name> [--stage compile --stage unit ...]',
    run: async (ctx) => {
      const { projectId, manifest, repo, repoPath } = repoOf(ctx);
      const storyId = storyOf(ctx);
      const treeBefore = await git.worktreeTreeId(repoPath);
      const result = await runStages({
        repoPath, repo, stages: ctx.flags.stage, required: manifest.tests.required, timeoutMinutes: manifest.tests.timeoutMinutes,
      });
      const treeId = await git.worktreeTreeId(repoPath);
      if (treeId !== treeBefore) {
        // Source files changed while the stages ran, so it is not known which code they tested.
        result.passed = false;
        result.blockers.push({ stage: 'all', status: 'invalid', reason: 'Files changed while the tests were running (or the build writes into tracked or unignored paths). Run again without editing; add build output to .gitignore.' });
      }
      const evidenceFile = writeEvidence(ctx, projectId, storyId, `${repo.name}-tests`, { storyId, treeId, ...result });
      await recordGate(ctx.workspace, {
        projectId, storyId, repo: repo.name, gate: 'tests', treeId, passed: result.passed,
        summary: { stages: result.results.map((stage) => ({ stage: stage.stage, status: stage.status, junit: stage.junit ?? null })), evidenceFile },
      });
      await appendAudit(ctx.workspace, projectId, { action: 'gate.tests', outcome: result.passed ? 'success' : 'failure', details: { storyId, repository: repo.name, treeId, blockers: result.blockers } });
      return { ...result, treeId, evidenceFile };
    },
  },

  'review run': {
    summary: 'Run the automated review checks over the change and record the automated-review gate.',
    usage: 'review run --story <S-01234> --repo <name> [--authorize-schema-change [--approval <id>]]',
    run: async (ctx) => {
      const { projectId, manifest, repo, repoPath } = repoOf(ctx);
      const storyId = storyOf(ctx);
      const run = loadRun(ctx.workspace, projectId, storyId);
      const base = run.repos[repo.name]?.baseBranch;
      if (!base) throw new AutoDevError(ErrorCodes.GATE_FAILED, 'No release branch recorded for this repository and story. Run: autodev repo prepare');
      const diff = await git.diffAgainstBase(repoPath, base);
      const files = parseDiff(diff.patch);
      let schemaChangeAuthorized = false;
      const coverage = { allPaths: diff.files.map((file) => file.path), incomplete: diff.patchIncomplete };
      const schemaFiles = reviewDiff(files, coverage).findings.filter((finding) => finding.rule === 'schema-change').map((finding) => finding.file);
      if (schemaFiles.length > 0 && ctx.flags['authorize-schema-change']) {
        const gate = await enforcePolicy(ctx.workspace, {
          projectId, action: Actions.SCHEMA_CHANGE, policy: manifest.policies.schemaChanges,
          summary: `Allow schema or migration changes in ${repo.name} for ${storyId}`,
          payload: { storyId, repository: repo.name, files: schemaFiles }, approvalId: ctx.flags.approval, dryRun: ctx.dryRun,
        });
        schemaChangeAuthorized = gate.proceed;
      }
      const review = reviewDiff(files, { ...coverage, schemaChangeAuthorized });
      const treeId = await git.worktreeTreeId(repoPath);
      await recordGate(ctx.workspace, {
        projectId, storyId, repo: repo.name, gate: 'automated-review', treeId, passed: review.passed,
        summary: { counts: review.counts, stats: review.stats },
      });
      await appendAudit(ctx.workspace, projectId, { action: 'gate.automated-review', outcome: review.passed ? 'success' : 'failure', details: { storyId, repository: repo.name, treeId, counts: review.counts } });
      return { repository: repo.name, treeId, ...review };
    },
  },
  'review record': {
    summary: 'Record the independent reviewer\'s verdict for the current code (the independent-review gate).',
    usage: 'review record --story <S-01234> --repo <name> --verdict pass|fail --reviewer <who> [--notes "..."]',
    run: async (ctx) => {
      const { projectId, repo, repoPath } = repoOf(ctx);
      const storyId = storyOf(ctx);
      const verdict = ctx.need('verdict');
      if (verdict !== 'pass' && verdict !== 'fail') throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, '--verdict must be pass or fail.');
      const reviewer = ctx.need('reviewer');
      if (/^auto-developer$/i.test(reviewer)) {
        throw new AutoDevError(ErrorCodes.POLICY_PROHIBITED, 'The review must be independent: the auto-developer agent cannot record its own review. Use the code-reviewer agent or a person.');
      }
      const treeId = await git.worktreeTreeId(repoPath);
      const run = loadRun(ctx.workspace, projectId, storyId);
      const automated = run.repos[repo.name]?.gates?.['automated-review'];
      if (!automated || automated.treeId !== treeId) {
        throw new AutoDevError(ErrorCodes.GATE_FAILED, 'Run the automated review for the current code first: autodev review run');
      }
      if (verdict === 'pass' && !automated.passed) {
        throw new AutoDevError(ErrorCodes.GATE_FAILED, 'The automated review has blockers; an independent pass cannot be recorded until they are resolved.');
      }
      const notes = ctx.flags.notes ? redactString(String(ctx.flags.notes), { pii: true }).slice(0, 2000) : null;
      await recordGate(ctx.workspace, {
        projectId, storyId, repo: repo.name, gate: 'independent-review', treeId, passed: verdict === 'pass', summary: { verdict, reviewer, notes },
      });
      await appendAudit(ctx.workspace, projectId, { action: 'gate.independent-review', outcome: verdict === 'pass' ? 'success' : 'failure', details: { storyId, repository: repo.name, treeId, reviewer } });
      return { repository: repo.name, treeId, verdict, reviewer };
    },
  },

  'pr create': {
    summary: 'Push the story branch and open a pull request. Gated by tests, reviews and the createPR policy.',
    usage: 'pr create --story <S-01234> --repo <name> [--approval <id>] [--risks "..."] [--dependencies "..."]',
    run: (ctx) => {
      const { projectId, manifest, dir, repo } = repoOf(ctx);
      return createPullRequest(ctx.workspace, {
        projectId, manifest, projectDir: dir, storyId: storyOf(ctx), repoName: repo.name, approvalId: ctx.flags.approval,
        dryRun: ctx.dryRun, risks: ctx.flags.risks, dependencies: ctx.flags.dependencies, title: ctx.flags.title, logger: ctx.logger, env: ctx.env,
      });
    },
  },

  'run show': {
    summary: 'Show the recorded state of a story: branches, gates, pull requests and history.',
    usage: 'run show --story <S-01234>',
    run: async (ctx) => {
      const { projectId, manifest, dir } = ctx.project();
      const run = loadRun(ctx.workspace, projectId, storyOf(ctx));
      /** @type {Record<string, unknown>} */
      const readiness = {};
      for (const name of Object.keys(run.repos)) {
        const repo = manifest.repositories.find((/** @type {any} */ candidate) => candidate.name === name);
        const repoPath = repo ? resolveInside(dir, repo.localPath) : null;
        if (!repoPath || !fs.existsSync(repoPath)) continue;
        readiness[name] = checkGates(run, name, await git.worktreeTreeId(repoPath));
      }
      return { ...run, readiness };
    },
  },

  'browser run': {
    summary: 'Run browser steps (navigate, click, fill, inspect, screenshot, assert) in the approved browser.',
    usage: 'browser run --steps steps.json [--browser msedge|chromium] [--headless] [--story <S-01234>]',
    run: async (ctx) => {
      const { projectId, manifest } = ctx.project();
      /** @type {any} */
      let steps;
      try {
        steps = JSON.parse(fs.readFileSync(ctx.need('steps'), 'utf8'));
      } catch (error) {
        throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Could not read the steps file: ${/** @type {Error} */ (error).message}`);
      }
      if (!Array.isArray(steps) || steps.length === 0 || steps.length > 200) {
        throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'The steps file must be a JSON array of 1 to 200 steps.');
      }
      const serviceHosts = Object.values(SERVICES).flatMap((spec) => hostOf(envValue(spec.baseUrlEnv(manifest), ctx.env)));
      // Clicking and typing act with the user's signed-in session. On the
      // ticketing, source-control and telemetry systems that would be a write
      // around the approval gates, so interactive steps are limited to the
      // application under test; those systems are read-only here.
      const interactive = steps.some((/** @type {any} */ step) => ['click', 'fill', 'press'].includes(step?.action));
      const appHosts = (manifest.browser.allowedHosts ?? []).filter((/** @type {string} */ host) => !serviceHosts.includes(host.toLowerCase()));
      if (interactive) {
        for (const step of steps) {
          if (step?.action !== 'goto') continue;
          let host = '';
          try {
            host = new URL(String(step.url)).hostname.toLowerCase();
          } catch {
            // reported as an invalid step when it runs
          }
          if (serviceHosts.includes(host)) {
            throw new AutoDevError(
              ErrorCodes.POLICY_PROHIBITED,
              `Steps that click, type or press keys cannot be run against ${host}. Use the autodev commands for that system, which apply the approval policy; the browser may only read it.`,
            );
          }
        }
      }
      const allowedHosts = interactive ? appHosts : [...new Set([...serviceHosts, ...(manifest.browser.allowedHosts ?? [])])];
      const evidenceDir = path.join(stateDirFor(ctx.workspace, 'evidence', projectId), ctx.flags.story ? storyOf(ctx) : 'browser');
      if (ctx.dryRun) return { dryRun: true, wouldRun: steps.length, interactive, allowedHosts, browser: ctx.flags.browser ?? manifest.browser.preferred };
      const session = await openBrowser({
        manifest, projectId, allowedHosts, exactHosts: true, channel: ctx.flags.browser, headless: ctx.flags.headless === true, env: ctx.env, logger: ctx.logger,
      });
      try {
        return { browser: session.channel, ...(await runSteps(session, steps, { allowedHosts, evidenceDir })) };
      } finally {
        await session.close();
      }
    },
  },

  'service hosts': {
    summary: 'Hosts this project is allowed to reach, by service.',
    run: (ctx) => {
      const { manifest } = ctx.project();
      return {
        services: Object.fromEntries(Object.entries(SERVICES).map(([name, spec]) => [name, hostOf(envValue(spec.baseUrlEnv(manifest), ctx.env))[0] ?? null])),
        repositories: manifest.bitbucket.allowedHosts,
        browser: manifest.browser.allowedHosts,
        notConfigured: Object.entries(SERVICES).filter(([, spec]) => isMissing(spec.baseUrlEnv(manifest))).map(([name]) => name),
      };
    },
  },
};
