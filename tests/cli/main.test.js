import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { getApproval, requestApproval } from '../../src/core/approvals.js';
import { COMMANDS, main } from '../../src/cli/main.js';
import { fullManifest, removeDir, tempDir, tempWorkspace, writeProject } from '../helpers.js';

/**
 * Run the CLI with an explicit env and capture the single envelope it prints.
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 */
async function run(argv, env = {}) {
  /** @type {string[]} */
  const writes = [];
  // A launcher session always carries its workspace; mirror that here.
  const at = argv.indexOf('--workspace');
  const session = (env.AUTODEV_SESSION_ID || env.AUTODEV_PROJECT) && at >= 0 && !('AUTODEV_WORKSPACE' in env) ? { AUTODEV_WORKSPACE: argv[at + 1] } : {};
  const exitCode = await main(argv, { env: { AUTODEV_DISABLE_CREDENTIAL_STORE: '1', ...session, ...env }, stdout: (text) => { writes.push(text); } });
  assert.equal(writes.length, 1, `exactly one envelope must be printed, got ${writes.length}`);
  /** @type {any} */
  let envelope;
  assert.doesNotThrow(() => { envelope = JSON.parse(writes[0]); }, 'stdout must be one JSON document');
  assert.ok(writes[0].endsWith('\n'));
  assert.equal(typeof envelope.ok, 'boolean');
  assert.ok(envelope.meta && !Number.isNaN(Date.parse(envelope.meta.timestamp)));
  if (envelope.ok) assert.ok('data' in envelope && !('error' in envelope));
  else {
    assert.ok(!('data' in envelope));
    assert.deepEqual(Object.keys(envelope.error).sort(), ['code', 'details', 'message', 'retryable']);
  }
  return { exitCode, envelope, text: writes[0] };
}

