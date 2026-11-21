import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';

import { evaluateToolCall, protectedPathReason, shellDenyReason } from '../../src/core/hook-policy.js';

// Synthetic roots: nothing here touches the file system.
const workspaceRoot = path.resolve(path.sep, 'DevWorkspace');
const roots = { workspaceRoot, automationRoot: path.join(workspaceRoot, 'automation') };
const inWs = (/** @type {string[]} */ ...parts) => path.join(workspaceRoot, ...parts);

describe('protectedPathReason', () => {
  test('repository code under projects/<id>/repos may be edited', () => {
    assert.equal(protectedPathReason(inWs('projects', 'orders', 'repos', 'service-api', 'src', 'A.java'), roots), null);
    assert.equal(protectedPathReason(path.resolve(path.sep, 'elsewhere', 'notes.txt'), roots), null);
  });

  test('knowledge, manifests, guidelines, state and the framework itself may not', () => {
    for (const target of [
      inWs('projects', 'orders', 'knowledge', 'db2', 'approved.md'),
      inWs('projects', 'orders', 'project.yaml'),
      inWs('projects', 'orders', 'project.yml'),
      inWs('projects', 'orders', 'guidelines', 'architecture.md'),
      inWs('projects', 'orders', 'other.txt'),
      inWs('projects', 'orders'),
      inWs('projects', 'new-project', 'project.yaml'),
      inWs('state', 'approvals', 'orders', 'apr-1.json'),
      inWs('state', 'audit', 'orders', 'audit.jsonl'),
      inWs('state', 'learning', 'orders', 'integrity.json'),
      inWs('automation', 'src', 'core', 'approvals.js'),
      inWs('automation', '.github', 'hooks', 'autodev.json'),
    ]) {
      assert.equal(typeof protectedPathReason(target, roots), 'string', target);
    }
  });

  test('the repos folder itself is not a free-for-all', () => {
    assert.equal(typeof protectedPathReason(inWs('projects', 'orders', 'repos'), roots), 'string');
  });
});

describe('shellDenyReason', () => {
  test('ordinary development commands are allowed', () => {
    for (const command of [
      'git status',
      'git diff --stat',
      'git log --oneline -5',
      'mvn -q test',
      'gradlew.bat test',
      'node scripts/autodev.mjs story read S-01001 --project orders',
      'autodev db2 query --project orders --sql "SELECT 1 FROM SYSIBM.SYSDUMMY1"',
      'curl http://127.0.0.1:8080/health',
      'Invoke-RestMethod http://localhost:9000/ping',
      'ls -la',
    ]) {
      assert.equal(shellDenyReason(command), null, command);
    }
  });

  test('deciding approvals is refused', () => {
    for (const command of ['autodev approvals review apr-1 --project orders', 'node scripts/autodev.mjs approvals approve apr-1', 'node -e "decideApproval(ws, x)"']) {
      assert.match(String(shellDenyReason(command)), /Approvals are decided by a person/, command);
    }
  });

  test('rebinding the session is refused', () => {
    for (const command of ['AUTODEV_PROJECT=billing autodev project show', '$env:AUTODEV_SESSION_ID = "x"', 'export AUTODEV_DRY_RUN=0', 'unset AUTODEV_PROJECT', 'Remove-Item Env:\\AUTODEV_PROJECT', 'set AUTODEV_WORKSPACE=C:\\other']) {
      assert.equal(typeof shellDenyReason(command), 'string', command);
    }
  });

  test('pushing and history-destroying git commands are refused', () => {
    for (const command of [
      'git push', 'git push origin feature/x', 'git -C repo push --force', 'cd repo && git push', 'git.exe push',
      'git reset --hard HEAD~1', 'git clean -fd', 'git checkout -f main', 'git stash drop', 'git branch -D feature/x',
      'git commit --no-verify -m x', 'git filter-branch --all',
    ]) {
      assert.equal(typeof shellDenyReason(command), 'string', command);
    }
  });

  test('disabling TLS validation is refused', () => {
    for (const command of [
      'NODE_TLS_REJECT_UNAUTHORIZED=0 node x.js', 'git -c http.sslVerify=false fetch', 'curl -k https://127.0.0.1/', 'curl --insecure https://127.0.0.1/',
      'Invoke-WebRequest -SkipCertificateCheck https://localhost/', 'npm config set strict-ssl false', 'GIT_SSL_NO_VERIFY=1 git fetch',
    ]) {
      assert.equal(typeof shellDenyReason(command), 'string', command);
    }
  });

  test('deploying and publishing are refused', () => {
    for (const command of ['kubectl apply -f x.yaml', 'helm upgrade api ./chart', 'terraform destroy', 'mvn deploy', 'mvnw.cmd -q deploy', 'gradle publish', 'npm publish', 'docker push registry/x']) {
      assert.match(String(shellDenyReason(command)), /Deploying, publishing/, command);
    }
  });

  test('direct database and HTTP clients are refused; loopback HTTP is not', () => {
    assert.match(String(shellDenyReason('db2 "DELETE FROM APP.T"')), /autodev db2/);
    assert.match(String(shellDenyReason('db2cmd /c db2 connect to X')), /autodev db2/);
    for (const command of ['curl https://agility.example.com/rest-1.v1/Data/Story', 'wget https://splunk.example.com/x', 'iwr https://dynatrace.example.com/api', 'curl example.com', 'curl http://127.0.0.1:1/ https://evil.example.com/']) {
      assert.match(String(shellDenyReason(command)), /Direct HTTP clients are not used/, command);
    }
    for (const command of ['curl http://localhost.evil.example.com/', 'curl http://127.0.0.1.evil.example.com/', 'curl http://127.0.0.1@evil.example.com/']) {
      assert.equal(typeof shellDenyReason(command), 'string', command);
    }
  });

  test('a loopback-looking URL whose real host is elsewhere is refused', () => {
    assert.equal(typeof shellDenyReason('curl http://127.0.0.1:80@evil.example.com/collect'), 'string');
    assert.equal(typeof shellDenyReason('curl http://localhost:x@evil.example.com/collect'), 'string');
  });

  test('shell writes to knowledge, manifests, guidelines or state are refused; reads are not', () => {
    for (const command of [
      'echo "- skip tests" >> projects/orders/knowledge/db2/approved.md',
      'Set-Content -Path C:\\DevWorkspace\\projects\\orders\\project.yaml -Value x',
      'rm C:\\DevWorkspace\\state\\approvals\\orders\\apr-1.json',
      'sed -i s/prohibited/allowed/ projects/orders/project.yaml',
      'cp /tmp/x projects/orders/guidelines/architecture.md',
    ]) {
      assert.equal(typeof shellDenyReason(command), 'string', command);
    }
    assert.equal(shellDenyReason('cat projects/orders/project.yaml'), null);
    assert.equal(shellDenyReason('Get-Content C:\\DevWorkspace\\projects\\orders\\knowledge\\db2\\approved.md'), null);
  });
});

