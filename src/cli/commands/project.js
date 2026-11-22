/**
 * Commands about the framework itself and about project identity:
 * doctor, discovery, onboarding, project, session, approvals, audit.
 */

import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

import { Actions, decideApproval, getApproval, listApprovals } from '../../core/approvals.js';
import { readAudit, verifyAudit } from '../../core/audit.js';
import { AutoDevError, ErrorCodes } from '../../core/errors.js';
import { runCommand } from '../../core/exec.js';
import {
  describeProject, getActiveProject, getRepositories, getSchemas, listProjectIds, loadGuidelines, resolveProject, selectProject, TASK_TYPES,
} from '../../core/project-context.js';
import { safeId } from '../../core/state-store.js';
import { AUTOMATION_ROOT } from '../../core/workspace.js';
import { installUserLevel, uninstallUserLevel, verifyDiscovery } from '../../workflow/discovery.js';
import { applyOnboarding, onboardProject, proposeOnboarding, QUESTIONS, readGuidelineDrafts } from '../../workflow/onboarding.js';
import { scanSources } from '../../workflow/onboarding-scan.js';

export const REQUIRED_AGENTS = ['auto-developer', 'incident-investigator'];
export const REQUIRED_SKILLS = [
  'project-context', 'agility', 'bitbucket', 'db2', 'java-spring', 'browser-playwright', 'testing', 'code-review', 'splunk',
  'dynatrace', 'authentication', 'learning-management', 'incident-correlation', 'root-cause-analysis', 'workflow-handoff', 'e2e-scenarios', 'onboarding',
];

/**
 * Approvals are decided by a person at a real terminal, never by an agent.
 * @param {import('../main.js').CommandContext} ctx
 */
function requireHuman(ctx) {
  if (ctx.env.AUTODEV_SESSION_ID || ctx.env.AUTODEV_PROJECT) {
    throw new AutoDevError(
      ErrorCodes.POLICY_PROHIBITED,
      'Approvals cannot be decided from inside an agent session. A person must run this command in a separate terminal that was not started by the launcher.',
    );
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new AutoDevError(
      ErrorCodes.POLICY_PROHIBITED,
      'Approvals can only be decided interactively at a terminal. This command was run without one.',
    );
  }
}

/**
 * The project an approval belongs to. A project that is being onboarded has
 * an approval request before it has a manifest, so that one case is resolved
 * from the approval itself.
 * @param {import('../main.js').CommandContext} ctx
 * @returns {string}
 */
function approvalProjectId(ctx) {
  try {
    return ctx.project().projectId;
  } catch (error) {
    if (!(error instanceof AutoDevError) || error.code !== ErrorCodes.PROJECT_NOT_FOUND || !ctx.flags.project || !ctx.args[0]) throw error;
    const id = safeId(String(ctx.flags.project), 'project id');
    let approval = null;
    try {
      approval = getApproval(ctx.workspace, id, ctx.args[0]);
    } catch {
      // no such approval: report the original problem
    }
    if (approval?.action !== Actions.PROJECT_ONBOARD) throw error;
    return id;
  }
}

