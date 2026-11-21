import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import YAML from 'yaml';

import * as agility from '../../src/adapters/agility/client.js';
import { attr, htmlToText, normalizeStory, parseWorkitemId, storySelection } from '../../src/adapters/agility/normalize.js';
import { createTransport } from '../../src/core/auth.js';
import { parseManifest } from '../../src/core/manifest.js';
import { clearRegisteredSecrets } from '../../src/core/redact.js';
import { asset, demoScenario, startMockServer } from '../../src/mocks/server.js';
import { expectCode, fullManifest, serviceEnv } from '../helpers.js';

/** @param {(m: Record<string, any>) => void} [mutate] */
function manifestWith(mutate) {
  const { manifest } = parseManifest(YAML.stringify(fullManifest()));
  mutate?.(manifest);
  return manifest;
}

/** @param {(request: any) => any} handle */
function fakeTransport(handle) {
  /** @type {any[]} */
  const requests = [];
  return {
    requests,
    mode: /** @type {'browser'} */ ('browser'),
    service: 'agility',
    baseUrl: 'https://agility.example.internal/Instance/',
    request: async (/** @type {any} */ request) => {
      requests.push(request);
      const body = await handle(request);
      return { status: 200, body, text: typeof body === 'string' ? body : JSON.stringify(body) };
    },
    close: async () => {},
  };
}

const MARKER = 'autodev-incident:abc123def456';
const draft = (marker = MARKER) => ({
  title: 'NullPointerException in orders-service',
  descriptionHtml: `<p>Pricing fails.</p><p>${marker}</p>`,
  idempotencyMarker: marker,
});

