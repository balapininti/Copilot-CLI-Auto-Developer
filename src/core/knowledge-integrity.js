/**
 * Integrity record for approved knowledge files.
 *
 *   state/learning/<project>/integrity.json   { "knowledge/<skill>/approved.md": "<sha256>" }
 *
 * Written only when an approved learning is applied. Anything that loads
 * knowledge checks the file against this record first.
 */

import path from 'node:path';

import { sha256 } from './hash.js';
import { readJson } from './state-store.js';
import { stateDirFor } from './workspace.js';

/**
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} projectId
 */
export function integrityFile(workspace, projectId) {
  return path.join(stateDirFor(workspace, 'learning', projectId), 'integrity.json');
}

/**
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} projectId
 * @returns {Record<string, string>}
 */
export function readIntegrity(workspace, projectId) {
  return readJson(integrityFile(workspace, projectId), /** @type {Record<string, string>} */ ({}));
}

/**
 * Is this knowledge file exactly what was approved?
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {string} relativePath e.g. "knowledge/db2/approved.md"
 * @param {string | Buffer} content
 */
export function isApprovedContent(workspace, projectId, relativePath, content) {
  return readIntegrity(workspace, projectId)[relativePath.split(path.sep).join('/')] === sha256(content);
}
