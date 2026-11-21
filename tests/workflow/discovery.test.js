import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { AUTOMATION_ROOT } from '../../src/core/workspace.js';
import {
  copilotHome, installUserLevel, listAgents, listSkills, parseFrontmatter, uninstallUserLevel, verifyDiscovery,
} from '../../src/workflow/discovery.js';
import { expectCode, removeDir, tempDir } from '../helpers.js';

// The agents and skills folders are fixed to this repository's .github (no
// root can be injected), so these tests are written to hold for whatever is
// in there, including nothing at all.

/** Relative paths install should copy, computed independently of installUserLevel. */
function expectedCopies() {
  const copies = listAgents().map((agent) => path.join('agents', path.basename(agent.file)));
  for (const skill of listSkills()) {
    const dir = path.dirname(skill.file);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) copies.push(path.join('skills', skill.name, path.relative(dir, path.join(entry.parentPath, entry.name))));
    }
  }
  return copies.sort();
}

/** @param {string} dir @returns {string[]} */
function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

describe('discovery: parseFrontmatter', () => {
  test('parses a YAML mapping and returns the body', () => {
    const parsed = parseFrontmatter('---\nname: db2\ndescription: Read-only DB2 access\ntools: ["shell"]\n---\n# Body\n\ntext\n');
    assert.equal(parsed.error, null);
    assert.deepEqual(parsed.frontmatter, { name: 'db2', description: 'Read-only DB2 access', tools: ['shell'] });
    assert.equal(parsed.body, '# Body\n\ntext\n');
  });

  test('accepts Windows line endings', () => {
    const parsed = parseFrontmatter('---\r\nname: db2\r\ndescription: d\r\n---\r\nbody\r\n');
    assert.equal(parsed.error, null);
    assert.equal(parsed.frontmatter?.name, 'db2');
    assert.equal(parsed.body, 'body\r\n');
  });

  test('accepts a file that ends right after the closing fence', () => {
    const parsed = parseFrontmatter('---\nname: x\n---');
    assert.equal(parsed.error, null);
    assert.equal(parsed.body, '');
  });

  test('a later --- line in the body does not extend the frontmatter', () => {
    const parsed = parseFrontmatter('---\nname: x\n---\nintro\n---\nmore\n');
    assert.deepEqual(parsed.frontmatter, { name: 'x' });
    assert.equal(parsed.body, 'intro\n---\nmore\n');
  });

  test('reports a missing frontmatter block and keeps the content as body', () => {
    for (const content of ['# Just markdown\n', '', ' ---\nname: x\n---\n', 'text\n---\nname: x\n---\n']) {
      const parsed = parseFrontmatter(content);
      assert.equal(parsed.frontmatter, null);
      assert.match(String(parsed.error), /No YAML frontmatter/);
      assert.equal(parsed.body, content);
    }
  });

  test('reports frontmatter that is not a mapping', () => {
    for (const block of ['- a\n- b', 'just a string', '42']) {
      const parsed = parseFrontmatter(`---\n${block}\n---\nbody\n`);
      assert.equal(parsed.frontmatter, null);
      assert.match(String(parsed.error), /not a YAML mapping/);
      assert.equal(parsed.body, 'body\n');
    }
  });

  test('reports invalid YAML without throwing', () => {
    const parsed = parseFrontmatter('---\nname: [unclosed\ndescription: "x\n---\nbody\n');
    assert.equal(parsed.frontmatter, null);
    assert.match(String(parsed.error), /not valid YAML/);
  });
});

describe('discovery: copilotHome', () => {
  test('uses COPILOT_HOME when set, resolved to an absolute path', () => {
    const dir = path.join('some', 'relative', 'home');
    assert.equal(copilotHome({ COPILOT_HOME: dir }), path.resolve(dir));
  });

  test('defaults to .copilot under the home folder', () => {
    assert.equal(path.basename(copilotHome({})), '.copilot');
    assert.ok(path.isAbsolute(copilotHome({})));
  });
});

