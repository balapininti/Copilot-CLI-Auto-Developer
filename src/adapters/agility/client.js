/**
 * Digital.ai Agility adapter (REST endpoint rest-1.v1, JSON).
 *
 * Every function takes a Transport from core/auth.js, so the same code runs
 * with an API token or through the user's signed-in browser profile and
 * returns the same shapes either way.
 *
 * Status: written against the documented rest-1.v1 contract and exercised
 * against the local mock. Custom fields, status names and scopes differ per
 * instance; run `autodev agility verify` against your instance before relying
 * on it, and see docs/unsupported.md.
 */

import { AutoDevError, ErrorCodes } from '../../core/errors.js';
import { isMissing } from '../../core/manifest.js';
import { attr, normalizeStory, parseWorkitemId, storySelection } from './normalize.js';

const DATA = '/rest-1.v1/Data';

/**
 * @param {string} assetType
 * @param {Record<string, string | number | undefined>} query
 */
function dataPath(assetType, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return `${DATA}/${assetType}?${params.toString()}`;
}

/**
 * Quote a value for a rest-1.v1 `where` clause.
 * @param {string} value
 */
function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * @param {any} body
 * @returns {any[]}
 */
function assetsOf(body) {
  if (body && Array.isArray(body.Assets)) return body.Assets;
  throw new AutoDevError(
    ErrorCodes.UPSTREAM_ERROR,
    'Agility returned a response that is not a rest-1.v1 asset list. The instance may use a different API version.',
    { details: { received: typeof body } },
  );
}

/**
 * Read-only access check: who am I?
 * @param {import('../../core/auth.js').Transport} transport
 */
export async function verifyAccess(transport) {
  const response = await transport.request({ path: dataPath('Member', { where: "IsSelf='true'", sel: 'Name,Username' }) });
  const me = assetsOf(response.body)[0];
  return { verified: true, mode: transport.mode, member: attr(me, 'Name'), checkedAt: new Date().toISOString() };
}

/**
 * Teams and team rooms the signed-in account can see.
 * @param {import('../../core/auth.js').Transport} transport
 */
export async function listBoards(transport) {
  const [rooms, teams] = await Promise.all([
    transport.request({ path: dataPath('TeamRoom', { sel: 'Name,Team.Name', page: '200,0' }) }),
    transport.request({ path: dataPath('Team', { sel: 'Name', page: '200,0' }) }),
  ]);
  return {
    boards: assetsOf(rooms.body).map((room) => ({
      boardId: String(room.id).split(':')[1] ?? String(room.id),
      oid: room.id,
      name: attr(room, 'Name'),
      team: attr(room, 'Team.Name'),
    })),
    teams: assetsOf(teams.body).map((team) => ({ oid: team.id, name: attr(team, 'Name') })),
    fetchedVia: transport.mode === 'token' ? 'api' : 'browser',
  };
}

/**
 * Read a story or defect with its comments and attachments.
 * @param {import('../../core/auth.js').Transport} transport
 * @param {Record<string, any>} manifest
 * @param {string} workitemId
 */
export async function readStory(transport, manifest, workitemId) {
  const { id, assetType } = parseWorkitemId(workitemId);
  const response = await transport.request({
    path: dataPath(assetType, { where: `Number=${quote(id)}`, sel: storySelection(manifest).join(',') }),
  });
  const assets = assetsOf(response.body);
  if (assets.length === 0) {
    throw new AutoDevError(
      ErrorCodes.NOT_FOUND,
      `Agility has no ${assetType.toLowerCase()} numbered ${id} that this account can see. It may not exist, or the account may lack access to its project.`,
      { details: { workitemId: id } },
    );
  }
  const asset = assets[0];
  const [comments, attachments] = await Promise.all([
    listComments(transport, asset.id),
    listAttachments(transport, asset.id),
  ]);
  return normalizeStory(asset, {
    manifest,
    baseUrl: transport.baseUrl,
    fetchedVia: transport.mode === 'token' ? 'api' : 'browser',
    comments,
    attachments,
  });
}

/**
 * @param {import('../../core/auth.js').Transport} transport
 * @param {string} assetOid e.g. "Story:1234"
 * @returns {Promise<any[]>}
 */
export async function listComments(transport, assetOid) {
  const response = await transport.request({
    path: dataPath('Expression', { where: `Mentions=${quote(assetOid)}`, sel: 'Content,Author.Name,AuthoredAt', sort: 'AuthoredAt' }),
  });
  return assetsOf(response.body);
}

/**
 * @param {import('../../core/auth.js').Transport} transport
 * @param {string} assetOid
 * @returns {Promise<any[]>}
 */
