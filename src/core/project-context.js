/**
 * Project identity and scoping.
 *
 * A CLI session works on exactly one project. The launcher fixes it with
 * AUTODEV_PROJECT, or the agent selects it once per session; after that every
 * command that names a different project is refused. That single check is what
 * keeps one project's repositories, schemas, telemetry and learnings from
 * leaking into another's work.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AutoDevError, ErrorCodes } from './errors.js';
import { isApprovedContent } from './knowledge-integrity.js';
import { isMissing, loadManifest } from './manifest.js';
import { atomicWriteJson, readJson, resolveInside, safeId } from './state-store.js';
import { projectDir } from './workspace.js';

/**
 * @param {import('./workspace.js').Workspace} workspace
 * @returns {string[]} ids of folders that contain a project.yaml
 */
export function listProjectIds(workspace) {
  if (!fs.existsSync(workspace.projectsDir)) return [];
  return fs
    .readdirSync(workspace.projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(workspace.projectsDir, entry.name, 'project.yaml')))
    .map((entry) => entry.name)
    .sort();
}

/**
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} sessionId
 */
function sessionFile(workspace, sessionId) {
  return path.join(workspace.stateDir, 'sessions', `${safeId(sessionId, 'session id')}.json`);
}

/**
 * The project this session is bound to, or null when none is selected yet.
 * @param {import('./workspace.js').Workspace} workspace
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ projectId: string | null, source: 'env' | 'session' | 'none', sessionId: string | null }}
 */
export function getActiveProject(workspace, env = process.env) {
  const sessionId = env.AUTODEV_SESSION_ID?.trim() || null;
  const fromEnv = env.AUTODEV_PROJECT?.trim();
  if (fromEnv) return { projectId: safeId(fromEnv, 'project id'), source: 'env', sessionId };
  if (sessionId) {
    const record = readJson(sessionFile(workspace, sessionId), /** @type {{ projectId?: string } | null} */ (null));
    if (record?.projectId) return { projectId: record.projectId, source: 'session', sessionId };
  }
  return { projectId: null, source: 'none', sessionId };
}

/**
 * Bind this session to a project. A session can be bound once; changing
 * project means starting a new session.
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {NodeJS.ProcessEnv} [env]
 */
export function selectProject(workspace, projectId, env = process.env) {
  loadManifest(workspace, projectId); // must exist and be valid
  const active = getActiveProject(workspace, env);
  if (active.projectId && active.projectId !== projectId) {
    throw new AutoDevError(
      ErrorCodes.PROJECT_SCOPE_VIOLATION,
      `This session is already bound to project "${active.projectId}". Start a new session to work on "${projectId}".`,
      { details: { activeProject: active.projectId, requested: projectId } },
    );
  }
  if (active.projectId === projectId) return { projectId, sessionId: active.sessionId, alreadySelected: true };
  if (!active.sessionId) {
    throw new AutoDevError(
      ErrorCodes.NOT_CONFIGURED,
      'No session is active. Start Copilot CLI through scripts/Start-AutoDev.ps1, or pass --project to each command.',
    );
  }
  atomicWriteJson(sessionFile(workspace, active.sessionId), { projectId, selectedAt: new Date().toISOString() });
  return { projectId, sessionId: active.sessionId, alreadySelected: false };
}

/**
 * Decide which project a command runs against and refuse cross-project use.
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string | null | undefined} requested value of --project, if given
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveProjectScope(workspace, requested, env = process.env) {
  const active = getActiveProject(workspace, env);
  if (requested) safeId(requested, 'project id');
  if (active.projectId) {
    if (requested && requested !== active.projectId) {
      throw new AutoDevError(
        ErrorCodes.PROJECT_SCOPE_VIOLATION,
        `This session is bound to project "${active.projectId}"; refusing to act on "${requested}".`,
        { details: { activeProject: active.projectId, requested } },
      );
    }
    return active.projectId;
  }
  if (active.sessionId) {
    throw new AutoDevError(
      ErrorCodes.NOT_CONFIGURED,
      'No project is selected for this session. Resolve the board and story first, then run: autodev session select --project <id>',
      { details: { requested: requested ?? null } },
    );
  }
  if (!requested) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'No project given. Pass --project <id>.');
  }
  return requested;
}

/**
 * Find the single project a board maps to.
 * @param {import('./workspace.js').Workspace} workspace
 * @param {{ boardId?: string | null, storyId?: string | null, teamName?: string | null }} query
 * @returns {{ projectId: string, matchedBy: string, storyId: string | null }}
 */