describe('cli main', () => {
  const ws = tempWorkspace();
  const W = ['--workspace', ws.root];
  before(() => {
    writeProject(ws.workspace, fullManifest({ id: 'orders' }), { 'guidelines/architecture.md': '# Architecture\n' });
    writeProject(ws.workspace, { id: 'billing', agility: { boardIds: ['999'] } });
  });
  after(() => ws.cleanup());

  describe('help', () => {
    for (const argv of [[], ['help'], ['--help'], ['project', 'show', '--help']]) {
      test(`"${argv.join(' ') || '(no arguments)'}" prints help and exits 0`, async () => {
        const { exitCode, envelope } = await run(argv);
        assert.equal(exitCode, 0);
        assert.equal(envelope.ok, true);
        assert.equal(envelope.meta.command, 'help');
        assert.match(envelope.data.usage, /autodev <command>/);
        const listed = Object.keys(envelope.data.commands).map((name) => name.trim());
        assert.deepEqual(listed, Object.keys(COMMANDS).sort());
        assert.ok(listed.includes('demo e2e') && listed.includes('approvals review') && listed.includes('pr create'));
      });
    }

    test('help works even when no workspace or project exists', async () => {
      const { exitCode } = await run(['help'], { AUTODEV_WORKSPACE: path.join(ws.root, 'does-not-exist') });
      assert.equal(exitCode, 0);
    });
  });

  describe('usage errors exit 2', () => {
    test('unknown command', async () => {
      const { exitCode, envelope } = await run(['frobnicate']);
      assert.equal(exitCode, 2);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.error.code, 'INVALID_ARGUMENT');
      assert.match(envelope.error.message, /Unknown command "frobnicate"/);
      assert.equal(envelope.error.retryable, false);
    });

    test('unknown sub-command of a known group', async () => {
      const { exitCode, envelope } = await run(['project', 'explode', ...W]);
      assert.equal(exitCode, 2);
      assert.match(envelope.error.message, /Unknown command "project explode"/);
    });

    test('object-prototype names are not commands', async () => {
      for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        const { exitCode, envelope } = await run([name]);
        assert.equal(exitCode, 2, `${name} -> ${JSON.stringify(envelope)}`);
        assert.equal(envelope.error.code, 'INVALID_ARGUMENT');
      }
    });

    test('unknown option', async () => {
      const { exitCode, envelope } = await run(['project', 'list', '--no-such-flag']);
      assert.equal(exitCode, 2);
      assert.equal(envelope.error.code, 'INVALID_ARGUMENT');
    });

    test('a command that needs a project, with none given', async () => {
      const { exitCode, envelope } = await run(['project', 'show', ...W]);
      assert.equal(exitCode, 2);
      assert.equal(envelope.error.code, 'INVALID_ARGUMENT');
      assert.match(envelope.error.message, /--project/);
    });

    test('a project that is not onboarded', async () => {
      const { exitCode, envelope } = await run(['project', 'show', '--project', 'ghost', ...W]);
      assert.equal(exitCode, 2);
      assert.equal(envelope.error.code, 'PROJECT_NOT_FOUND');
    });

    test('a path-like project id is rejected before touching the filesystem', async () => {
      const { exitCode, envelope } = await run(['project', 'show', '--project', '../orders', ...W]);
      assert.equal(exitCode, 2);
      assert.equal(envelope.error.code, 'INVALID_ARGUMENT');
    });

    test('a missing required option names the option and the usage', async () => {
      const { exitCode, envelope } = await run(['project', 'guidelines', '--project', 'orders', ...W]);
      assert.equal(exitCode, 2);
      assert.match(envelope.error.message, /--task/);
      assert.match(envelope.error.message, /Usage: autodev project guidelines/);
    });

    test('a secret typed as a command name is masked in the error envelope', async () => {
      const { exitCode, text } = await run(['password=hunter2hunter2']);
      assert.equal(exitCode, 2);
      assert.ok(!text.includes('hunter2hunter2'));
    });
  });

  describe('successful commands', () => {
    test('project list shows both projects from the given workspace', async () => {
      const { exitCode, envelope } = await run(['project', 'list', ...W]);
      assert.equal(exitCode, 0);
      assert.deepEqual(envelope.data.projects.map((/** @type {any} */ p) => p.id), ['billing', 'orders']);
      assert.equal(envelope.meta.command, 'project list');
      assert.equal(envelope.meta.projectId, null);
      assert.equal(envelope.meta.dryRun, false);
      assert.equal(typeof envelope.meta.durationMs, 'number');
    });

    test('the workspace can come from AUTODEV_WORKSPACE', async () => {
      const { envelope } = await run(['project', 'list'], { AUTODEV_WORKSPACE: ws.root });
      assert.equal(envelope.data.projects.length, 2);
    });

    test('project show reports the scoped project in meta', async () => {
      const { exitCode, envelope } = await run(['project', 'show', '--project', 'orders', ...W]);
      assert.equal(exitCode, 0);
      assert.equal(envelope.meta.projectId, 'orders');
      assert.equal(envelope.data.id, 'orders');
      assert.deepEqual(envelope.data.schemas, ['APP', 'COMMON']);
      assert.equal(envelope.data.policies.productionChanges, 'prohibited');
    });

    test('project resolve maps a board to its project; unknown board exits 2', async () => {
      const found = await run(['project', 'resolve', '--board', '501', '--story', 'S-01001', ...W]);
      assert.equal(found.exitCode, 0);
      assert.deepEqual([found.envelope.data.projectId, found.envelope.data.storyId], ['orders', 'S-01001']);
      const none = await run(['project', 'resolve', '--board', '424242', ...W]);
      assert.equal(none.exitCode, 2);
      assert.equal(none.envelope.error.code, 'PROJECT_NOT_FOUND');
    });

    test('--dry-run and AUTODEV_DRY_RUN=1 are reflected in meta', async () => {
      assert.equal((await run(['project', 'list', '--dry-run', ...W])).envelope.meta.dryRun, true);
      assert.equal((await run(['project', 'list', ...W], { AUTODEV_DRY_RUN: '1' })).envelope.meta.dryRun, true);
    });

    test('onboard-project --dry-run from an answers file writes nothing', async () => {
      const dir = tempDir('autodev-answers-');
      try {
        const answers = path.join(dir, 'answers.json');
        fs.writeFileSync(answers, JSON.stringify({ id: 'newproj', name: 'New' }));
        const { exitCode, envelope } = await run(['onboard-project', '--answers', answers, '--dry-run', ...W]);
        assert.equal(exitCode, 0);
        assert.equal(envelope.data.dryRun, true);
        assert.ok(envelope.data.missing.length > 0);
        assert.equal(fs.existsSync(path.join(ws.workspace.projectsDir, 'newproj')), false);
        const bad = await run(['onboard-project', '--answers', path.join(dir, 'nope.json'), ...W]);
        assert.equal(bad.exitCode, 2);
      } finally {
        removeDir(dir);
      }
    });
  });

  describe('project scope (exit 4)', () => {
    test('AUTODEV_PROJECT that differs from --project is a scope violation', async () => {
      const { exitCode, envelope } = await run(['project', 'show', '--project', 'billing', ...W], { AUTODEV_PROJECT: 'orders' });
      assert.equal(exitCode, 4);
      assert.equal(envelope.error.code, 'PROJECT_SCOPE_VIOLATION');
      assert.deepEqual(envelope.error.details, { activeProject: 'orders', requested: 'billing' });
      assert.ok(!JSON.stringify(envelope).includes('"boardIds"'), 'nothing about the other project may be returned');
    });

    test('scope violation applies to every project-scoped command, not just "project show"', async () => {
      for (const argv of [['project', 'schemas'], ['project', 'repos'], ['approvals', 'list'], ['audit', 'show'], ['learn', 'verify'], ['incident', 'list'], ['handoff', 'list'], ['run', 'show', '--story', 'S-1']]) {
        const { exitCode, envelope } = await run([...argv, '--project', 'billing', ...W], { AUTODEV_PROJECT: 'orders' });
        assert.equal(exitCode, 4, `${argv.join(' ')} -> ${JSON.stringify(envelope.error ?? envelope.data)}`);
        assert.equal(envelope.error.code, 'PROJECT_SCOPE_VIOLATION');
      }
    });

    test('inside a session --workspace cannot point at a different workspace', async () => {
      const other = tempWorkspace();
      try {
        writeProject(other.workspace, { id: 'orders', policies: { createPR: 'allowed' } });
        for (const env of [{ AUTODEV_PROJECT: 'orders', AUTODEV_WORKSPACE: ws.root }, { AUTODEV_SESSION_ID: 'sess-ws', AUTODEV_WORKSPACE: ws.root }, { AUTODEV_PROJECT: 'orders' }]) {
          const { exitCode, envelope } = await run(['project', 'show', '--project', 'orders', '--workspace', other.root], { AUTODEV_WORKSPACE: '', ...env });
          assert.equal(exitCode, 4, JSON.stringify(envelope));
          assert.equal(envelope.error.code, 'PROJECT_SCOPE_VIOLATION');
        }
      } finally {
        other.cleanup();
      }
    });

    test('AUTODEV_PROJECT alone scopes the command; a matching --project is accepted', async () => {
      const implicit = await run(['project', 'show', ...W], { AUTODEV_PROJECT: 'orders' });
      assert.equal(implicit.exitCode, 0);
      assert.equal(implicit.envelope.meta.projectId, 'orders');
      assert.equal((await run(['project', 'show', '--project', 'orders', ...W], { AUTODEV_PROJECT: 'orders' })).exitCode, 0);
    });

    test('a session can be bound once; a second project is refused and commands stay scoped', async () => {
      const env = { AUTODEV_SESSION_ID: 'sess-cli-1' };
      const unbound = await run(['project', 'show', '--project', 'orders', ...W], env);
      assert.equal(unbound.exitCode, 2);
      assert.equal(unbound.envelope.error.code, 'NOT_CONFIGURED');

      const first = await run(['session', 'select', '--project', 'orders', ...W], env);
      assert.equal(first.exitCode, 0);
      assert.equal(first.envelope.data.alreadySelected, false);
      const again = await run(['session', 'select', '--project', 'orders', ...W], env);
      assert.equal(again.envelope.data.alreadySelected, true);

      const second = await run(['session', 'select', '--project', 'billing', ...W], env);
      assert.equal(second.exitCode, 4);
      assert.equal(second.envelope.error.code, 'PROJECT_SCOPE_VIOLATION');

      const status = await run(['session', 'status', ...W], env);
      // The key name "sessionId" is masked by output redaction; project and source are what matter here.
      assert.equal(status.envelope.data.projectId, 'orders');
      assert.equal(status.envelope.data.source, 'session');
      assert.equal((await run(['project', 'schemas', '--project', 'billing', ...W], env)).exitCode, 4);
      assert.equal((await run(['project', 'schemas', ...W], env)).exitCode, 0);
    });

    test('NODE_TLS_REJECT_UNAUTHORIZED=0 refuses every command with exit 4', async () => {
      const { exitCode, envelope } = await run(['project', 'list', ...W], { NODE_TLS_REJECT_UNAUTHORIZED: '0' });
      assert.equal(exitCode, 4);
      assert.equal(envelope.error.code, 'TLS_POLICY_VIOLATION');
    });
  });

  describe('approvals review is for a person at a terminal', () => {
    /** @type {string} */
    let approvalId;
    before(async () => {
      approvalId = (await requestApproval(ws.workspace, { projectId: 'orders', action: 'bitbucket.createPullRequest', summary: 'Open a PR', payload: { title: 'x' } })).id;
    });

    test('refused inside an agent session (AUTODEV_SESSION_ID)', async () => {
      const { exitCode, envelope } = await run(['approvals', 'review', approvalId, '--project', 'orders', ...W], { AUTODEV_SESSION_ID: 'sess-agent' });
      assert.equal(exitCode, 4);
      assert.equal(envelope.error.code, 'POLICY_PROHIBITED');
      assert.match(envelope.error.message, /inside an agent session/);
      assert.equal(getApproval(ws.workspace, 'orders', approvalId).status, 'pending');
    });

    test('refused when the launcher fixed the project (AUTODEV_PROJECT)', async () => {
      const { exitCode, envelope } = await run(['approvals', 'review', approvalId, ...W], { AUTODEV_PROJECT: 'orders' });
      assert.equal(exitCode, 4);
      assert.equal(envelope.error.code, 'POLICY_PROHIBITED');
      assert.equal(getApproval(ws.workspace, 'orders', approvalId).status, 'pending');
    });

    test('refused without a TTY', async (t) => {
      if (process.stdin.isTTY && process.stdout.isTTY) return t.skip('this test process is attached to a terminal');
      const { exitCode, envelope } = await run(['approvals', 'review', approvalId, '--project', 'orders', ...W]);
      assert.equal(exitCode, 4);
      assert.equal(envelope.error.code, 'POLICY_PROHIBITED');
      assert.match(envelope.error.message, /interactively at a terminal/);
      assert.equal(getApproval(ws.workspace, 'orders', approvalId).status, 'pending');
    });

    test('approvals list and show never reveal the confirmation code', async () => {
      const challenge = getApproval(ws.workspace, 'orders', approvalId).challenge;
      const list = await run(['approvals', 'list', '--project', 'orders', ...W]);
      const show = await run(['approvals', 'show', approvalId, '--project', 'orders', ...W]);
      assert.equal(list.exitCode, 0);
      assert.equal(show.exitCode, 0);
      assert.equal(list.envelope.data.approvals.length, 1);
      assert.equal(show.envelope.data.id, approvalId);
      for (const { text } of [list, show]) {
        assert.ok(!text.includes('challenge'));
        assert.ok(!text.includes(challenge));
      }
    });

    test('there is no non-interactive command that approves', () => {
      const names = Object.keys(COMMANDS).filter((name) => name.startsWith('approvals'));
      assert.deepEqual(names.sort(), ['approvals list', 'approvals review', 'approvals show']);
    });

    test('another project cannot read this approval', async () => {
      const { exitCode, envelope } = await run(['approvals', 'show', approvalId, '--project', 'billing', ...W]);
      assert.equal(exitCode, 5);
      assert.equal(envelope.error.code, 'NOT_FOUND');
    });
  });

  test('demo e2e: both workflows pass end to end against local mocks', { timeout: 60_000 }, async () => {
    const envBefore = { ...process.env };
    const { exitCode, envelope } = await run(['demo', 'e2e']);
    const failed = envelope.ok ? envelope.data.failed : envelope.error.details.failed;
    assert.equal(exitCode, 0, `demo failed: ${JSON.stringify(failed, null, 2)}`);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.passed, true);
    assert.deepEqual(envelope.data.failed, []);
    assert.ok(envelope.data.checks.length >= 40, `only ${envelope.data.checks.length} checks ran`);
    assert.ok(envelope.data.checks.every((/** @type {any} */ check) => check.passed === true));
    const areas = new Set(envelope.data.checks.map((/** @type {any} */ check) => check.area));
    for (const area of ['project context', 'agility', 'repository', 'gates', 'pull request', 'db2 guard', 'monitoring', 'handoff', 'project isolation', 'learning', 'audit']) {
      assert.ok(areas.has(area), `demo area "${area}" did not run`);
    }
    assert.equal(envelope.data.workspace, '(removed)');
    assert.match(envelope.data.note, /does not verify any live corporate integration/);
    assert.deepEqual({ ...process.env }, envBefore, 'the demo must restore process.env');
  });
});