export async function listAttachments(transport, assetOid) {
  const response = await transport.request({
    path: dataPath('Attachment', { where: `Asset=${quote(assetOid)}`, sel: 'Name,Filename,ContentType' }),
  });
  return assetsOf(response.body);
}

/**
 * Find defects whose description carries an idempotency marker. This is how
 * the monitoring worker avoids raising the same incident twice, including
 * after a crash between "sent" and "recorded".
 * @param {import('../../core/auth.js').Transport} transport
 * @param {string} marker
 */
export async function findDefectsByMarker(transport, marker) {
  if (!/^[A-Za-z0-9:_-]{8,120}$/.test(marker)) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'Invalid idempotency marker.');
  }
  const response = await transport.request({
    path: dataPath('Defect', { find: marker, findin: 'Description', sel: 'Number,Name,Status.Name' }),
  });
  const base = transport.baseUrl.replace(/\/+$/, '');
  return assetsOf(response.body).map((asset) => ({
    id: String(attr(asset, 'Number')),
    oid: asset.id,
    title: attr(asset, 'Name'),
    status: attr(asset, 'Status.Name'),
    url: `${base}/assetdetail.v1?Number=${encodeURIComponent(String(attr(asset, 'Number')))}`,
  }));
}

/**
 * Create a defect. Callers must have passed the approval gate first; this
 * function only performs the write.
 * @param {import('../../core/auth.js').Transport} transport
 * @param {Record<string, any>} manifest
 * @param {{ title: string, descriptionHtml: string, idempotencyMarker: string }} draft
 */
export async function createDefect(transport, manifest, draft) {
  if (isMissing(manifest.agility.defectScope)) {
    throw new AutoDevError(ErrorCodes.NOT_CONFIGURED, 'agility.defectScope is not set, so there is nowhere to create the defect.', {
      details: { field: 'agility.defectScope' },
    });
  }
  const existing = await findDefectsByMarker(transport, draft.idempotencyMarker);
  if (existing.length > 0) return { ...existing[0], created: false, reason: 'A defect with this idempotency marker already exists.' };

  const response = await transport.request({
    method: 'POST',
    path: `${DATA}/Defect`,
    body: {
      Attributes: {
        Name: { value: draft.title, act: 'set' },
        Description: { value: draft.descriptionHtml, act: 'set' },
        Scope: { value: manifest.agility.defectScope, act: 'set' },
      },
    },
  });
  // The write is not retried blindly. Look the defect up by marker instead:
  // it gives the number, and proves the write landed exactly once.
  const created = await findDefectsByMarker(transport, draft.idempotencyMarker);
  if (created.length === 0) {
    throw new AutoDevError(
      ErrorCodes.UPSTREAM_ERROR,
      'Agility accepted the create request but the new defect could not be found afterwards. Check Agility before retrying.',
      { details: { status: response.status } },
    );
  }
  return { ...created[0], created: true };
}

/**
 * Add a conversation comment that mentions a workitem.
 * @param {import('../../core/auth.js').Transport} transport
 * @param {string} assetOid
 * @param {string} text
 */
export async function addComment(transport, assetOid, text) {
  if (!/^[A-Za-z]+:\d+$/.test(assetOid)) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'Invalid Agility asset OID.');
  const response = await transport.request({
    method: 'POST',
    path: `${DATA}/Expression`,
    body: {
      Attributes: {
        Content: { value: text, act: 'set' },
        Mentions: { value: [{ idref: assetOid, act: 'add' }] },
      },
    },
  });
  return { added: true, status: response.status };
}

/**
 * Set a workitem's status by status name.
 * @param {import('../../core/auth.js').Transport} transport
 * @param {string} assetOid
 * @param {string} statusName
 */
export async function setStatus(transport, assetOid, statusName) {
  const match = /^(Story|Defect):(\d+)$/.exec(assetOid);
  if (!match) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'Status can be set on a Story or Defect OID only.');
  const lookup = await transport.request({ path: dataPath('StoryStatus', { where: `Name=${quote(statusName)}`, sel: 'Name' }) });
  const statuses = assetsOf(lookup.body);
  if (statuses.length !== 1) {
    throw new AutoDevError(
      ErrorCodes.NOT_FOUND,
      `Expected exactly one Agility status named "${statusName}" but found ${statuses.length}.`,
    );
  }
  const response = await transport.request({
    method: 'POST',
    path: `${DATA}/${match[1]}/${match[2]}`,
    body: { Attributes: { Status: { value: statuses[0].id, act: 'set' } } },
  });
  return { updated: true, status: response.status, statusName };
}
