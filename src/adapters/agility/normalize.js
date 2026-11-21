/**
 * Turning Agility REST assets into the one story shape the rest of the
 * framework uses. The API path and the browser path both feed this module, so
 * both return identical structures.
 */

import { AutoDevError, ErrorCodes } from '../../core/errors.js';

/** Number prefix -> asset type. Prefixes are the Agility defaults. */
const PREFIX_TYPES = Object.freeze({ S: 'Story', B: 'Story', D: 'Defect', E: 'Epic' });

const WORKITEM_ID = /^([A-Z]{1,3})-(\d{1,9})$/;

/**
 * @param {string} workitemId e.g. "S-01234" or "D-00042"
 * @returns {{ id: string, assetType: string }}
 */
export function parseWorkitemId(workitemId) {
  const id = String(workitemId ?? '').trim().toUpperCase();
  const match = WORKITEM_ID.exec(id);
  const assetType = match && Object.hasOwn(PREFIX_TYPES, match[1]) ? PREFIX_TYPES[/** @type {keyof typeof PREFIX_TYPES} */ (match[1])] : undefined;
  if (!match || !assetType) {
    throw new AutoDevError(
      ErrorCodes.INVALID_ARGUMENT,
      `"${workitemId}" is not a recognised Agility number. Expected a story (S-/B-), defect (D-) or epic (E-) number such as S-01234.`,
    );
  }
  return { id, assetType };
}

/**
 * @param {any} asset
 * @param {string | null | undefined} name
 * @returns {any}
 */
export function attr(asset, name) {
  if (!name) return null;
  const value = asset?.Attributes?.[name]?.value;
  return value === undefined ? null : value;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function list(value) {
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(String).filter((item) => item.length > 0);
}

const ENTITIES = Object.freeze({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" });

/**
 * Rich-text fields arrive as HTML; reduce them to readable plain text.
 * @param {unknown} html
 * @returns {string}
 */
export function htmlToText(html) {
  if (html === null || html === undefined) return '';
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[/** @type {keyof typeof ENTITIES} */ (entity)])
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Attributes requested for a story or defect.
 * @param {Record<string, any>} manifest
 * @returns {string[]}
 */
export function storySelection(manifest) {
  const fields = manifest.agility.fields ?? {};
  return [
    'Name', 'Number', 'Description', 'Status.Name', 'Team.Name', 'Scope.Name', 'Timebox.Name',
    'Owners.Name', 'Estimate', 'Priority.Name', 'AssetState', 'ChangeDate',
    'Dependencies.Number', 'Dependants.Number',
    ...[fields.acceptanceCriteria, fields.releaseBranch].filter(Boolean),
  ];
}

/**
 * Work out which release branch the story names. A configured field wins;
 * otherwise a configured pattern is applied to the story text. When neither
 * yields a value the branch is null, and the caller treats that as a blocker.
 * @param {Record<string, any>} manifest
 * @param {any} asset
 * @param {string} text
 * @returns {{ releaseBranch: string | null, releaseBranchSource: string }}
 */
function findReleaseBranch(manifest, asset, text) {
  const field = manifest.agility.fields?.releaseBranch;
  const fromField = field ? htmlToText(attr(asset, field)) : '';
  if (fromField) return { releaseBranch: fromField, releaseBranchSource: `field ${field}` };
  const pattern = manifest.agility.releaseBranchPattern;
  if (pattern) {
    const match = new RegExp(pattern, 'im').exec(text);
    const branch = (match?.[1] ?? '').trim();
    if (branch) return { releaseBranch: branch, releaseBranchSource: 'pattern in story text' };
  }
  return { releaseBranch: null, releaseBranchSource: field || pattern ? 'not present in story' : 'not configured' };
}

/**
 * @param {any} asset one entry of the REST "Assets" array
 * @param {{ manifest: Record<string, any>, baseUrl: string, fetchedVia: 'api' | 'browser', comments?: any[], attachments?: any[] }} context
 */
export function normalizeStory(asset, context) {
  const { manifest, baseUrl } = context;
  const fields = manifest.agility.fields ?? {};
  const oid = String(asset?.id ?? '');
  const number = String(attr(asset, 'Number') ?? '');
  const description = htmlToText(attr(asset, 'Description'));
  const acceptanceCriteria = fields.acceptanceCriteria ? htmlToText(attr(asset, fields.acceptanceCriteria)) : '';
  const base = baseUrl.replace(/\/+$/, '');

  return {
    id: number,
    oid,
    type: oid.split(':')[0] || null,
    title: String(attr(asset, 'Name') ?? ''),
    description,
    acceptanceCriteria: acceptanceCriteria || null,
    acceptanceCriteriaSource: fields.acceptanceCriteria ? `field ${fields.acceptanceCriteria}` : 'not configured',
    status: attr(asset, 'Status.Name'),
    priority: attr(asset, 'Priority.Name'),
    team: attr(asset, 'Team.Name'),
    project: attr(asset, 'Scope.Name'),
    sprint: attr(asset, 'Timebox.Name'),
    owners: list(attr(asset, 'Owners.Name')),
    estimate: attr(asset, 'Estimate'),
    changedAt: attr(asset, 'ChangeDate'),
    ...findReleaseBranch(manifest, asset, `${description}\n${acceptanceCriteria}`),
    dependencies: {
      upstream: list(attr(asset, 'Dependencies.Number')),
      downstream: list(attr(asset, 'Dependants.Number')),
    },
    comments: (context.comments ?? []).map((comment) => ({
      author: attr(comment, 'Author.Name'),
      createdAt: attr(comment, 'AuthoredAt'),
      text: htmlToText(attr(comment, 'Content')),
    })),
    attachments: (context.attachments ?? []).map((attachment) => {
      const attachmentOid = String(attachment?.id ?? '');
      return {
        oid: attachmentOid,
        name: attr(attachment, 'Name'),
        filename: attr(attachment, 'Filename'),
        contentType: attr(attachment, 'ContentType'),
        url: `${base}/attachment.img/${attachmentOid.split(':')[1] ?? ''}`,
      };
    }),
    url: `${base}/assetdetail.v1?Number=${encodeURIComponent(number)}`,
    fetchedVia: context.fetchedVia,
    fetchedAt: new Date().toISOString(),
  };
}