describe('discovery: verifyDiscovery with an injected runner', () => {
  /** @type {string} */
  let home;
  beforeEach(() => { home = tempDir('autodev-copilot-home-'); });
  afterEach(() => removeDir(home));

  const notInstalled = async () => { throw Object.assign(new Error('not found'), { code: 'NOT_CONFIGURED' }); };

  test('missing required agents and skills are reported as problems', async () => {
    const report = await verifyDiscovery({
      required: { agents: ['zz-no-such-agent'], skills: ['zz-no-such-skill'] },
      runner: /** @type {any} */ (notInstalled),
      env: { COPILOT_HOME: home },
    });
    assert.equal(report.ok, false);
    assert.ok(report.problems.includes('Required agent "zz-no-such-agent" is missing.'));
    assert.ok(report.problems.includes('Required skill "zz-no-such-skill" is missing.'));
  });

  test('without the Copilot CLI it says discovery was not confirmed, and never claims it was', async () => {
    const report = await verifyDiscovery({ runner: /** @type {any} */ (notInstalled), env: { COPILOT_HOME: home } });
    assert.equal(report.copilotCli.installed, false);
    assert.equal(report.copilotCli.version, null);
    assert.equal(report.copilotCli.skillsSeen, null);
    assert.match(report.copilotCli.note, /not installed/);
    assert.equal(report.confirmedWithCli, false);
    assert.equal(report.locations.userLevel.home, home);
    assert.equal(report.locations.userLevel.installed, false);
    assert.equal(report.locations.repositoryLevel.agents, path.join(AUTOMATION_ROOT, '.github', 'agents'));
  });

  test('a non-zero exit from "copilot --version" is treated as not installed', async () => {
    const report = await verifyDiscovery({ runner: /** @type {any} */ (async () => ({ exitCode: 1, stdout: '', stderr: 'boom' })), env: { COPILOT_HOME: home } });
    assert.equal(report.copilotCli.installed, false);
    assert.equal(report.confirmedWithCli, false);
  });

  test('the runner is asked for the version and the skill list, from the automation folder, without a shell', async () => {
    /** @type {Array<{ command: string, args: string[], options: any }>} */
    const calls = [];
    const names = listSkills().map((skill) => skill.name);
    const runner = async (/** @type {string} */ command, /** @type {string[]} */ args, /** @type {any} */ options) => {
      calls.push({ command, args, options });
      return args[0] === '--version' ? { exitCode: 0, stdout: '1.2.3\nextra line\n' } : { exitCode: 0, stdout: names.map((name) => `  ${name}  (project)`).join('\n') };
    };
    const report = await verifyDiscovery({ runner: /** @type {any} */ (runner), env: { COPILOT_HOME: home } });
    assert.deepEqual(calls.map((call) => call.args), [['--version'], ['skill', 'list']]);
    assert.ok(calls.every((call) => call.command === (process.platform === 'win32' ? 'copilot.cmd' : 'copilot')));
    assert.ok(calls.every((call) => call.options.cwd === AUTOMATION_ROOT));
    assert.equal(report.copilotCli.installed, true);
    assert.equal(report.copilotCli.version, '1.2.3');
    assert.deepEqual(report.copilotCli.skillsSeen, names);
    assert.ok(!report.problems.some((problem) => /does not list/.test(problem)));
    assert.equal(report.confirmedWithCli, true);
  });

  test('a CLI that lists none of the skills produces a problem naming them (when the repo has skills)', async (t) => {
    const names = listSkills().map((skill) => skill.name);
    const runner = async (/** @type {string} */ _c, /** @type {string[]} */ args) =>
      args[0] === '--version' ? { exitCode: 0, stdout: '1.2.3\n' } : { exitCode: 0, stdout: names.map((name) => `x${name}-suffix`).join('\n') };
    const report = await verifyDiscovery({ runner: /** @type {any} */ (runner), env: { COPILOT_HOME: home } });
    assert.deepEqual(report.copilotCli.skillsSeen, []);
    if (names.length === 0) return t.skip('this repository has no skills under .github/skills yet');
    assert.equal(report.ok, false);
    assert.equal(report.confirmedWithCli, false);
    assert.ok(report.problems.some((problem) => /does not list these skills/.test(problem) && problem.includes(names[0])));
  });

  test('a CLI that rejects "skill list" is noted and not counted as confirmation', async () => {
    const runner = async (/** @type {string} */ _c, /** @type {string[]} */ args) =>
      args[0] === '--version' ? { exitCode: 0, stdout: '0.9.0\n' } : { exitCode: 2, stdout: '', stderr: 'unknown command' };
    const report = await verifyDiscovery({ runner: /** @type {any} */ (runner), env: { COPILOT_HOME: home } });
    assert.equal(report.copilotCli.installed, true);
    assert.equal(report.copilotCli.skillsSeen, null);
    assert.match(report.copilotCli.note, /did not accept/);
    assert.equal(report.confirmedWithCli, false);
  });

  test('every problem found in an agent or skill file is surfaced with its owner', async () => {
    const report = await verifyDiscovery({ runner: /** @type {any} */ (notInstalled), env: { COPILOT_HOME: home } });
    const expected = [
      ...listAgents().flatMap((agent) => agent.problems.map((problem) => `agent ${agent.id}: ${problem}`)),
      ...listSkills().flatMap((skill) => skill.problems.map((problem) => `skill ${skill.name}: ${problem}`)),
    ];
    for (const problem of expected) assert.ok(report.problems.includes(problem));
    assert.deepEqual(report.agents.map((agent) => agent.id), listAgents().map((agent) => agent.id));
    assert.deepEqual(report.skills.map((skill) => skill.name), listSkills().map((skill) => skill.name));
  });
});