describe('agility adapter against the mock (read-only proof of concept)', () => {
  /** @type {Awaited<ReturnType<typeof startMockServer>>} */
  let server;
  /** @type {import('../../src/core/auth.js').Transport} */
  let transport;
  const manifest = manifestWith();

  before(async () => {
    const state = demoScenario(new Date('2026-01-15T12:00:00Z'));
    state.stories.push(
      asset('Story:1003', {
        Name: 'Story with a release branch field',
        Number: 'S-01003',
        Description: '<p>Release branch: release/from-text</p>',
        Custom_ReleaseBranch: '<p>release/3.0</p>',
        'Owners.Name': 'Solo Owner',
      }),
      asset('Story:1004', { Name: 'Story naming no branch', Number: 'S-01004', Description: '<p>Nothing useful.</p>' }),
    );
    server = await startMockServer(state);
    transport = await createTransport('agility', manifest, { env: serviceEnv(server.baseUrl), useCredentialStore: false });
  });
  after(async () => {
    await transport?.close();
    await server?.close();
    clearRegisteredSecrets();
  });

  test('verifyAccess reports the signed-in member through the token transport', async () => {
    const result = await agility.verifyAccess(transport);
    assert.equal(result.verified, true);
    assert.equal(result.mode, 'token');
    assert.equal(result.member, 'Mock User');
    assert.ok(!Number.isNaN(Date.parse(result.checkedAt)));
  });

  test('listBoards returns team rooms with numeric board ids, and teams', async () => {
    const result = await agility.listBoards(transport);
    assert.deepEqual(result.boards, [{ boardId: '501', oid: 'TeamRoom:501', name: 'Orders Team Room', team: 'Orders' }]);
    assert.deepEqual(result.teams, [{ oid: 'Team:77', name: 'Orders' }]);
    assert.equal(result.fetchedVia, 'api');
  });

  test('readStory returns the normalized story shape', async () => {
    const story = await agility.readStory(transport, manifest, 'S-01001');
    assert.equal(story.id, 'S-01001');
    assert.equal(story.oid, 'Story:1001');
    assert.equal(story.type, 'Story');
    assert.equal(story.title, 'Apply loyalty discount when pricing an order');
    assert.match(story.description, /^Orders for loyalty members must apply the member discount\.\nRelease branch: release\/2\.15$/);
    assert.equal(story.status, 'Ready');
    assert.equal(story.priority, 'High');
    assert.equal(story.team, 'Orders');
    assert.equal(story.project, 'Orders Platform');
    assert.equal(story.sprint, 'Sprint 42');
    assert.deepEqual(story.owners, ['Mock User']);
    assert.equal(story.estimate, 3);
    assert.equal(story.url, `${server.baseUrl}/assetdetail.v1?Number=S-01001`);
    assert.equal(story.fetchedVia, 'api');
    assert.ok(!Number.isNaN(Date.parse(story.fetchedAt)));
  });

  test('readStory reads acceptance criteria from the configured custom field as plain text', async () => {
    const story = await agility.readStory(transport, manifest, 'S-01001');
    assert.equal(story.acceptanceCriteria, '- Loyalty members get the configured discount rate.\n- Non-members are priced as before.');
    assert.equal(story.acceptanceCriteriaSource, 'field Custom_AcceptanceCriteria');
  });

  test('readStory takes the release branch from the story text via the configured pattern', async () => {
    const story = await agility.readStory(transport, manifest, 'S-01001');
    assert.equal(story.releaseBranch, 'release/2.15');
    assert.equal(story.releaseBranchSource, 'pattern in story text');
  });

  test('readStory prefers a configured release-branch field over the pattern', async () => {
    const withField = manifestWith((m) => {
      m.agility.fields.releaseBranch = 'Custom_ReleaseBranch';
    });
    const story = await agility.readStory(transport, withField, 'S-01003');
    assert.equal(story.releaseBranch, 'release/3.0');
    assert.equal(story.releaseBranchSource, 'field Custom_ReleaseBranch');
    assert.deepEqual(story.owners, ['Solo Owner']);
  });

  test('a field that is configured but empty falls back to the pattern; neither -> null, never a default', async () => {
    const withField = manifestWith((m) => {
      m.agility.fields.releaseBranch = 'Custom_ReleaseBranch';
    });
    const viaPattern = await agility.readStory(transport, withField, 'S-01001');
    assert.equal(viaPattern.releaseBranch, 'release/2.15');
    const none = await agility.readStory(transport, withField, 'S-01004');
    assert.equal(none.releaseBranch, null);
    assert.equal(none.releaseBranchSource, 'not present in story');
    assert.equal(none.acceptanceCriteria, null);
  });

  test('readStory returns comments, attachments and dependencies', async () => {
    const story = await agility.readStory(transport, manifest, 'S-01001');
    assert.equal(story.comments.length, 1);
    assert.equal(story.comments[0].author, 'Product Owner');
    assert.equal(story.comments[0].text, 'Discount rates live in APP.DISCOUNT.');
    assert.ok(!Number.isNaN(Date.parse(story.comments[0].createdAt)));
    assert.deepEqual(story.attachments, [
      { oid: 'Attachment:3001', name: 'Pricing rules', filename: 'pricing-rules.pdf', contentType: 'application/pdf', url: `${server.baseUrl}/attachment.img/3001` },
    ]);
    assert.deepEqual(story.dependencies, { upstream: [], downstream: ['S-01002'] });
  });

  test('comments and attachments of other stories are not attached to this one', async () => {
    const story = await agility.readStory(transport, manifest, 'S-01003');
    assert.deepEqual(story.comments, []);
    assert.deepEqual(story.attachments, []);
  });

  test('readStory is read-only: it issues GET requests only', async () => {
    const start = server.state.requests.length;
    await agility.readStory(transport, manifest, 's-01001 ');
    const made = server.state.requests.slice(start);
    assert.equal(made.length, 3);
    assert.ok(made.every((request) => request.method === 'GET'));
  });

  test('NOT_FOUND for a story that does not exist (nothing is invented)', async () => {
    const error = await expectCode(() => agility.readStory(transport, manifest, 'S-09999'), 'NOT_FOUND');
    assert.equal(error.details.workitemId, 'S-09999');
    await expectCode(() => agility.readStory(transport, manifest, 'D-00001'), 'NOT_FOUND', /defect/);
  });

  test('invalid workitem ids are rejected before any request is made', async () => {
    const start = server.state.requests.length;
    for (const bad of ['', '   ', '1001', 'S-', 'S01001', 'X-1', 'S-1234567890', "S-1' ; Number='S-01001", 'S-1;S-2', 'S-01001/../Member', '../S-1', 'ABCD-1', null, undefined, {}]) {
      await expectCode(() => agility.readStory(transport, manifest, /** @type {any} */ (bad)), 'INVALID_ARGUMENT');
    }
    assert.equal(server.state.requests.length, start);
  });

  test('createDefect creates once and is idempotent by marker', async () => {
    const first = await agility.createDefect(transport, manifest, draft());
    assert.equal(first.created, true);
    assert.equal(first.id, 'D-00001');
    assert.equal(first.oid, 'Defect:9000');
    assert.equal(first.status, 'New');
    assert.equal(first.url, `${server.baseUrl}/assetdetail.v1?Number=D-00001`);
    assert.equal(server.state.defects.length, 1);
    assert.equal(server.state.defects[0].Attributes.Scope.value, 'Scope:1');

    const second = await agility.createDefect(transport, manifest, { ...draft(), title: 'retry after a crash' });
    assert.equal(second.created, false);
    assert.equal(second.id, 'D-00001');
    assert.match(String(second.reason), /already exists/);
    assert.equal(server.state.defects.length, 1);
  });

  test('a different marker creates a different defect, readable as a workitem', async () => {
    const other = await agility.createDefect(transport, manifest, draft('autodev-incident:ffff0000eeee'));
    assert.equal(other.created, true);
    assert.equal(other.id, 'D-00002');
    const read = await agility.readStory(transport, manifest, 'D-00002');
    assert.equal(read.type, 'Defect');
    assert.match(read.description, /autodev-incident:ffff0000eeee/);
  });

  test('createDefect refuses an invalid marker and sends nothing', async () => {
    const start = server.state.requests.length;
    for (const marker of ['short', 'has spaces in it', "x' OR 1=1 --aaaa", 'a'.repeat(121), '']) {
      await expectCode(() => agility.createDefect(transport, manifest, draft(marker)), 'INVALID_ARGUMENT');
    }
    assert.equal(server.state.requests.length, start);
  });

  test('createDefect needs agility.defectScope', async () => {
    const start = server.state.requests.length;
    const noScope = manifestWith((m) => {
      m.agility.defectScope = null;
    });
    const error = await expectCode(() => agility.createDefect(transport, noScope, draft('autodev-incident:000011112222')), 'NOT_CONFIGURED');
    assert.equal(error.details.field, 'agility.defectScope');
    assert.equal(server.state.requests.length, start);
  });

  test('createDefect reports UPSTREAM_ERROR when the new defect cannot be found afterwards', async () => {
    const before = server.state.defects.length;
    const unmarked = { ...draft('autodev-incident:999988887777'), descriptionHtml: '<p>marker left out of the body</p>' };
    await expectCode(() => agility.createDefect(transport, manifest, unmarked), 'UPSTREAM_ERROR', /could not be found afterwards/);
    assert.equal(server.state.defects.length, before + 1);
  });

  test('the create POST is not retried when the server answers 503', async () => {
    const before = server.state.defects.length;
    server.state.faults.failNext['POST /rest-1.v1/Data/Defect'] = 1;
    const posts = () => server.state.requests.filter((request) => request.method === 'POST' && request.path === '/rest-1.v1/Data/Defect').length;
    const start = posts();
    await expectCode(() => agility.createDefect(transport, manifest, draft('autodev-incident:555566667777')), 'UPSTREAM_ERROR');
    assert.equal(posts(), start + 1);
    assert.equal(server.state.defects.length, before);
  });

  test('addComment validates the OID and adds a conversation entry', async () => {
    await expectCode(() => agility.addComment(transport, "Story:1001' OR", 'hi'), 'INVALID_ARGUMENT');
    await expectCode(() => agility.addComment(transport, 'S-01001', 'hi'), 'INVALID_ARGUMENT');
    const result = await agility.addComment(transport, 'Story:1003', 'Looks good.');
    assert.equal(result.added, true);
    const story = await agility.readStory(transport, manifest, 'S-01003');
    assert.deepEqual(story.comments.map((comment) => comment.text), ['Looks good.']);
  });

  test('setStatus resolves the status by name; unknown names and OIDs are refused', async () => {
    const result = await agility.setStatus(transport, 'Story:1001', 'Done');
    assert.deepEqual({ updated: result.updated, statusName: result.statusName }, { updated: true, statusName: 'Done' });
    assert.equal((await agility.readStory(transport, manifest, 'S-01001')).status, 'Done');
    await expectCode(() => agility.setStatus(transport, 'Story:1001', 'No Such Status'), 'NOT_FOUND', /found 0/);
    await expectCode(() => agility.setStatus(transport, 'Epic:5', 'Done'), 'INVALID_ARGUMENT');
    await expectCode(() => agility.setStatus(transport, 'Story:1001/../Member/20', 'Done'), 'INVALID_ARGUMENT');
  });
});

