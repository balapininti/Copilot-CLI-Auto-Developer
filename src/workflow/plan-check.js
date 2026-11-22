/**
 * Mechanical facts about a plan, for the author and the reviewer.
 *
 * Whether a plan is sound is a judgement. Whether the files it names exist,
 * who else calls what it changes, and whether each acceptance criterion is
 * mentioned are not: they can be looked up. Looking them up here means the
 * evaluation starts from facts instead of depending on how thoroughly a
 * model happened to search.
 *
 * Everything here is read-only and labelled for what it is. "not-found"
 * means this search did not find it, which a reviewer then checks; it is
 * never a verdict.
 */

import path from 'node:path';

import { runCommand } from '../core/exec.js';

const MAX_SYMBOLS = 30;
const MAX_PATHS = 60;
const MAX_REFERENCE_FILES = 40;
const SOURCE_EXTENSIONS = 'java|kt|kts|groovy|js|jsx|mjs|cjs|ts|tsx|vue|html|css|scss|xml|yml|yaml|json|sql|properties|gradle|md';
const STOPWORDS = new Set([
  'that', 'this', 'with', 'from', 'when', 'then', 'will', 'must', 'should', 'have', 'been', 'into', 'each', 'they', 'them', 'their', 'there', 'which',
  'while', 'where', 'what', 'does', 'only', 'also', 'than', 'after', 'before', 'given', 'user', 'users', 'able', 'every', 'other', 'same', 'such', 'between',
]);
const COMMON_IDENTIFIERS = new Set(['String', 'Integer', 'Boolean', 'Object', 'List', 'Map', 'None', 'True', 'False', 'Null', 'Goal', 'Changes', 'Tests', 'README', 'JSON', 'YAML', 'HTTP', 'HTTPS', 'TODO']);

/**
 * What a plan refers to: files, code symbols and database tables.
 * @param {string} planText
 * @param {string[]} schemas the project's schemas (upper case)
 */
