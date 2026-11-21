import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import YAML from 'yaml';

import { createPullRequest, findOpenPullRequests, manualPullRequestUrl } from '../../src/adapters/bitbucket/api.js';
import { createTransport } from '../../src/core/auth.js';
import { AutoDevError } from '../../src/core/errors.js';
import { parseManifest } from '../../src/core/manifest.js';
import { clearRegisteredSecrets } from '../../src/core/redact.js';
import { startMockServer } from '../../src/mocks/server.js';
import { expectCode, fullManifest, serviceEnv } from '../helpers.js';

/** @param {(m: Record<string, any>) => void} [mutate] */
function manifestWith(mutate) {
  const { manifest } = parseManifest(YAML.stringify(fullManifest()));
  mutate?.(manifest);
  return manifest;
}

/**
 * A scripted transport: each handler receives the request and returns a body or throws.
 * @param {(request: any) => any} handle
 */
function fakeTransport(handle) {
  /** @type {any[]} */
  const requests = [];
  return {
    requests,
    mode: /** @type {'token'} */ ('token'),
    service: 'bitbucket',
    baseUrl: 'https://bitbucket.example.internal',
    request: async (/** @type {any} */ request) => {
      requests.push(request);
      const body = await handle(request);
      return { status: 200, body, text: JSON.stringify(body) };
    },
    close: async () => {},
  };
}

const PR = { sourceBranch: 'feature/S-01001-loyalty', targetBranch: 'release/2.15', title: 'S-01001: loyalty discount', description: 'Story S-01001' };

describe('bitbucket api against the mock (server flavor)', () => {
  /** @type {Awaited<ReturnType<typeof startMockServer>>} */
  let server;
  /** @type {import('../../src/core/auth.js').Transport} */
  let transport;
  const manifest = manifestWith();
  const repo = manifest.repositories[0];

  before(async () => {
    server = await startMockServer();
    transport = await createTransport('bitbucket', manifest, { env: serviceEnv(server.baseUrl), useCredentialStore: false });
  });
  after(async () => {
    await transport?.close();
    await server?.close();
    clearRegisteredSecrets();
  });

  test('uses the token transport with a Bearer header', async () => {
    assert.equal(transport.mode, 'token');
    assert.deepEqual(await findOpenPullRequests(transport, manifest, repo, PR.sourceBranch), []);
  });

  test('creates a pull request with server-flavor refs and returns a normalized result', async () => {
    const result = await createPullRequest(transport, manifest, repo, PR);
    assert.equal(result.created, true);
    assert.equal(result.id, '1');
    assert.equal(result.title, PR.title);
    assert.equal(result.state, 'OPEN');
    assert.match(String(result.url), /\/projects\/ORD\/repos\/service-api\/pull-requests\/1$/);
    assert.equal(server.state.pullRequests.length, 1);
    const stored = server.state.pullRequests[0];
    assert.equal(stored.key, 'ORD');
    assert.equal(stored.slug, 'service-api');
    assert.equal(stored.fromRef.id, 'refs/heads/feature/S-01001-loyalty');
    assert.equal(stored.toRef.id, 'refs/heads/release/2.15');
    assert.equal(stored.description, PR.description);
  });

  test('returns the existing open PR instead of creating a duplicate', async () => {
    const again = await createPullRequest(transport, manifest, repo, { ...PR, title: 'a different title' });
    assert.equal(again.created, false);
    assert.equal(again.id, '1');
    assert.match(String(again.reason), /already open/);
    assert.equal(server.state.pullRequests.length, 1);
    const posts = server.state.requests.filter((request) => request.method === 'POST');
    assert.equal(posts.length, 1);
  });

  test('a different source branch gets its own PR; a declined PR does not block a new one', async () => {
    const other = await createPullRequest(transport, manifest, repo, { ...PR, sourceBranch: 'feature/S-01002-other' });
    assert.equal(other.created, true);
    assert.equal(other.id, '2');
    server.state.pullRequests[1].state = 'DECLINED';
    const reopened = await createPullRequest(transport, manifest, repo, { ...PR, sourceBranch: 'feature/S-01002-other' });
    assert.equal(reopened.created, true);
    assert.equal(server.state.pullRequests.length, 3);
  });

  test('repo.slug overrides the repository name in the REST path', async () => {
    const result = await createPullRequest(transport, manifest, { ...repo, slug: 'svc-api' }, { ...PR, sourceBranch: 'feature/S-01003-slug' });
    assert.equal(result.created, true);
    assert.equal(server.state.pullRequests.at(-1)?.slug, 'svc-api');
  });

  test('a POST is not retried on 503, and the adapter re-checks before failing', async () => {
    const before = server.state.pullRequests.length;
    const path = '/rest/api/1.0/projects/ORD/repos/service-api/pull-requests';
    server.state.faults.failNext[`POST ${path}`] = 1;
    const postsBefore = server.state.requests.filter((request) => request.method === 'POST').length;
    const error = await expectCode(
      () => createPullRequest(transport, manifest, repo, { ...PR, sourceBranch: 'feature/S-01004-fault' }),
      'UPSTREAM_ERROR',
    );
    assert.equal(error.details.status, 503);
    assert.equal(server.state.requests.filter((request) => request.method === 'POST').length, postsBefore + 1);
    assert.equal(server.state.pullRequests.length, before);
  });
});

