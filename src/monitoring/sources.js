/**
 * Live sources for the monitoring worker: the real adapters, connected lazily
 * so a pass only authenticates to the services it actually needs. The worker
 * runs unattended, so sign-in is never interactive here.
 */

import * as agility from '../adapters/agility/client.js';
import { recentCommits } from '../adapters/bitbucket/git.js';
import * as dynatrace from '../adapters/dynatrace/client.js';
import * as splunk from '../adapters/splunk/client.js';
import { createTransport } from '../core/auth.js';
import { createRateLimiter } from '../core/http.js';
import { isMissing } from '../core/manifest.js';

/**
 * @param {Record<string, any>} manifest
 * @param {{ logger?: import('../core/logger.js').Logger, env?: NodeJS.ProcessEnv, interactive?: boolean }} [options]
 * @returns {import('./worker.js').Sources}
 */
export function createLiveSources(manifest, options = {}) {
  const monitoring = manifest.monitoring;
  const rateLimiter = createRateLimiter(monitoring.limits.minSecondsBetweenQueries * 1000);
  /** @type {Map<string, Promise<import('../core/auth.js').Transport>>} */
  const transports = new Map();
  const connect = (/** @type {string} */ service) => {
    let transport = transports.get(service);
    if (!transport) {
      transport = createTransport(service, manifest, {
        projectId: manifest.id,
        logger: options.logger,
        env: options.env,
        interactive: options.interactive ?? false,
        rateLimiter,
      });
      transports.set(service, transport);
      transport.catch(() => transports.delete(service));
    }
    return transport;
  };

  return {
    splunk: isMissing(manifest.observability.splunkBaseUrlEnv)
      ? null
      : {
          searchErrors: async (window) => {
            const transport = await connect('splunk');
            const result = await splunk.searchErrors(transport, monitoring, window);
            return { events: result.events, link: splunk.searchLink(transport.baseUrl, result.search, result.window) };
          },
        },
    dynatrace: isMissing(manifest.observability.dynatraceBaseUrlEnv)
      ? null
      : {
          listProblems: async (window) => dynatrace.listProblems(await connect('dynatrace'), monitoring, window),
          queryMetrics: async (window) => dynatrace.queryMetrics(await connect('dynatrace'), monitoring, window),
        },
    agility: {
      findDefectsByMarker: async (marker) => agility.findDefectsByMarker(await connect('agility'), marker),
      createDefect: async (draft) =>
        agility.createDefect(await connect('agility'), manifest, /** @type {any} */ (draft)),
    },
    recentCommits: (repoPath, since) => recentCommits(repoPath, { since }),
    close: async () => {
      for (const pending of transports.values()) {
        await pending.then((transport) => transport.close()).catch(() => {});
      }
      transports.clear();
    },
  };
}