describe('agility adapter with a scripted transport', () => {
  const manifest = manifestWith();

  test('a response that is not a rest-1.v1 asset list -> UPSTREAM_ERROR', async () => {
    for (const body of [{}, { Assets: 'nope' }, [], null, '<html><body>Welcome</body></html>', { values: [] }]) {
      const transport = fakeTransport(() => body);
      const error = await expectCode(() => agility.readStory(transport, manifest, 'S-01001'), 'UPSTREAM_ERROR', /rest-1\.v1/);
      assert.equal(error.details.received, typeof body);
      await expectCode(() => agility.verifyAccess(transport), 'UPSTREAM_ERROR');
      await expectCode(() => agility.listBoards(transport), 'UPSTREAM_ERROR');
      await expectCode(() => agility.findDefectsByMarker(transport, MARKER), 'UPSTREAM_ERROR');
    }
  });

  test('the browser path yields the same shape, labelled fetchedVia "browser"', async () => {
    const transport = fakeTransport((request) =>
      request.path.startsWith('/rest-1.v1/Data/Story')
        ? { Assets: [asset('Story:9', { Number: 'S-00009', Name: 'Nine', Description: 'Release branch: release/9' })] }
        : { Assets: [] },
    );
    const story = await agility.readStory(transport, manifest, 'S-00009');
    assert.equal(story.fetchedVia, 'browser');
    assert.equal(story.releaseBranch, 'release/9');
    assert.equal(story.url, 'https://agility.example.internal/Instance/assetdetail.v1?Number=S-00009');
  });

  test('the story query quotes the number and selects the configured custom fields', async () => {
    const withField = manifestWith((m) => {
      m.agility.fields.releaseBranch = 'Custom_ReleaseBranch';
    });
    const transport = fakeTransport(() => ({ Assets: [] }));
    await expectCode(() => agility.readStory(transport, withField, 'b-00042'), 'NOT_FOUND');
    const url = new URL(`https://x${transport.requests[0].path}`);
    assert.equal(url.pathname, '/rest-1.v1/Data/Story');
    assert.equal(url.searchParams.get('where'), "Number='B-00042'");
    const selected = String(url.searchParams.get('sel')).split(',');
    assert.ok(selected.includes('Custom_AcceptanceCriteria') && selected.includes('Custom_ReleaseBranch') && selected.includes('Dependants.Number'));
    assert.deepEqual(storySelection(withField).slice(-2), ['Custom_AcceptanceCriteria', 'Custom_ReleaseBranch']);
  });
});