describe('bitbucket api with a scripted transport', () => {
  const manifest = manifestWith();
  const repo = manifest.repositories[0];

  test('server flavor ignores PRs the server returns for other branches', async () => {
    const transport = fakeTransport(() => ({
      values: [
        { id: 7, title: 'other', state: 'OPEN', fromRef: { id: 'refs/heads/feature/other', displayId: 'feature/other' } },
        { id: 8, title: 'mine', state: 'OPEN', fromRef: { id: `refs/heads/${PR.sourceBranch}` }, links: { self: [{ href: 'https://bb/pr/8' }] } },
      ],
    }));
    const found = await findOpenPullRequests(transport, manifest, repo, PR.sourceBranch);
    assert.deepEqual(found, [{ id: '8', title: 'mine', url: 'https://bb/pr/8', state: 'OPEN' }]);
    const query = new URL(`https://x${transport.requests[0].path}`).searchParams;
    assert.equal(query.get('state'), 'OPEN');
    assert.equal(query.get('at'), `refs/heads/${PR.sourceBranch}`);
  });

  test('a body without values is treated as no open PRs', async () => {
    assert.deepEqual(await findOpenPullRequests(fakeTransport(() => null), manifest, repo, PR.sourceBranch), []);
  });

  test('when the create call fails but the PR is then found, it is returned as not-created', async () => {
    let gets = 0;
    const transport = fakeTransport((request) => {
      if (request.method === 'POST') throw new AutoDevError('TIMEOUT', 'lost response');
      gets += 1;
      return gets === 1 ? { values: [] } : { values: [{ id: 3, title: PR.title, state: 'OPEN', fromRef: { displayId: PR.sourceBranch } }] };
    });
    const result = await createPullRequest(transport, manifest, repo, PR);
    assert.equal(result.created, false);
    assert.equal(result.id, '3');
    assert.match(String(result.reason), /uncertain/);
  });

  test('when the create call fails and nothing is found, the original error is rethrown', async () => {
    const transport = fakeTransport((request) => {
      if (request.method === 'POST') throw new AutoDevError('ACCESS_DENIED', 'no write permission');
      return { values: [] };
    });
    await expectCode(() => createPullRequest(transport, manifest, repo, PR), 'ACCESS_DENIED');
    assert.equal(transport.requests.filter((request) => request.method === 'POST').length, 1);
  });

  test('cloud flavor uses the 2.0 API, branch names and html link', async () => {
    const cloud = manifestWith((m) => {
      m.bitbucket.flavor = 'cloud';
      m.bitbucket.projectKey = 'my-workspace';
    });
    const transport = fakeTransport((request) =>
      request.method === 'POST'
        ? { id: 12, title: PR.title, state: 'OPEN', links: { html: { href: 'https://bitbucket.org/my-workspace/service-api/pull-requests/12' } } }
        : { values: [] },
    );
    const result = await createPullRequest(transport, cloud, cloud.repositories[0], PR);
    assert.deepEqual(result, { id: '12', title: PR.title, url: 'https://bitbucket.org/my-workspace/service-api/pull-requests/12', state: 'OPEN', created: true });
    assert.match(transport.requests[0].path, /^\/2\.0\/repositories\/my-workspace\/service-api\/pullrequests\?q=/);
    const post = transport.requests[1];
    assert.equal(post.path, '/2.0/repositories/my-workspace/service-api/pullrequests');
    assert.deepEqual(post.body.source, { branch: { name: PR.sourceBranch } });
    assert.deepEqual(post.body.destination, { branch: { name: PR.targetBranch } });
    assert.equal(post.body.close_source_branch, false);
  });

  test('project key and slug are URL-encoded in the path but sent verbatim in the body', async () => {
    const odd = manifestWith((m) => {
      m.bitbucket.projectKey = 'A/B ?';
    });
    const transport = fakeTransport((request) => (request.method === 'POST' ? { id: 1, title: 't', state: 'OPEN' } : { values: [] }));
    const result = await createPullRequest(transport, odd, { name: 'svc', slug: '../x' }, PR);
    assert.equal(result.url, null);
    const post = transport.requests[1];
    assert.equal(post.path, '/rest/api/1.0/projects/A%2FB%20%3F/repos/..%2Fx/pull-requests');
    assert.equal(post.body.fromRef.repository.project.key, 'A/B ?');
    assert.equal(post.body.toRef.repository.slug, '../x');
  });
});