export function resolveProject(workspace, query) {
  const boardId = query.boardId?.trim();
  const teamName = query.teamName?.trim().toLowerCase();
  if (!boardId && !teamName) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'A board id or team name is needed to resolve the project.');
  }
  /** @type {Array<{ projectId: string, matchedBy: string }>} */
  const matches = [];
  /** @type {Array<{ projectId: string, problem: string }>} */
  const unreadable = [];
  for (const projectId of listProjectIds(workspace)) {
    let manifest;
    try {
      ({ manifest } = loadManifest(workspace, projectId));
    } catch (error) {
      unreadable.push({ projectId, problem: /** @type {Error} */ (error).message });
      continue;
    }
    if (boardId && manifest.agility.boardIds.includes(boardId)) {
      matches.push({ projectId, matchedBy: `boardId ${boardId}` });
    } else if (teamName && (manifest.agility.teamNames ?? []).some((/** @type {string} */ name) => name.toLowerCase() === teamName)) {
      matches.push({ projectId, matchedBy: `team ${query.teamName}` });
    }
  }
  if (matches.length === 0) {
    throw new AutoDevError(
      ErrorCodes.PROJECT_NOT_FOUND,
      `No onboarded project maps to ${boardId ? `board "${boardId}"` : `team "${query.teamName}"`}.`,
      { details: { knownProjects: listProjectIds(workspace), unreadable, howToFix: 'Run: autodev onboard-project' } },
    );
  }
  if (matches.length > 1) {
    throw new AutoDevError(
      ErrorCodes.PROJECT_AMBIGUOUS,
      'More than one project maps to that board. Ask the user which project to use; do not pick one.',
      { details: { candidates: matches } },
    );
  }
  return { ...matches[0], storyId: query.storyId ?? null };
}

/**
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} projectId
 */
export function getRepositories(workspace, projectId) {
  const { manifest, dir } = loadManifest(workspace, projectId);
  return manifest.repositories.map((/** @type {Record<string, any>} */ repo) => ({
    ...repo,
    absolutePath: resolveInside(dir, repo.localPath),
    urlConfigured: !isMissing(repo.urlEnv) && Boolean(process.env[repo.urlEnv]),
    services: manifest.services.filter((/** @type {any} */ s) => s.repository === repo.name).map((/** @type {any} */ s) => s.name),
  }));
}

/**
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} projectId
 */
export function getSchemas(workspace, projectId) {
  const { manifest } = loadManifest(workspace, projectId);
  return {
    engine: manifest.database.engine,
    connectionProfile: manifest.database.connectionProfile ?? null,
    writeAccess: manifest.database.writeAccess === true,
    schemas: manifest.database.schemas.map((/** @type {string} */ name) => ({
      name,
      repositories: manifest.repositories.filter((/** @type {any} */ r) => r.schemas.includes(name)).map((/** @type {any} */ r) => r.name),
      services: manifest.services.filter((/** @type {any} */ s) => (s.schemas ?? []).includes(name)).map((/** @type {any} */ s) => s.name),
    })),
  };
}

/**
 * Find the service entry for a runtime service name.
 * @param {Record<string, any>} manifest
 * @param {string | null | undefined} serviceName
 * @returns {Record<string, any> | null}
 */
export function findService(manifest, serviceName) {
  if (!serviceName) return null;
  const wanted = serviceName.toLowerCase();
  return (
    manifest.services.find(
      (/** @type {any} */ service) =>
        service.name.toLowerCase() === wanted ||
        (service.aliases ?? []).some((/** @type {string} */ alias) => alias.toLowerCase() === wanted),
    ) ?? null
  );
}

