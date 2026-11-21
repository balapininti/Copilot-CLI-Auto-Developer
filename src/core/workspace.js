/**
 * Workspace layout.
 *
 *   <workspace>\automation\   this repository (agents, skills, scripts, src)
 *   <workspace>\projects\<id> one folder per onboarded project
 *   <workspace>\state\        approvals, audit logs, queues, incidents, runs
 *
 * The workspace is `AUTODEV_WORKSPACE` when set, otherwise the parent folder
 * of this repository (C:\DevWorkspace when this is C:\DevWorkspace\automation).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { safeId } from './state-store.js';

/** Absolute path of this repository. */
export const AUTOMATION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @typedef {object} Workspace
 * @property {string} root
 * @property {string} automationRoot
 * @property {string} projectsDir
 * @property {string} stateDir
 */

/**
 * @param {{ workspace?: string | null, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Workspace}
 */
export function resolveWorkspace(options = {}) {
  const env = options.env ?? process.env;
  const root = path.resolve(options.workspace || env.AUTODEV_WORKSPACE || path.dirname(AUTOMATION_ROOT));
  return {
    root,
    automationRoot: AUTOMATION_ROOT,
    projectsDir: path.join(root, 'projects'),
    stateDir: path.join(root, 'state'),
  };
}

/**
 * @param {Workspace} workspace
 * @param {string} projectId
 * @returns {string}
 */
export function projectDir(workspace, projectId) {
  return path.join(workspace.projectsDir, safeId(projectId, 'project id'));
}

/**
 * Folder for one kind of per-project state, e.g. stateDirFor(ws, 'approvals', 'billing').
 * @param {Workspace} workspace
 * @param {string} kind
 * @param {string} projectId
 * @returns {string}
 */
export function stateDirFor(workspace, kind, projectId) {
  return path.join(workspace.stateDir, safeId(kind, 'state kind'), safeId(projectId, 'project id'));
}
