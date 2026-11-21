/**
 * Bitbucket REST adapter: pull requests.
 *
 * Supports Bitbucket Data Center / Server (REST 1.0) and Bitbucket Cloud
 * (REST 2.0), selected by `bitbucket.flavor`. Pull request creation needs an
 * API token; there is deliberately no browser-driven creation. Without a
 * token the adapter returns a pre-filled URL for the user to open themselves.
 *
 * Status: written against the documented REST contracts and exercised against
 * the local mock; not yet verified against a live instance.
 */

import { AutoDevError, ErrorCodes } from '../../core/errors.js';
import { isMissing } from '../../core/manifest.js';

/**
 * @param {Record<string, any>} manifest
 * @param {Record<string, any>} repo
 */
function coordinates(manifest, repo) {
  if (isMissing(manifest.bitbucket.flavor)) {
    throw new AutoDevError(ErrorCodes.NOT_CONFIGURED, 'bitbucket.flavor (server or cloud) is not set.', { details: { field: 'bitbucket.flavor' } });
  }
  if (isMissing(manifest.bitbucket.projectKey)) {
    throw new AutoDevError(ErrorCodes.NOT_CONFIGURED, 'bitbucket.projectKey is not set.', { details: { field: 'bitbucket.projectKey' } });
  }
  const key = encodeURIComponent(manifest.bitbucket.projectKey);
  const slug = encodeURIComponent(repo.slug ?? repo.name);
  return manifest.bitbucket.flavor === 'cloud'
    ? { flavor: 'cloud', collection: `/2.0/repositories/${key}/${slug}/pullrequests`, key, slug }
    : { flavor: 'server', collection: `/rest/api/1.0/projects/${key}/repos/${slug}/pull-requests`, key, slug };
}

/**
 * @param {any} pr
 * @param {string} flavor
 */
function normalizePr(pr, flavor) {
  return flavor === 'cloud'
    ? { id: String(pr.id), title: pr.title, url: pr.links?.html?.href ?? null, state: pr.state }
    : { id: String(pr.id), title: pr.title, url: pr.links?.self?.[0]?.href ?? null, state: pr.state };
}

/**
 * Open pull requests from a source branch.
 * @param {import('../../core/auth.js').Transport} transport
 * @param {Record<string, any>} manifest
 * @param {Record<string, any>} repo
 * @param {string} sourceBranch
 */
export async function findOpenPullRequests(transport, manifest, repo, sourceBranch) {
  const at = coordinates(manifest, repo);
  if (at.flavor === 'cloud') {
    const q = encodeURIComponent(`source.branch.name="${sourceBranch}" AND state="OPEN"`);
    const response = await transport.request({ path: `${at.collection}?q=${q}` });
    return (response.body?.values ?? []).map((/** @type {any} */ pr) => normalizePr(pr, 'cloud'));
  }
  const query = new URLSearchParams({ state: 'OPEN', direction: 'OUTGOING', at: `refs/heads/${sourceBranch}` });
  const response = await transport.request({ path: `${at.collection}?${query}` });
  return (response.body?.values ?? [])
    .filter((/** @type {any} */ pr) => pr.fromRef?.displayId === sourceBranch || pr.fromRef?.id === `refs/heads/${sourceBranch}`)
    .map((/** @type {any} */ pr) => normalizePr(pr, 'server'));
}

/**
 * Create a pull request, or return the one already open for this branch.
 * Callers must have passed the approval gate; this function only writes.
 * @param {import('../../core/auth.js').Transport} transport
 * @param {Record<string, any>} manifest
 * @param {Record<string, any>} repo
 * @param {{ sourceBranch: string, targetBranch: string, title: string, description: string }} pr
 */
export async function createPullRequest(transport, manifest, repo, pr) {
  const at = coordinates(manifest, repo);
  const existing = await findOpenPullRequests(transport, manifest, repo, pr.sourceBranch);
  if (existing.length > 0) return { ...existing[0], created: false, reason: 'A pull request is already open for this branch.' };

  const body =
    at.flavor === 'cloud'
      ? {
          title: pr.title,
          description: pr.description,
          source: { branch: { name: pr.sourceBranch } },
          destination: { branch: { name: pr.targetBranch } },
          close_source_branch: false,
        }
      : {
          title: pr.title,
          description: pr.description,
          fromRef: { id: `refs/heads/${pr.sourceBranch}`, repository: { slug: decodeURIComponent(at.slug), project: { key: decodeURIComponent(at.key) } } },
          toRef: { id: `refs/heads/${pr.targetBranch}`, repository: { slug: decodeURIComponent(at.slug), project: { key: decodeURIComponent(at.key) } } },
        };
  try {
    const response = await transport.request({ method: 'POST', path: at.collection, body });
    return { ...normalizePr(response.body, at.flavor), created: true };
  } catch (error) {
    // A lost response or a concurrent run may have created it: check before failing.
    const now = await findOpenPullRequests(transport, manifest, repo, pr.sourceBranch).catch(() => []);
    if (now.length > 0) return { ...now[0], created: false, reason: 'Found after an uncertain create call.' };
    throw error;
  }
}

/**
 * A link that opens Bitbucket's "create pull request" page pre-filled, for
 * the case where no API token is available.
 * @param {Record<string, any>} manifest
 * @param {Record<string, any>} repo
 * @param {string} baseUrl
 * @param {{ sourceBranch: string, targetBranch: string }} pr
 */
export function manualPullRequestUrl(manifest, repo, baseUrl, pr) {
  const at = coordinates(manifest, repo);
  const base = baseUrl.replace(/\/+$/, '');
  const source = encodeURIComponent(pr.sourceBranch);
  const target = encodeURIComponent(pr.targetBranch);
  return at.flavor === 'cloud'
    ? `https://bitbucket.org/${at.key}/${at.slug}/pull-requests/new?source=${source}&dest=${target}`
    : `${base}/projects/${at.key}/repos/${at.slug}/pull-requests?create&sourceBranch=refs/heads/${source}&targetBranch=refs/heads/${target}`;
}
