/**
 * Where a project keeps making the same mistake.
 *
 * Saving a learning needs a person's approval, and that does not change.
 * What this adds is that the looking is no longer left to chance: after
 * every story the recorded history is searched for things worth turning
 * into a rule, and the agent is handed them with the evidence.
 *
 *   thisStory  what went wrong on the way to this story's pull request:
 *              blocking plan findings, gates that failed before passing
 *   repeated   the same kind of thing across several stories of the project
 *
 * A signal is evidence, not a rule. The agent (or a person) decides whether
 * a general rule would have prevented it and proposes one with
 * `autodev learn propose`; nothing is written to knowledge here.
 */

import fs from 'node:fs';
import path from 'node:path';

import { sha256 } from '../core/hash.js';
import { atomicWriteJson, ensureDir, readJson, safeId } from '../core/state-store.js';
import { stateDirFor } from '../core/workspace.js';
import { updateRun } from './run-store.js';

const STOPWORDS = new Set(['that', 'this', 'with', 'from', 'when', 'then', 'will', 'must', 'should', 'have', 'been', 'into', 'each', 'does', 'only', 'also', 'than', 'after', 'before', 'there', 'their', 'which', 'while', 'without', 'plan', 'plans']);
const MAX_RUNS = 300;

/** Which knowledge area a plan-review area's lesson belongs to. */
const AREA_TO_KNOWLEDGE = Object.freeze({
  requirements: 'plan-review', feasibility: 'plan-review', 'edge-cases': 'plan-review', 'blast-radius': 'plan-review', assumptions: 'plan-review',
  data: 'db2', security: 'code-review', tests: 'testing', operations: 'plan-review',
});
const GATE_TO_KNOWLEDGE = Object.freeze({ tests: 'testing', 'automated-review': 'code-review', 'independent-review': 'code-review' });

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @returns {Array<Record<string, any>>}
 */
function loadRuns(workspace, projectId) {
  const dir = stateDirFor(workspace, 'runs', projectId);
  if (!fs.existsSync(dir)) return [];
  /** @type {Array<Record<string, any>>} */
  const runs = [];
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.json')).slice(0, MAX_RUNS)) {
    const run = readJson(path.join(dir, name), /** @type {Record<string, any> | null} */ (null));
    if (run !== null && typeof run.storyId === 'string') runs.push(run);
  }
  return runs;
}

/** @param {string} text */
function words(text) {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).filter((word) => !STOPWORDS.has(word)).map((word) => word.replace(/(ing|ed|es|s)$/, '')));
}

/**
 * @param {Set<string>} a
 * @param {Set<string>} b
 */
function similarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Every finding raised on a story's plan, in any evaluation round.
 * @param {Record<string, any>} run
 * @returns {Array<{ storyId: string, priority: string, area: string | null, title: string }>}
 */
