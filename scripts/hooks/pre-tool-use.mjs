#!/usr/bin/env node
// Copilot CLI preToolUse hook. Reads the tool call as JSON on stdin and denies
// calls that would bypass the framework's gates (see src/core/hook-policy.js).
//
// Deny is signalled both ways the CLI documents: a JSON decision on stdout and
// exit code 2. Allow is exit code 0 with no output.
import { evaluateToolCall } from '../../src/core/hook-policy.js';
import { AUTOMATION_ROOT, resolveWorkspace } from '../../src/core/workspace.js';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

/** @type {import('../../src/core/hook-policy.js').HookDecision} */
let decision;
try {
  decision = evaluateToolCall(JSON.parse(raw), {
    automationRoot: AUTOMATION_ROOT,
    workspaceRoot: resolveWorkspace().root,
  });
} catch {
  decision = { decision: 'deny', reason: 'The hook could not read the tool call, so it was refused.' };
}

if (decision.decision === 'deny') {
  process.stdout.write(`${JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: decision.reason })}\n`);
  process.stderr.write(`autodev hook: denied. ${decision.reason}\n`);
  process.exitCode = 2;
}