describe('discovery: install and uninstall into a temporary COPILOT_HOME', () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let home;
  /** @type {NodeJS.ProcessEnv} */
  let env;
  beforeEach(() => {
    root = tempDir('autodev-copilot-');
    home = path.join(root, 'home');
    env = { COPILOT_HOME: home };
  });
  afterEach(() => removeDir(root));

  const manifestFile = () => path.join(home, 'autodev-install.json');

  test('dry run lists what would be copied and writes nothing', () => {
    const result = installUserLevel({ env, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.home, home);
    assert.deepEqual([.../** @type {any} */ (result).wouldCopy].sort(), expectedCopies());
    assert.equal(fs.existsSync(home), false);
  });

  test('install copies every agent and skill file byte for byte and records them', () => {
    const result = installUserLevel({ env });
    const copies = expectedCopies();
    assert.equal(result.dryRun, false);
    assert.equal(/** @type {any} */ (result).copied, copies.length);
    assert.deepEqual(filesUnder(home).filter((file) => file !== 'autodev-install.json'), copies);
    for (const agent of listAgents()) {
      assert.deepEqual(fs.readFileSync(path.join(home, 'agents', path.basename(agent.file))), fs.readFileSync(agent.file));
    }
    const manifest = JSON.parse(fs.readFileSync(manifestFile(), 'utf8'));
    assert.deepEqual([...manifest.files].sort(), copies);
    assert.equal(manifest.source, AUTOMATION_ROOT);
    assert.ok(!Number.isNaN(Date.parse(manifest.installedAt)));
  });

  test('installing twice is not a conflict with itself', () => {
    installUserLevel({ env });
    const again = installUserLevel({ env });
    assert.equal(/** @type {any} */ (again).copied, expectedCopies().length);
  });

  test('verifyDiscovery reports the user-level install once it exists', async () => {
    installUserLevel({ env });
    const report = await verifyDiscovery({ runner: /** @type {any} */ (async () => { throw new Error('none'); }), env });
    assert.equal(report.locations.userLevel.installed, true);
    assert.ok(report.locations.userLevel.installedAt);
  });

  test('files that belong to the user are never touched by install or uninstall', () => {
    const mine = path.join(home, 'agents', 'my-own.agent.md');
    const mySkill = path.join(home, 'skills', 'my-own-skill', 'SKILL.md');
    fs.mkdirSync(path.dirname(mine), { recursive: true });
    fs.mkdirSync(path.dirname(mySkill), { recursive: true });
    fs.writeFileSync(mine, 'mine');
    fs.writeFileSync(mySkill, 'mine too');
    installUserLevel({ env });
    const removed = uninstallUserLevel({ env });
    assert.equal(/** @type {any} */ (removed).removed, expectedCopies().length);
    assert.equal(fs.readFileSync(mine, 'utf8'), 'mine');
    assert.equal(fs.readFileSync(mySkill, 'utf8'), 'mine too');
    assert.equal(fs.existsSync(manifestFile()), false);
    assert.deepEqual(filesUnder(home), [path.join('agents', 'my-own.agent.md'), path.join('skills', 'my-own-skill', 'SKILL.md')]);
  });

  test('conflict: a pre-existing file with the same name is not replaced unless forced', async (t) => {
    const copies = expectedCopies();
    if (copies.length === 0) return t.skip('this repository has no agents or skills under .github yet, so nothing can conflict');
    const target = path.join(home, copies[0]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'the user wrote this');
    const error = await expectCode(() => installUserLevel({ env }), 'CONFLICT', /Nothing was changed/);
    assert.deepEqual(error.details.conflicts, [copies[0]]);
    assert.equal(fs.readFileSync(target, 'utf8'), 'the user wrote this');
    assert.equal(fs.existsSync(manifestFile()), false);
    assert.deepEqual(filesUnder(home), [copies[0]]);
    await expectCode(() => installUserLevel({ env, dryRun: true }), 'CONFLICT');
    installUserLevel({ env, force: true });
    assert.notEqual(fs.readFileSync(target, 'utf8'), 'the user wrote this');
  });

  test('a file from an earlier install that no longer ships is removed on reinstall', () => {
    const stale = path.join('agents', 'retired.agent.md');
    fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, stale), 'old');
    fs.writeFileSync(manifestFile(), JSON.stringify({ files: [stale] }));
    installUserLevel({ env });
    assert.equal(fs.existsSync(path.join(home, stale)), false);
    assert.ok(!JSON.parse(fs.readFileSync(manifestFile(), 'utf8')).files.includes(stale));
  });

  test('uninstall dry run removes nothing; uninstall with no install is a no-op', () => {
    assert.deepEqual(uninstallUserLevel({ env }), { dryRun: false, home, removed: 0 });
    installUserLevel({ env });
    const before = filesUnder(home);
    const dry = uninstallUserLevel({ env, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.deepEqual([.../** @type {any} */ (dry).wouldRemove].sort(), expectedCopies());
    assert.deepEqual(filesUnder(home), before);
  });

  test('a corrupt install record is reported, not treated as "nothing installed"', async () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(manifestFile(), '{ broken');
    await expectCode(() => uninstallUserLevel({ env }), 'INTEGRITY_VIOLATION');
    await expectCode(() => installUserLevel({ env }), 'INTEGRITY_VIOLATION');
  });

  test('install record entries that point outside COPILOT_HOME are never deleted', () => {
    const victim = path.join(root, 'victim.txt');
    const victim2 = path.join(root, 'victim2.txt');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(victim, 'keep me');
    fs.writeFileSync(victim2, 'keep me too');
    fs.writeFileSync(manifestFile(), JSON.stringify({ files: [path.join('..', 'victim.txt')] }));
    installUserLevel({ env }); // stale-file cleanup path
    fs.writeFileSync(manifestFile(), JSON.stringify({ files: [path.join('..', 'victim2.txt'), victim2] }));
    uninstallUserLevel({ env });
    assert.ok(fs.existsSync(victim), 'install deleted a file outside COPILOT_HOME');
    assert.ok(fs.existsSync(victim2), 'uninstall deleted a file outside COPILOT_HOME');
  });
});
