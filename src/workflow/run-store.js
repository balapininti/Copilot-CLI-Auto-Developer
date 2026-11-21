/**
 * Per-story run state: which repositories are involved, which branch each
 * uses, and the test and review results that gate the pull request.
 *
 *   state/runs/<project>/<storyId>.json
 *
 * Gate results are bound to a git tree id, the fingerprint of the exact code
 * that was tested and reviewed. A PR can be created only when the committed
 * code has that same tree id, so "tests passed" can never refer to an older
 * version of the change.
 */

import path from 'node:path';

import { AutoDevError, ErrorCodes } from '../core/errors.js';
import { atomicWriteJson, ensureDir, readJson, safeId, withLock } from '../core/state-store.js';
import { stateDirFor } from '../core/workspace.js';

/** Gates that must pass, for the same tree, before a pull request. */
export const REQUIRED_GATES = Object.freeze(['tests', 'automated-review', 'independent-review']);

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {string} storyId
 */
function runFile(workspace, projectId, storyId) {
  return path.join(stateDirFor(workspace, 'runs', projectId), `${safeId(storyId, 'story id')}.json`);
}

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {string} storyId
 * @returns {Record<string, any>}
 */
export function loadRun(workspace, projectId, storyId) {
  return (
    readJson(runFile(workspace, projectId, storyId), null) ?? {
      projectId,
      storyId,
      story: null,
      repos: {},
      history: [],
      createdAt: new Date().toISOString(),
    }
  );
}

/**
 * Read-modify-write a run under a lock.
 * @template T
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {string} storyId
 * @param {(run: Record<string, any>) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function updateRun(workspace, projectId, storyId, fn) {
  const file = runFile(workspace, projectId, storyId);
  ensureDir(path.dirname(file));
  return withLock(`${file}.lock`, async () => {
    const run = loadRun(workspace, projectId, storyId);
    const result = await fn(run);
    run.updatedAt = new Date().toISOString();
    atomicWriteJson(file, run);
    return result;
  });
}

/**
 * @param {Record<string, any>} run
 * @param {string} repoName
 */
export function repoState(run, repoName) {
  run.repos[repoName] ??= { baseBranch: null, featureBranch: null, gates: {}, pr: null };
  return run.repos[repoName];
}

/**
 * @param {Record<string, any>} run
 * @param {string} event
 * @param {Record<string, unknown>} [details]
 */
export function addHistory(run, event, details = {}) {
  run.history.push({ at: new Date().toISOString(), event, ...details });
  if (run.history.length > 500) run.history.splice(0, run.history.length - 500);
}

/**
 * Record a gate result for a repository.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ projectId: string, storyId: string, repo: string, gate: string, treeId: string, passed: boolean, summary: Record<string, unknown> }} input
 */
export function recordGate(workspace, input) {
  if (!REQUIRED_GATES.includes(input.gate)) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Unknown gate "${input.gate}".`);
  }
  return updateRun(workspace, input.projectId, input.storyId, (run) => {
    const state = repoState(run, input.repo);
    state.gates[input.gate] = { passed: input.passed, treeId: input.treeId, at: new Date().toISOString(), summary: input.summary };
    addHistory(run, `gate:${input.gate}`, { repo: input.repo, passed: input.passed, treeId: input.treeId });
    return state.gates[input.gate];
  });
}

/**
 * Check every required gate against the tree that would go into the PR.
 * @param {Record<string, any>} run
 * @param {string} repoName
 * @param {string} treeId
 * @returns {{ ok: boolean, blockers: Array<{ gate: string, reason: string }> }}
 */
export function checkGates(run, repoName, treeId) {
  const gates = run.repos[repoName]?.gates ?? {};
  const blockers = [];
  for (const gate of REQUIRED_GATES) {
    const result = gates[gate];
    if (!result) blockers.push({ gate, reason: 'Not run yet.' });
    else if (!result.passed) blockers.push({ gate, reason: 'Did not pass.' });
    else if (result.treeId !== treeId) blockers.push({ gate, reason: 'Passed for an earlier version of the code; the change was modified afterwards. Run it again.' });
  }
  return { ok: blockers.length === 0, blockers };
}