export function extractReferences(planText, schemas = []) {
  const paths = new Set();
  for (const match of planText.matchAll(new RegExp(`(?:[\\w.@-]+[\\\\/])*[\\w.@-]+\\.(?:${SOURCE_EXTENSIONS})\\b`, 'g'))) {
    const value = match[0].split('\\').join('/').replace(/^\.\//, '');
    if (!/^\d/.test(path.basename(value))) paths.add(value);
  }
  const symbols = new Set();
  for (const match of planText.matchAll(/`([^`\n]{2,120})`/g)) {
    if (new RegExp(`\\.(?:${SOURCE_EXTENSIONS})$`).test(match[1].trim())) continue; // a file name, handled above
    for (const id of match[1].matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
      const name = id[0];
      const pascal = /^[A-Z][a-z0-9]+[A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(name);
      const camel = /^[a-z]+[A-Z][A-Za-z0-9]*$/.test(name);
      const constant = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(name);
      if ((pascal || camel || constant) && !COMMON_IDENTIFIERS.has(name)) symbols.add(name);
    }
  }
  const tables = new Set();
  const known = new Set(schemas.map((schema) => schema.toUpperCase()));
  for (const match of planText.matchAll(/\b([A-Z][A-Z0-9_]*)\.([A-Z][A-Z0-9_]+)\b/g)) {
    if (known.has(match[1])) tables.add(`${match[1]}.${match[2]}`);
  }
  return {
    paths: [...paths].slice(0, MAX_PATHS),
    symbols: [...symbols].filter((symbol) => !tables.has(symbol)).slice(0, MAX_SYMBOLS),
    tables: [...tables],
  };
}

/**
 * Split acceptance criteria into separate items.
 * @param {string | null | undefined} text
 * @returns {string[]}
 */
export function splitCriteria(text) {
  const plain = String(text ?? '').replace(/<[^>]+>/g, ' ').replace(/\r/g, '');
  const lines = plain
    .split(/\n+|(?<=[.;])\s+(?=(?:\d+[.)]|[-*•]|Given\b|When\b|Then\b|AC\s*\d))/)
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*•]|AC\s*\d+\s*[:.)-]?)\s*/i, '').trim())
    .filter((line) => line.length >= 12);
  return lines.slice(0, 40);
}

/** @param {string} text */
function significantWords(text) {
  return [...new Set((text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []).filter((word) => !STOPWORDS.has(word)))];
}

/**
 * For each acceptance criterion, how much of its wording the plan picks up.
 * A word-overlap heuristic: it flags criteria the plan may have skipped.
 * @param {string | null | undefined} criteriaText
 * @param {string} planText
 */
export function criteriaCoverage(criteriaText, planText) {
  const planWords = new Set(significantWords(planText));
  return splitCriteria(criteriaText).map((criterion, index) => {
    const words = significantWords(criterion);
    const found = words.filter((word) => planWords.has(word) || planWords.has(word.replace(/s$/, '')) || planWords.has(`${word}s`));
    const ratio = words.length === 0 ? 1 : found.length / words.length;
    return {
      number: index + 1,
      criterion: criterion.slice(0, 300),
      inPlan: ratio >= 0.5 ? 'mentioned' : ratio >= 0.25 ? 'partly' : 'not-found',
      missingTerms: words.filter((word) => !found.includes(word)).slice(0, 8),
    };
  });
}

/**
 * @param {string} repoPath
 * @param {string[]} args
 */
async function git(repoPath, args) {
  try {
    const result = await runCommand('git', ['-C', repoPath, ...args], { timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 });
    return result.exitCode === 0 || result.exitCode === 1 ? result.stdout : '';
  } catch {
    return '';
  }
}

/**
 * Tracked and untracked (not ignored) files of a clone.
 * @param {string} repoPath
 * @returns {Promise<string[]>}
 */
export async function listFiles(repoPath) {
  const out = await git(repoPath, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  return out.split('\0').filter(Boolean);
}

/**
 * Where a whole-word identifier appears in a clone.
 * @param {string} repoPath
 * @param {string} symbol
 * @returns {Promise<Array<{ file: string, lines: number[] }>>}
 */
export async function findReferences(repoPath, symbol) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{1,80}$/.test(symbol)) return [];
  const out = await git(repoPath, ['grep', '-n', '-w', '-F', '-I', '--untracked', '--no-color', '-e', symbol, '--', '.']);
  /** @type {Map<string, number[]>} */
  const byFile = new Map();
  for (const line of out.split('\n')) {
    const match = /^(.+?):(\d+):/.exec(line);
    if (!match) continue;
    const lines = byFile.get(match[1]) ?? [];
    if (lines.length < 8) lines.push(Number(match[2]));
    byFile.set(match[1], lines);
  }
  return [...byFile.entries()].map(([file, lines]) => ({ file, lines }));
}

/**
 * References to a symbol across the project's clones.
 * @param {Array<{ name: string, path: string }>} repos
 * @param {string} symbol
 */
export async function referencesAcrossRepos(repos, symbol) {
  /** @type {Array<{ repository: string, file: string, lines: number[], definesIt: boolean }>} */
  const references = [];
  for (const repo of repos) {
    for (const hit of await findReferences(repo.path, symbol)) {
      const stem = path.basename(hit.file).replace(/\.[^.]+$/, '');
      references.push({ repository: repo.name, file: hit.file, lines: hit.lines, definesIt: stem === symbol });
    }
  }
  return references;
}

/**
 * Check a plan's references against the project's clones.
 * @param {{ planText: string, criteriaText?: string | null, schemas?: string[], repos: Array<{ name: string, path: string }> }} input
 */
export async function checkPlanFacts(input) {
  const refs = extractReferences(input.planText, input.schemas ?? []);
  /** @type {Map<string, string[]>} */
  const filesByRepo = new Map();
  for (const repo of input.repos) filesByRepo.set(repo.name, await listFiles(repo.path));

  const files = refs.paths.map((named) => {
    const where = [];
    for (const [repo, list] of filesByRepo) {
      for (const file of list) {
        if (file === named || file.endsWith(`/${named}`)) where.push(`${repo}:${file}`);
        if (where.length >= 5) break;
      }
    }
    const introduced = new RegExp(`\\b(new|add|adds|added|create|creates|created|introduce)\\b[^\\n]{0,80}${named.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${named.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]{0,40}\\((new|added)\\)`, 'i').test(input.planText);
    return { named, exists: where.length > 0, where, ...(where.length === 0 ? { planSaysNew: introduced } : {}) };
  });

  const namedFiles = new Set(files.flatMap((file) => file.where));
  const symbols = [];
  for (const symbol of refs.symbols) {
    const references = await referencesAcrossRepos(input.repos, symbol);
    const others = references.filter((ref) => !ref.definesIt);
    // The files that use this symbol but that the plan never names: where a change can surprise someone.
    const notInPlan = others.filter((ref) => !namedFiles.has(`${ref.repository}:${ref.file}`) && !input.planText.includes(path.basename(ref.file)));
    symbols.push({
      symbol,
      found: references.length > 0,
      definedIn: references.filter((ref) => ref.definesIt).map((ref) => `${ref.repository}:${ref.file}`).slice(0, 5),
      referencedInFiles: others.length,
      referencesNotMentionedInPlan: notInPlan.slice(0, MAX_REFERENCE_FILES).map((ref) => `${ref.repository}:${ref.file}:${ref.lines[0]}`),
      truncated: notInPlan.length > MAX_REFERENCE_FILES,
    });
  }

  const criteria = input.criteriaText ? criteriaCoverage(input.criteriaText, input.planText) : null;
  const missingFiles = files.filter((file) => !file.exists && !file.planSaysNew);
  const unknownSymbols = symbols.filter((symbol) => !symbol.found);
  const unmentioned = symbols.filter((symbol) => symbol.referencesNotMentionedInPlan.length > 0);
  const uncovered = (criteria ?? []).filter((item) => item.inPlan === 'not-found');
  return {
    files,
    symbols,
    tables: refs.tables.map((table) => ({ table, verifyWith: `autodev db2 describe --schema ${table.split('.')[0]} --table ${table.split('.')[1]}` })),
    criteria,
    attention: [
      ...missingFiles.map((file) => `File named in the plan was not found and is not described as new: ${file.named}`),
      ...unknownSymbols.map((symbol) => `Identifier named in the plan does not appear in any clone: ${symbol.symbol}`),
      ...unmentioned.map((symbol) => `${symbol.symbol} is used in ${symbol.referencesNotMentionedInPlan.length}${symbol.truncated ? '+' : ''} file(s) the plan does not mention`),
      ...uncovered.map((item) => `Acceptance criterion ${item.number} shares few words with the plan: "${item.criterion.slice(0, 120)}"`),
      ...(criteria === null ? ['The story has no recorded acceptance criteria, so coverage could not be checked. Read the ticket: autodev agility story'] : []),
    ],
    notes: [
      'These are mechanical look-ups, not an evaluation. "not found" and "not-found" mean this search did not find it; confirm before relying on either.',
      'Criterion coverage compares wording only. A criterion can be mentioned and still not be satisfied.',
      'Tables are not checked against the database here; use the command given for each.',
    ],
  };
}
