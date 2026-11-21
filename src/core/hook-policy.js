/**
 * Decisions for the Copilot CLI preToolUse hook.
 *
 * The hook sits between the agent and its tools. It denies the tool calls that
 * would go around the framework's gates: editing approved knowledge, project
 * manifests or framework state; deciding approvals; pushing or rewriting git
 * history; calling project systems directly instead of through the autodev
 * CLI; disabling TLS validation; deploying or publishing.
 *
 * It is one layer of several. The gates themselves live in the CLI (approvals
 * bound to payload hashes, gate results bound to git trees, the knowledge
 * integrity record), and the strongest control remains least-privilege
 * credentials. See docs/security.md for the threat model.
 */

import path from 'node:path';

const WRITE_TOOLS = new Set(['edit', 'create', 'write', 'multiedit', 'str_replace_editor', 'apply_patch', 'notebookedit', 'str_replace', 'insert']);
const SHELL_TOOLS = new Set(['bash', 'shell', 'powershell', 'pwsh', 'execute', 'run_in_terminal', 'cmd']);

/** @type {Array<{ pattern: RegExp, reason: string }>} */
const SHELL_RULES = [
  {
    pattern: /\bapprovals\s+(review|approve|deny|decide)\b|\b(decideApproval|consumeApproval)\b/i,
    reason: 'Approvals are decided by a person in their own terminal, never by an agent.',
  },
  {
    // Assigning, exporting or removing the variables that bind the session.
    pattern: /\bAUTODEV_(SESSION_ID|PROJECT|WORKSPACE|DRY_RUN)\s*=|(\bunset\s+|Remove-Item\s+(-Path\s+)?Env:\\?|SetEnvironmentVariable\(\s*['"])AUTODEV_(SESSION_ID|PROJECT|WORKSPACE|DRY_RUN)\b/i,
    reason: 'The session\'s project binding, workspace and dry-run mode cannot be changed from inside the session.',
  },
  {
    pattern: /\bgit\b[^\n|;&]*\s(push|send-pack)(\s|$)/i,
    reason: 'Branches are pushed only by "autodev pr create", after tests, review and approval.',
  },
  {
    pattern: /\bgit\b[^\n|;&]*(\breset\s+--hard\b|\bclean\s+-[a-z]*[fdx]|\bcheckout\s+(-f|--force)\b|\bstash\s+(drop|clear)\b|\bbranch\s+-D\b|\bfilter-branch\b|\bupdate-ref\s+-d\b|--no-verify\b|--force\b|--force-with-lease\b)/i,
    reason: 'That git command can discard work or bypass checks. Uncommitted changes are never overwritten or reset.',
  },
  {
    pattern: /NODE_TLS_REJECT_UNAUTHORIZED|sslVerify\s*[= ]\s*false|GIT_SSL_NO_VERIFY|--insecure\b|-SkipCertificateCheck\b|\bcurl\b[^\n|;&]*\s-[a-zA-Z]*k\b|strict-ssl\s*[= ]\s*false|ServerCertificateValidationCallback/i,
    reason: 'TLS certificate validation must never be disabled. Install the corporate CA instead (docs/corporate-network.md).',
  },
  {
    pattern: /\b(kubectl|helm|terraform|oc)\b[^\n|;&]*\b(apply|delete|upgrade|install|rollout|scale|destroy|patch)\b|\bmvn(w|\.cmd)?\b[^\n|;&]*\b(deploy|release:perform)\b|\bgradlew?(\.bat)?\b[^\n|;&]*\bpublish\w*\b|\bnpm\s+publish\b|\bdocker\s+push\b/i,
    reason: 'Deploying, publishing and infrastructure changes are outside what the agents may do.',
  },
  {
    pattern: /(?<!autodev(\.mjs|\.ps1)?["']?)(^|[\s;&|(])(db2|db2cmd|db2cli|clpplus)(\.exe|\.bat)?\s/i,
    reason: 'Use "autodev db2 tables|describe|query" for database access; it is read-only, scoped and limited.',
  },
  {
    pattern: /\benv\s+(-u|--unset)\s*=?\s*AUTODEV_|\b(del|rm|Remove-Item|ri|Clear-Item|cli)\s+(-Path\s+)?Env:\\?AUTODEV_|\$env:AUTODEV_\w+\s*=|\bAUTODEV_\w+=\S*\s|--workspace\b/i,
    reason: 'The session\'s workspace, project binding and dry-run mode cannot be changed or bypassed from inside the session.',
  },
  {
    pattern: /Get-AutoDevCredential|Set-AutoDevCredential|\bcmdkey\b|\bsecurity\s+find-(generic|internet)-password|\bsecret-tool\b|CredRead|Get-StoredCredential|\bvaultcmd\b/i,
    reason: 'Secrets are read only by the autodev CLI, in memory. Agents never read the credential store.',
  },
  {
    pattern: /\bgit\b[^\n|;&]*\s(config|remote\s+(add|set-url|rename|remove|rm))(\s|$)/i,
    reason: 'Repository remotes and git configuration are not changed by agents; clones use the approved URL only.',
  },
];

const NETWORK_CLIENT = /(^|[\s;&|(])(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|http|https|Start-BitsTransfer)(\.exe)?\s/i;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** @param {string} raw */
function isLoopbackUrl(raw) {
  try {
    const url = new URL(raw);
    return !url.username && !url.password && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}
const ANY_URL = /https?:\/\/[^\s'"]+/gi;

const WRITE_VERB = /(>>?|\b(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|WriteAllText|writeFileSync|appendFileSync|unlinkSync|rmSync)\b|\bsed\s+-i|(^|[\s;&|(])(rm|del|erase|mv|move|cp|copy|tee|touch|truncate|ren|rmdir|rd|mkdir|md|echo|printf)\s)/i;
const PROTECTED_MENTION = /approved\.md|project\.ya?ml|[\\/]knowledge[\\/]|[\\/]guidelines[\\/]|[\\/]state[\\/](approvals|audit|learning|sessions|handoff|runs|incidents|monitor|evidence)\b|[\\/]\.github[\\/](hooks|agents|skills)[\\/]/i;

/**
 * @param {string} target absolute path
 * @param {string} root absolute path
 */
function isInside(target, root) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Why a file may not be written by the agent, or null when it may.
 * @param {string} target absolute path
 * @param {{ automationRoot: string, workspaceRoot: string }} roots
 * @returns {string | null}
 */
export function protectedPathReason(target, roots) {
  if (target.split(path.sep).includes('.git')) {
    return 'Git metadata (.git) is not edited directly; remotes, hooks and configuration stay as the user set them.';
  }
  const stateDir = path.join(roots.workspaceRoot, 'state');
  const projectsDir = path.join(roots.workspaceRoot, 'projects');
  if (isInside(target, roots.automationRoot)) {
    return 'The automation framework (agents, skills, hooks, scripts, source) is not edited by agents.';
  }
  if (isInside(target, stateDir)) {
    return 'Framework state (approvals, audit log, queues, gate results) is written only by the autodev CLI.';
  }
  if (isInside(target, projectsDir)) {
    const [projectId, area, ...rest] = path.relative(projectsDir, target).split(path.sep);
    if (!projectId || !area) return 'Project folders are created by onboarding, not by agents.';
    if (area === 'repos' && rest.length > 0) return null; // the code the agent is here to change
    if (area === 'knowledge') {
      return 'Learnings are saved only through "autodev learn propose" and a person\'s approval of the exact text.';
    }
    if (/^project\.ya?ml$/i.test(area)) {
      return 'project.yaml (mappings and policies) is maintained by people. Report what is missing instead of editing it.';
    }
    if (area === 'guidelines') {
      return 'Project guidelines are maintained by the team. Propose changes to the user instead of editing them.';
    }
    return 'Only the repositories under projects/<id>/repos are edited by agents.';
  }
  return null;
}

/**
 * Why a shell command is refused, or null when it may run.
 * @param {string} rawCommand
 * @returns {string | null}
 */
export function shellDenyReason(rawCommand) {
  // Quotes, carets and backticks can split a word without changing what the
  // shell runs (approvals "review", g^it push). Match on the text without them.
  const command = `${rawCommand}\n${String(rawCommand).replace(/["'`^]/g, '')}`;
  for (const rule of SHELL_RULES) {
    if (rule.pattern.test(command)) return rule.reason;
  }
  if (NETWORK_CLIENT.test(command)) {
    const urls = command.match(ANY_URL) ?? [];
    const onlyLoopback = urls.length > 0 && urls.every(isLoopbackUrl);
    if (!onlyLoopback) {
      return 'Call project systems through the autodev CLI, so project scoping, redaction, rate limits and approvals apply. Direct HTTP clients are not used.';
    }
  }
  if (PROTECTED_MENTION.test(command) && WRITE_VERB.test(command)) {
    return 'That command appears to modify knowledge, guidelines, a project manifest or framework state. Those are changed only through the autodev CLI or by a person.';
  }
  return null;
}

/**
 * @typedef {{ decision: 'allow' | 'deny', reason: string | null }} HookDecision
 */

/**
 * Decide on one tool call.
 * @param {unknown} input the hook payload from Copilot CLI
 * @param {{ automationRoot: string, workspaceRoot: string }} roots
 * @returns {HookDecision}
 */
export function evaluateToolCall(input, roots) {
  if (input === null || typeof input !== 'object') {
    return { decision: 'deny', reason: 'The hook could not read the tool call, so it was refused.' };
  }
  const payload = /** @type {Record<string, any>} */ (input);
  const toolName = String(payload.toolName ?? payload.tool_name ?? payload.tool ?? '').toLowerCase();
  let args = payload.toolArgs ?? payload.tool_input ?? payload.arguments ?? payload.args ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = SHELL_TOOLS.has(toolName) || /bash|powershell|pwsh|shell|terminal/.test(toolName) ? { command: args } : {};
    }
  }
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();

  // Includes the tools that send further input to a running shell (write_bash, write_powershell).
  const isShell = SHELL_TOOLS.has(toolName) || /bash|powershell|pwsh|shell|terminal/.test(toolName);
  if (isShell) {
    const command = [args?.command, args?.script, args?.cmd, args?.input, args?.text, args?.keys].filter((value) => typeof value === 'string').join('\n');
    const reason = shellDenyReason(command);
    return reason ? { decision: 'deny', reason } : { decision: 'allow', reason: null };
  }

  if (WRITE_TOOLS.has(toolName)) {
    const candidates = [args?.path, args?.file_path, args?.filePath, args?.target_file, args?.notebook_path].filter(
      (value) => typeof value === 'string' && value.length > 0,
    );
    // Patch-style tools carry their targets inside the patch text.
    const patch = typeof args?.patch === 'string' ? args.patch : typeof args?.input === 'string' ? args.input : '';
    for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) candidates.push(match[1].trim());
    if (candidates.length === 0) {
      return { decision: 'deny', reason: 'The hook could not tell which file this edit targets, so it was refused.' };
    }
    for (const candidate of candidates) {
      const reason = protectedPathReason(path.resolve(cwd, candidate), roots);
      if (reason) return { decision: 'deny', reason };
    }
  }
  return { decision: 'allow', reason: null };
}