describe('bitbucket api: manual URL and configuration errors', () => {
  const manifest = manifestWith();
  const repo = manifest.repositories[0];

  test('manualPullRequestUrl builds the server create-PR link', () => {
    assert.equal(
      manualPullRequestUrl(manifest, repo, 'https://bitbucket.example.internal/', { sourceBranch: 'feature/S-1-x', targetBranch: 'release/2.15' }),
      'https://bitbucket.example.internal/projects/ORD/repos/service-api/pull-requests?create&sourceBranch=refs/heads/feature%2FS-1-x&targetBranch=refs/heads/release%2F2.15',
    );
  });

  test('manualPullRequestUrl builds the cloud link and encodes hostile branch text', () => {
    const cloud = manifestWith((m) => {
      m.bitbucket.flavor = 'cloud';
      m.bitbucket.projectKey = 'ws';
    });
    const url = manualPullRequestUrl(cloud, repo, 'https://ignored.example', { sourceBranch: 'a&dest=main#x', targetBranch: 'release/2.15' });
    assert.equal(url, 'https://bitbucket.org/ws/service-api/pull-requests/new?source=a%26dest%3Dmain%23x&dest=release%2F2.15');
  });

  test('NOT_CONFIGURED when bitbucket.flavor is missing', async () => {
    const noFlavor = manifestWith((m) => {
      m.bitbucket.flavor = null;
    });
    const transport = fakeTransport(() => ({ values: [] }));
    for (const call of [
      () => createPullRequest(transport, noFlavor, repo, PR),
      () => findOpenPullRequests(transport, noFlavor, repo, PR.sourceBranch),
      () => manualPullRequestUrl(noFlavor, repo, 'https://bb', PR),
    ]) {
      const error = await expectCode(call, 'NOT_CONFIGURED');
      assert.equal(error.details.field, 'bitbucket.flavor');
    }
    assert.equal(transport.requests.length, 0);
  });

  test('NOT_CONFIGURED when bitbucket.projectKey is missing or a placeholder', async () => {
    const transport = fakeTransport(() => ({ values: [] }));
    for (const value of [null, '', 'TODO', '<project key>']) {
      const noKey = manifestWith((m) => {
        m.bitbucket.projectKey = value;
      });
      const error = await expectCode(() => createPullRequest(transport, noKey, repo, PR), 'NOT_CONFIGURED');
      assert.equal(error.details.field, 'bitbucket.projectKey');
    }
    assert.equal(transport.requests.length, 0);
  });
});