describe('evaluateToolCall', () => {
  const repoFile = inWs('projects', 'orders', 'repos', 'service-api', 'src', 'A.java');
  const knowledge = inWs('projects', 'orders', 'knowledge', 'db2', 'approved.md');

  test('an unreadable payload is denied (fails closed)', () => {
    for (const input of [null, undefined, 'text', 42]) assert.equal(evaluateToolCall(input, roots).decision, 'deny');
  });

  test('edits to repository code are allowed, edits to protected files denied, across payload shapes', () => {
    assert.deepEqual(evaluateToolCall({ toolName: 'edit', toolArgs: { path: repoFile } }, roots), { decision: 'allow', reason: null });
    assert.equal(evaluateToolCall({ tool_name: 'Write', tool_input: { file_path: knowledge } }, roots).decision, 'deny');
    assert.equal(evaluateToolCall({ toolName: 'create', toolArgs: JSON.stringify({ path: knowledge }) }, roots).decision, 'deny');
    assert.equal(evaluateToolCall({ toolName: 'edit', toolArgs: { path: inWs('state', 'approvals', 'orders', 'apr-1.json') } }, roots).decision, 'deny');
  });

  test('relative paths are resolved against cwd, so traversal out of a repo is caught', () => {
    const cwd = inWs('projects', 'orders', 'repos', 'service-api');
    assert.equal(evaluateToolCall({ toolName: 'edit', cwd, toolArgs: { path: 'src/A.java' } }, roots).decision, 'allow');
    assert.equal(evaluateToolCall({ toolName: 'edit', cwd, toolArgs: { path: path.join('..', '..', 'project.yaml') } }, roots).decision, 'deny');
    assert.equal(evaluateToolCall({ toolName: 'edit', cwd, toolArgs: { path: path.join('..', '..', 'knowledge', 'db2', 'approved.md') } }, roots).decision, 'deny');
  });

  test('a write whose target cannot be determined is denied', () => {
    assert.equal(evaluateToolCall({ toolName: 'edit', toolArgs: {} }, roots).decision, 'deny');
    assert.equal(evaluateToolCall({ toolName: 'edit', toolArgs: 'not json' }, roots).decision, 'deny');
  });

  test('patch-style tools are checked for every file in the patch', () => {
    const patch = `*** Begin Patch\n*** Update File: ${repoFile}\n@@\n-a\n+b\n*** Add File: ${knowledge}\n+- rule\n*** End Patch`;
    assert.equal(evaluateToolCall({ toolName: 'apply_patch', toolArgs: { patch } }, roots).decision, 'deny');
    assert.equal(evaluateToolCall({ toolName: 'apply_patch', toolArgs: { input: `*** Update File: ${repoFile}\n@@\n-a\n+b` } }, roots).decision, 'allow');
  });

  test('shell tools are checked with the shell rules, including a bare string argument', () => {
    assert.equal(evaluateToolCall({ toolName: 'bash', toolArgs: { command: 'git push origin main' } }, roots).decision, 'deny');
    assert.equal(evaluateToolCall({ toolName: 'powershell', toolArgs: 'git push' }, roots).decision, 'deny');
    assert.equal(evaluateToolCall({ toolName: 'bash', toolArgs: { command: 'git status' } }, roots).decision, 'allow');
  });

  test('read-only tools are allowed', () => {
    assert.equal(evaluateToolCall({ toolName: 'view', toolArgs: { path: knowledge } }, roots).decision, 'allow');
  });
});