function planFindings(run) {
  const reviews = run.plan?.reviews ?? (run.plan?.review ? [run.plan.review] : []);
  const seen = new Set();
  const out = [];
  for (const review of reviews) {
    for (const finding of review.findings ?? []) {
      const key = `${finding.priority}|${finding.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ storyId: run.storyId, priority: finding.priority, area: finding.area ?? null, title: finding.title });
    }
  }
  return out;
}

/**
 * How often each gate failed on a story before it passed.
 * @param {Record<string, any>} run
 * @returns {Record<string, number>}
 */
function gateFailures(run) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const event of run.history ?? []) {
    const match = /^gate:(.+)$/.exec(String(event.event ?? ''));
    if (match && event.passed === false) counts[match[1]] = (counts[match[1]] ?? 0) + 1;
  }
  return counts;
}

/** @param {string} kind @param {string} subject */
function keyOf(kind, subject) {
  return `${kind}-${sha256(`${kind}|${subject}`).slice(0, 10)}`;
}

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 */
function handledFile(workspace, projectId) {
  return path.join(stateDirFor(workspace, 'learning', projectId), 'signals.json');
}

/**
 * Signals a person or agent has already acted on, so they are not raised again.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @returns {Record<string, { state: string, at: string, note?: string | null }>}
 */
export function readHandled(workspace, projectId) {
  return readJson(handledFile(workspace, projectId), /** @type {Record<string, any>} */ ({}));
}

/**
 * Mark a signal as proposed or dismissed.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {string} key
 * @param {'proposed' | 'dismissed'} state
 * @param {string | null} [note]
 */
export function markSignal(workspace, projectId, key, state, note = null) {
  const file = handledFile(workspace, projectId);
  ensureDir(path.dirname(file));
  const handled = readHandled(workspace, projectId);
  handled[safeId(key, 'signal key')] = { state, at: new Date().toISOString(), note: note ? String(note).slice(0, 300) : null };
  atomicWriteJson(file, handled);
  return handled[key];
}

/**
 * Find what is worth learning from.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ projectId: string, storyId?: string | null, minStories?: number }} input
 */
export function findSignals(workspace, input) {
  const minStories = Math.max(2, Number(input.minStories) || 2);
  const runs = loadRuns(workspace, input.projectId);
  const handled = readHandled(workspace, input.projectId);
  /** @type {Array<Record<string, any>>} */
  const signals = [];
  const add = (/** @type {Record<string, any>} */ signal) => {
    if (!handled[signal.key]) signals.push(signal);
  };

  // --- this story: what went wrong on the way to its pull request
  const current = input.storyId ? runs.find((run) => run.storyId === input.storyId) : null;
  if (current) {
    const blocking = planFindings(current).filter((finding) => finding.priority === 'P0' || finding.priority === 'P1');
    for (const finding of blocking) {
      add({
        key: keyOf('story-plan', `${current.storyId}|${finding.title}`), scope: 'this-story', kind: 'blocking-plan-finding',
        what: `The plan for ${current.storyId} was sent back for: ${finding.priority} ${finding.title}`,
        knowledgeArea: Object.hasOwn(AREA_TO_KNOWLEDGE, finding.area ?? '') ? AREA_TO_KNOWLEDGE[/** @type {keyof typeof AREA_TO_KNOWLEDGE} */ (finding.area)] : 'plan-review',
        stories: [current.storyId],
        question: 'Is this specific to this story, or would a standing rule for this project have put it in the first plan?',
      });
    }
    for (const [gate, count] of Object.entries(gateFailures(current))) {
      if (count < 2) continue; // one failed run is normal development
      add({
        key: keyOf('story-gate', `${current.storyId}|${gate}`), scope: 'this-story', kind: 'gate-failed-repeatedly',
        what: `The ${gate} gate failed ${count} times on ${current.storyId} before it passed.`,
        knowledgeArea: Object.hasOwn(GATE_TO_KNOWLEDGE, gate) ? GATE_TO_KNOWLEDGE[/** @type {keyof typeof GATE_TO_KNOWLEDGE} */ (gate)] : 'testing',
        stories: [current.storyId],
        question: 'What was the cause each time? If it was the same cause, a rule about it would save the next story the same loop.',
      });
    }
  }

  // --- across stories: the same plan-review area keeps producing blocking findings
  const all = runs.flatMap(planFindings).filter((finding) => ['P0', 'P1', 'P2'].includes(finding.priority));
  /** @type {Map<string, typeof all>} */
  const byArea = new Map();
  for (const finding of all.filter((item) => item.area && item.priority !== 'P2')) {
    byArea.set(/** @type {string} */ (finding.area), [...(byArea.get(/** @type {string} */ (finding.area)) ?? []), finding]);
  }
  for (const [area, findings] of byArea) {
    const stories = [...new Set(findings.map((finding) => finding.storyId))];
    if (stories.length < minStories) continue;
    add({
      key: keyOf('area', `${area}|${stories.length}`), scope: 'repeated', kind: 'plan-area-keeps-failing',
      what: `Plans had blocking findings under "${area}" on ${stories.length} stories.`,
      knowledgeArea: Object.hasOwn(AREA_TO_KNOWLEDGE, area) ? AREA_TO_KNOWLEDGE[/** @type {keyof typeof AREA_TO_KNOWLEDGE} */ (area)] : 'plan-review',
      stories,
      examples: findings.slice(0, 5).map((finding) => `${finding.storyId}: ${finding.title}`),
      question: 'What do these have in common? A rule naming it would be given to the planner and the plan reviewer on every story.',
    });
  }

  // --- across stories: findings that say nearly the same thing
  /** @type {Array<{ words: Set<string>, findings: typeof all }>} */
  const clusters = [];
  for (const finding of all) {
    const bag = words(finding.title);
    const home = clusters.find((cluster) => similarity(cluster.words, bag) >= 0.5);
    if (home) home.findings.push(finding);
    else clusters.push({ words: bag, findings: [finding] });
  }
  for (const cluster of clusters) {
    const stories = [...new Set(cluster.findings.map((finding) => finding.storyId))];
    if (stories.length < minStories) continue;
    const first = cluster.findings[0];
    add({
      key: keyOf('similar', [...cluster.words].sort().join(' ')), scope: 'repeated', kind: 'same-finding-on-several-stories',
      what: `Much the same plan finding was raised on ${stories.length} stories: "${first.title}"`,
      knowledgeArea: Object.hasOwn(AREA_TO_KNOWLEDGE, first.area ?? '') ? AREA_TO_KNOWLEDGE[/** @type {keyof typeof AREA_TO_KNOWLEDGE} */ (first.area)] : 'plan-review',
      stories,
      examples: cluster.findings.slice(0, 5).map((finding) => `${finding.storyId}: ${finding.priority} ${finding.title}`),
      question: 'This is the strongest kind of signal. Write the rule that would have prevented all of them.',
    });
  }

  // --- across stories: a gate that usually fails first time
  /** @type {Record<string, string[]>} */
  const failedOn = {};
  for (const run of runs) {
    for (const [gate, count] of Object.entries(gateFailures(run))) {
      if (count > 0) failedOn[gate] = [...(failedOn[gate] ?? []), run.storyId];
    }
  }
  const withGates = runs.filter((run) => (run.history ?? []).some((/** @type {any} */ event) => String(event.event).startsWith('gate:'))).length;
  for (const [gate, stories] of Object.entries(failedOn)) {
    if (stories.length < Math.max(minStories, 3) || stories.length * 2 < withGates) continue;
    add({
      key: keyOf('gate', `${gate}|${Math.floor(stories.length / 3)}`), scope: 'repeated', kind: 'gate-usually-fails-first',
      what: `The ${gate} gate failed at least once on ${stories.length} of ${withGates} stories.`,
      knowledgeArea: Object.hasOwn(GATE_TO_KNOWLEDGE, gate) ? GATE_TO_KNOWLEDGE[/** @type {keyof typeof GATE_TO_KNOWLEDGE} */ (gate)] : 'testing',
      stories: stories.slice(0, 20),
      question: 'Is there a common cause (a setup step, a forgotten check)? Look at the evidence files of two or three of these stories.',
    });
  }

  return {
    projectId: input.projectId,
    storyId: input.storyId ?? null,
    storiesExamined: runs.length,
    signals,
    alreadyHandled: Object.keys(handled).length,
    howToAct: [
      'For each signal, decide whether a general, testable rule would have prevented it. If yes: autodev learn propose --skill <knowledgeArea> --rule "When …, always/never …" --evidence "<what>" --source "<stories>" --signal <key>',
      'If it was particular to one story, or you cannot state a rule you are sure is true: autodev learn suggest --dismiss <key> --reason "…"',
      'Never propose a rule just to clear a signal. A wrong rule is followed on every later story.',
    ],
  };
}

/**
 * Record that the learning check was done for a story, so the workflow can move on.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ projectId: string, storyId: string, signals: number }} input
 */
export function recordLearningCheck(workspace, input) {
  return updateRun(workspace, input.projectId, input.storyId, (run) => {
    run.learningCheck = { at: new Date().toISOString(), signals: input.signals };
    return run.learningCheck;
  });
}