/** Which guideline files and knowledge areas each task type needs. */
const TASK_CONTEXT = Object.freeze({
  implement: { guidelines: ['architecture', 'coding-standards', 'development-workflow', 'testing-standards'], skills: ['java-spring', 'bitbucket', 'db2', 'testing'] },
  test: { guidelines: ['testing-standards', 'development-workflow'], skills: ['testing', 'browser-playwright'] },
  review: { guidelines: ['coding-standards', 'architecture', 'testing-standards'], skills: ['code-review', 'java-spring'] },
  investigate: { guidelines: ['architecture'], skills: ['splunk', 'dynatrace', 'incident-correlation', 'root-cause-analysis', 'db2', 'workflow-handoff', 'authentication'] },
  database: { guidelines: ['architecture', 'coding-standards'], skills: ['db2'] },
  plan: { guidelines: ['architecture', 'development-workflow'], skills: ['project-context', 'agility', 'bitbucket', 'workflow-handoff', 'authentication'] },
});

export const TASK_TYPES = Object.freeze(Object.keys(TASK_CONTEXT));

const MAX_CONTEXT_FILE_BYTES = 200_000;

/**
 * Load the guidelines and approved learnings relevant to a task type. Files
 * that are configured but absent are reported in `missing`, never invented.
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {string} taskType one of TASK_TYPES
 */
export function loadGuidelines(workspace, projectId, taskType) {
  const context = Object.hasOwn(TASK_CONTEXT, taskType) ? TASK_CONTEXT[/** @type {keyof typeof TASK_CONTEXT} */ (taskType)] : null;
  if (!context) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Unknown task type "${taskType}". Use one of: ${TASK_TYPES.join(', ')}.`);
  }
  const { manifest, dir } = loadManifest(workspace, projectId);
  /** @type {Array<{ path: string, kind: string, content: string, truncated: boolean }>} */
  const files = [];
  /** @type {string[]} */
  const missing = [];
  /** @type {Array<{ path: string, reason: string }>} */
  const rejected = [];

  /** @param {string} relative @param {string} kind */
  const load = (relative, kind) => {
    const absolute = resolveInside(dir, relative);
    if (!fs.existsSync(absolute)) {
      missing.push(relative);
      return;
    }
    const buffer = fs.readFileSync(absolute);
    if (kind === 'approved-learning' && !isApprovedContent(workspace, projectId, relative, buffer)) {
      // Written or edited outside the approval gate: never fed to an agent.
      rejected.push({ path: relative.split(path.sep).join('/'), reason: 'Content does not match what was approved. Run: autodev learn verify' });
      return;
    }
    files.push({
      path: relative.split(path.sep).join('/'),
      kind,
      content: buffer.subarray(0, MAX_CONTEXT_FILE_BYTES).toString('utf8'),
      truncated: buffer.length > MAX_CONTEXT_FILE_BYTES,
    });
  };

  for (const relative of manifest.guidelines) {
    const stem = path.basename(relative, path.extname(relative));
    if (context.guidelines.includes(stem)) load(relative, 'guideline');
  }
  for (const wanted of context.guidelines) {
    if (!manifest.guidelines.some((/** @type {string} */ g) => path.basename(g, path.extname(g)) === wanted)) {
      missing.push(`guidelines/${wanted}.md (not listed in project.yaml)`);
    }
  }
  for (const skill of context.skills) {
    const relative = path.join('knowledge', skill, 'approved.md');
    if (fs.existsSync(resolveInside(dir, relative))) load(relative, 'approved-learning');
  }
  return { projectId, taskType, files, missing, rejected };
}

/**
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} projectId
 */
export function describeProject(workspace, projectId) {
  const { manifest, missing } = loadManifest(workspace, projectId);
  return {
    id: manifest.id,
    name: manifest.name ?? null,
    boardIds: manifest.agility.boardIds,
    repositories: manifest.repositories.map((/** @type {any} */ r) => r.name),
    schemas: manifest.database.schemas,
    services: manifest.services.map((/** @type {any} */ s) => s.name),
    policies: manifest.policies,
    monitoringEnabled: manifest.monitoring.enabled,
    missing,
    dir: projectDir(workspace, projectId),
  };
}