describe('agility normalize helpers', () => {
  test('parseWorkitemId maps prefixes to asset types and normalises case', () => {
    assert.deepEqual(parseWorkitemId(' s-01234 '), { id: 'S-01234', assetType: 'Story' });
    assert.deepEqual(parseWorkitemId('B-7'), { id: 'B-7', assetType: 'Story' });
    assert.deepEqual(parseWorkitemId('D-00042'), { id: 'D-00042', assetType: 'Defect' });
    assert.deepEqual(parseWorkitemId('E-1'), { id: 'E-1', assetType: 'Epic' });
  });

  test('parseWorkitemId does not resolve prototype property names as prefixes', async () => {
    for (const bad of ['__proto__-1', 'constructor-1', 'TOSTRING-1']) {
      await expectCode(() => parseWorkitemId(bad), 'INVALID_ARGUMENT');
    }
  });

  test('attr returns null for missing assets, attributes and names', () => {
    assert.equal(attr(null, 'Name'), null);
    assert.equal(attr({ Attributes: {} }, 'Name'), null);
    assert.equal(attr({ Attributes: { Name: { value: 0 } } }, 'Name'), 0);
    assert.equal(attr({ Attributes: { Name: { value: 'x' } } }, null), null);
  });

  test('htmlToText converts blocks, lists, breaks and entities', () => {
    assert.equal(htmlToText('<p>One</p><p>Two<br/>Three</p>'), 'One\nTwo\nThree');
    assert.equal(htmlToText('<ul><li>a</li><li class="x">b</li></ul>'), '- a\n- b');
    assert.equal(htmlToText('Tom&nbsp;&amp;&nbsp;Jerry &lt;b&gt; &quot;q&quot; &#39;s&#39;'), 'Tom & Jerry <b> "q" \'s\'');
    assert.equal(htmlToText('<h1>T</h1>\n\n\n\n<div>body   </div>'), 'T\n\nbody');
  });

  test('htmlToText drops script and style content and decodes entities only once', () => {
    assert.equal(htmlToText('a<script>alert("x")</script>b<STYLE>p{}</STYLE>c'), 'abc');
    assert.equal(htmlToText('&amp;lt;script&amp;gt;'), '&lt;script&gt;');
  });

  test('htmlToText handles null, undefined and non-strings', () => {
    assert.equal(htmlToText(null), '');
    assert.equal(htmlToText(undefined), '');
    assert.equal(htmlToText(42), '42');
    assert.equal(htmlToText(''), '');
  });

  test('normalizeStory reports unconfigured fields honestly and tolerates an empty asset', () => {
    const bare = manifestWith((m) => {
      m.agility.fields = {};
      m.agility.releaseBranchPattern = null;
    });
    const story = normalizeStory({}, { manifest: bare, baseUrl: 'https://a.example/', fetchedVia: 'api' });
    assert.equal(story.id, '');
    assert.equal(story.type, null);
    assert.equal(story.acceptanceCriteria, null);
    assert.equal(story.acceptanceCriteriaSource, 'not configured');
    assert.equal(story.releaseBranch, null);
    assert.equal(story.releaseBranchSource, 'not configured');
    assert.deepEqual(story.owners, []);
    assert.deepEqual(story.dependencies, { upstream: [], downstream: [] });
    assert.deepEqual(story.comments, []);
  });

  test('a release-branch pattern without a capture group yields null, not the whole match', () => {
    const noGroup = manifestWith((m) => {
      m.agility.releaseBranchPattern = 'Release branch:\\s*\\S+';
    });
    const story = normalizeStory(asset('Story:1', { Number: 'S-1', Description: 'Release branch: release/1' }), { manifest: noGroup, baseUrl: 'https://a.example', fetchedVia: 'api' });
    assert.equal(story.releaseBranch, null);
    assert.equal(story.releaseBranchSource, 'not present in story');
  });

  test('the pattern is also applied to the acceptance criteria text', () => {
    const manifest = manifestWith();
    const story = normalizeStory(
      asset('Story:1', { Number: 'S-1', Description: 'nothing', Custom_AcceptanceCriteria: '<p>release branch: release/ac</p>' }),
      { manifest, baseUrl: 'https://a.example', fetchedVia: 'api' },
    );
    assert.equal(story.releaseBranch, 'release/ac');
  });
});