/**
 * Read a JSON file named on the command line.
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
function readAnswers(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('it is not a JSON object');
    return parsed;
  } catch (error) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Could not read the answers file: ${/** @type {Error} */ (error).message}`);
  }
}

/**
 * @param {import('../../core/approvals.js').Approval} approval
 */
function publicView(approval) {
  return approval;
}

/**
 * @param {string} command
 * @param {string[]} args
 */
async function probe(command, args) {
  try {
    const result = await runCommand(command, args, { timeoutMs: 20_000 });
    return result.exitCode === 0 ? result.stdout.trim().split('\n')[0] : null;
  } catch {
    return null;
  }
}

/** @type {Record<string, import('../main.js').Command>} */
export const projectCommands = {
  doctor: {
    summary: 'Check prerequisites on this machine (Node, git, Copilot CLI, browser, TLS and proxy settings).',
    run: async (ctx) => {
      const windows = process.platform === 'win32';
      const major = Number(process.versions.node.split('.')[0]);
      const edgeCandidates = windows
        ? [`${ctx.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`, `${ctx.env.ProgramFiles ?? 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`]
        : ['/Applications/Microsoft Edge.app', '/usr/bin/microsoft-edge'];
      // @ts-ignore optional dependency
      const playwright = await import('playwright-core').then(() => 'installed', () => null);
      const checks = [
        { name: 'node', ok: major >= 22, found: process.versions.node, need: '22.12 or later' },
        { name: 'git', ok: Boolean(await probe('git', ['--version'])), found: await probe('git', ['--version']), need: 'any recent version' },
        { name: 'copilot-cli', ok: Boolean(await probe(windows ? 'copilot.cmd' : 'copilot', ['--version'])), found: await probe(windows ? 'copilot.cmd' : 'copilot', ['--version']), need: 'npm install -g @github/copilot (or winget install GitHub.Copilot)' },
        { name: 'powershell', ok: !windows || Boolean(await probe('pwsh', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'])), found: windows ? await probe('pwsh', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']) : 'not required on this OS', need: 'PowerShell 6 or later (Copilot CLI requirement on Windows)' },
        { name: 'playwright-core', ok: Boolean(playwright), found: playwright, need: 'npm install (optional dependency; uses the installed Edge)' },
        { name: 'microsoft-edge', ok: edgeCandidates.some((candidate) => fs.existsSync(candidate)), found: edgeCandidates.find((candidate) => fs.existsSync(candidate)) ?? null, need: 'Microsoft Edge, for browser sign-in' },
        { name: 'tls-validation', ok: ctx.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', found: ctx.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ? 'DISABLED' : 'enabled', need: 'never disabled' },
      ];
      return {
        ok: checks.filter((check) => ['node', 'git', 'tls-validation'].includes(check.name)).every((check) => check.ok),
        platform: `${process.platform} ${os.release()}`,
        automationRoot: AUTOMATION_ROOT,
        workspace: ctx.workspace.root,
        projects: listProjectIds(ctx.workspace),
        checks,
        network: {
          httpsProxy: ctx.env.HTTPS_PROXY || ctx.env.https_proxy ? 'set' : 'not set',
          nodeUseEnvProxy: ctx.env.NODE_USE_ENV_PROXY === '1' ? 'on' : 'off (set NODE_USE_ENV_PROXY=1 to make Node honour the proxy variables)',
          extraCaCerts: ctx.env.NODE_EXTRA_CA_CERTS ? 'set' : 'not set (set NODE_EXTRA_CA_CERTS to your corporate CA bundle if TLS errors occur)',
        },
      };
    },
  },

  'discovery verify': {
    summary: 'Check that agents, skills and hooks are valid and discoverable by Copilot CLI. --strict exits non-zero on problems.',
    usage: 'discovery verify [--strict]',
    run: async (ctx) => {
      const result = await verifyDiscovery({ required: { agents: REQUIRED_AGENTS, skills: REQUIRED_SKILLS }, env: ctx.env });
      if (ctx.flags.strict && !result.ok) {
        throw new AutoDevError(ErrorCodes.CONFIG_INVALID, 'Agents, skills or hooks are not valid or not discoverable.', { details: { problems: result.problems } });
      }
      return result;
    },
  },
  'discovery install': {
    summary: 'Copy agents and skills into the user-level Copilot folders so they work from any folder.',
    run: (ctx) => installUserLevel({ env: ctx.env, dryRun: ctx.dryRun, force: ctx.flags.force === true }),
  },
  'discovery uninstall': {
    summary: 'Remove what "discovery install" copied.',
    run: (ctx) => uninstallUserLevel({ env: ctx.env, dryRun: ctx.dryRun }),
  },

  'onboard-project': {
    summary: 'Create a project folder from interactive answers (or --answers <file.json>).',
    usage: 'onboard-project [--answers answers.json] [--dry-run]',
    run: async (ctx) => {
      if (!ctx.dryRun && (ctx.env.AUTODEV_SESSION_ID || ctx.env.AUTODEV_PROJECT)) {
        // This command writes the project straight away. From inside an agent
        // session a new project goes through a person's approval instead.
        throw new AutoDevError(
          ErrorCodes.POLICY_PROHIBITED,
          'Inside a session a project is created only after a person approves it. Use: autodev onboard propose --answers <file.json>',
        );
      }
      /** @type {Record<string, unknown>} */
      let answers = {};
      if (ctx.flags.answers) {
        answers = readAnswers(ctx.flags.answers);
      } else {
        if (!process.stdin.isTTY) {
          throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'Onboarding is interactive. Run it at a terminal, or pass --answers <file.json>.');
        }
        const prompt = readline.createInterface({ input: process.stdin, output: process.stderr });
        process.stderr.write('\nProject onboarding. Press Enter to skip any question; skipped answers are recorded as missing, never guessed.\nGive names of environment variables, not URLs or secrets.\n\n');
        try {
          for (const question of QUESTIONS) {
            const reply = (await prompt.question(`${question.prompt}${question.help ? `\n  (${question.help})` : ''}\n> `)).trim();
            if (reply === '') continue;
            answers[question.key] = question.kind === 'boolean' ? /^(y|yes|true)$/i.test(reply) : reply;
          }
        } finally {
          prompt.close();
        }
      }
      return onboardProject(ctx.workspace, answers, { dryRun: ctx.dryRun, env: ctx.env });
    },
  },

  'onboard scan': {
    summary: 'Read-only discovery for onboarding: git clones (remote, build tool, test commands) and hosts mentioned in documents under the given paths.',
    usage: 'onboard scan --path <file-or-folder> [--path ...]',
    run: (ctx) => scanSources(ctx.flags.path ?? []),
  },
  'onboard propose': {
    summary: 'Propose a new project from an answers file (and optional guideline drafts). Creates nothing until a person approves the exact files.',
    usage: 'onboard propose --answers <answers.json> [--guidelines <folder of drafted .md files>] [--source <what was read> ...]',
    run: (ctx) => {
      const active = getActiveProject(ctx.workspace, ctx.env);
      if (active.projectId) {
        throw new AutoDevError(
          ErrorCodes.PROJECT_SCOPE_VIOLATION,
          `This session is bound to project "${active.projectId}". Onboard a new project from a session started without -Project.`,
        );
      }
      return proposeOnboarding(ctx.workspace, {
        answers: readAnswers(ctx.need('answers')),
        guidelines: ctx.flags.guidelines ? readGuidelineDrafts(path.resolve(String(ctx.flags.guidelines))) : undefined,
        sources: Array.isArray(ctx.flags.source) ? ctx.flags.source : ctx.flags.source ? [ctx.flags.source] : [],
        env: ctx.env,
        dryRun: ctx.dryRun,
      });
    },
  },
  'onboard apply': {
    summary: 'Create the project a person approved. Writes exactly the approved files.',
    usage: 'onboard apply --approval <id> --project <new project id>',
    run: (ctx) => applyOnboarding(ctx.workspace, { projectId: ctx.need('project'), approvalId: ctx.need('approval'), dryRun: ctx.dryRun }),
  },

  'project list': {
    summary: 'List onboarded projects.',
    run: (ctx) => ({
      projects: listProjectIds(ctx.workspace).map((id) => {
        try {
          const info = describeProject(ctx.workspace, id);
          return { id, name: info.name, boardIds: info.boardIds, missingFields: info.missing.length };
        } catch (error) {
          return { id, invalid: /** @type {Error} */ (error).message };
        }
      }),
    }),
  },
  'project show': {
    summary: 'Show the scoped project: boards, repositories, schemas, services and policies.',
    run: (ctx) => describeProject(ctx.workspace, ctx.project().projectId),
  },
  'project validate': {
    summary: 'Validate project.yaml and list what onboarding still has to supply.',
    run: (ctx) => {
      const { projectId, missing } = ctx.project();
      return { projectId, valid: true, complete: missing.length === 0, missing };
    },
  },
  'project resolve': {
    summary: 'Find the project a board (and story) belongs to. Fails if none or more than one matches.',
    usage: 'project resolve --board <id> [--story <S-01234>] [--team <name>]',
    run: (ctx) => resolveProject(ctx.workspace, { boardId: ctx.flags.board, storyId: ctx.flags.story, teamName: ctx.flags.team }),
  },
  'project repos': {
    summary: 'Repositories mapped to the scoped project.',
    run: (ctx) => ({ repositories: getRepositories(ctx.workspace, ctx.project().projectId) }),
  },
  'project schemas': {
    summary: 'DB2 schemas mapped to the scoped project.',
    run: (ctx) => getSchemas(ctx.workspace, ctx.project().projectId),
  },
  'project guidelines': {
    summary: `Load guidelines and approved learnings for a task type (${TASK_TYPES.join(', ')}).`,
    usage: 'project guidelines --task <type>',
    run: (ctx) => loadGuidelines(ctx.workspace, ctx.project().projectId, ctx.need('task')),
  },

  'session status': {
    summary: 'Show which project this session is bound to.',
    run: (ctx) => getActiveProject(ctx.workspace, ctx.env),
  },
  'session select': {
    summary: 'Bind this session to one project. Cannot be changed within the session.',
    usage: 'session select --project <id>',
    run: (ctx) => selectProject(ctx.workspace, ctx.need('project'), ctx.env),
  },

  'approvals list': {
    summary: 'List approval requests for the scoped project.',
    usage: 'approvals list [--status pending|approved|denied|consumed|expired]',
    run: (ctx) => ({
      approvals: listApprovals(ctx.workspace, ctx.project().projectId, { status: ctx.flags.status }).map((approval) => {
        const { preview: _preview, ...rest } = publicView(approval);
        return rest;
      }),
    }),
  },
  'approvals show': {
    summary: 'Show one approval request, including the exact content awaiting approval.',
    usage: 'approvals show <approval-id>',
    run: (ctx) => {
      if (!ctx.args[0]) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'Usage: autodev approvals show <approval-id>');
      return publicView(getApproval(ctx.workspace, approvalProjectId(ctx), ctx.args[0]));
    },
  },
  'approvals review': {
    summary: 'INTERACTIVE, for a person: read an approval request and approve or deny it.',
    usage: 'approvals review <approval-id> --project <id>',
    run: async (ctx) => {
      requireHuman(ctx);
      if (!ctx.args[0]) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'Usage: autodev approvals review <approval-id> --project <id>');
      const projectId = approvalProjectId(ctx);
      const approval = getApproval(ctx.workspace, projectId, ctx.args[0]);
      if (approval.status !== 'pending') {
        throw new AutoDevError(ErrorCodes.CONFLICT, `Approval ${approval.id} is ${approval.status}, not pending.`);
      }
      const show = (/** @type {string} */ line) => process.stderr.write(`${line}\n`);
      show('');
      show(`Approval request ${approval.id}`);
      show(`  Project:   ${approval.projectId}`);
      show(`  Action:    ${approval.action}`);
      show(`  Summary:   ${approval.summary}`);
      show(`  Requested: ${approval.requestedAt} by ${approval.requestedBy}`);
      show(`  Expires:   ${approval.expiresAt}`);
      show('');
      show('Exact content that will be sent or written if you approve (secrets and personal data are masked in this view):');
      show('------------------------------------------------------------------------');
      for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (approval.preview ?? {}))) {
        show(`${key}:`);
        show(String(typeof value === 'string' ? value : JSON.stringify(value, null, 2)).split('\n').map((line) => `    ${line}`).join('\n'));
      }
      show('------------------------------------------------------------------------');
      // A fresh code for this review only. It is never stored, so it cannot be
      // read from the approval record or derived from the payload.
      const challenge = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join('');
      const prompt = readline.createInterface({ input: process.stdin, output: process.stderr });
      let reply;
      try {
        reply = (await prompt.question(`\nType ${challenge} to APPROVE, "deny" to deny, or anything else to leave it pending: `)).trim();
      } finally {
        prompt.close();
      }
      const decidedBy = os.userInfo().username;
      if (reply.toUpperCase() === challenge) {
        return publicView(await decideApproval(ctx.workspace, { projectId, id: approval.id, decision: 'approved', decidedBy }));
      }
      if (reply.toLowerCase() === 'deny') {
        return publicView(await decideApproval(ctx.workspace, { projectId, id: approval.id, decision: 'denied', decidedBy, reason: 'Denied at review.' }));
      }
      return { id: approval.id, status: 'pending', note: 'No decision recorded.' };
    },
  },

  'audit show': {
    summary: 'Show recent audit entries for the scoped project.',
    usage: 'audit show [--limit 50] [--action <prefix>]',
    run: (ctx) => ({
      entries: readAudit(ctx.workspace, ctx.project().projectId, { limit: Number(ctx.flags.limit ?? 50), action: ctx.flags.action }),
    }),
  },
  'audit verify': {
    summary: 'Verify the audit log has not been edited (hash chain).',
    run: (ctx) => verifyAudit(ctx.workspace, ctx.project().projectId),
  },
};
