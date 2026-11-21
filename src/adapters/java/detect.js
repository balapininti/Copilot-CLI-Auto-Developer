/**
 * Detect how a repository is built: Maven, Gradle or npm, the Java and Spring
 * Boot versions it declares, and its modules. Detection reads build files
 * only; anything it cannot find is reported as null, not guessed.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} file
 */
function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * @param {string | null} text
 * @param {RegExp[]} patterns
 */
function firstMatch(text, patterns) {
  if (!text) return null;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

/**
 * @param {string} repoPath
 * @param {NodeJS.Platform} [platform]
 */
export function detectBuild(repoPath, platform = process.platform) {
  const has = (/** @type {string} */ name) => fs.existsSync(path.join(repoPath, name));
  const windows = platform === 'win32';

  if (has('pom.xml')) {
    const pom = read(path.join(repoPath, 'pom.xml'));
    const wrapper = windows ? 'mvnw.cmd' : 'mvnw';
    const command = has(wrapper) ? (windows ? wrapper : './mvnw') : windows ? 'mvn.cmd' : 'mvn';
    return {
      tool: 'maven',
      command,
      usesWrapper: has(wrapper),
      javaVersion:
        firstMatch(pom, [
          /<maven\.compiler\.release>([^<]+)</,
          /<java\.version>([^<]+)</,
          /<maven\.compiler\.source>([^<]+)</,
          /<release>([^<]+)<\/release>/,
        ]) ?? toolVersionsJava(repoPath),
      springBootVersion: firstMatch(pom, [
        /<artifactId>spring-boot-starter-parent<\/artifactId>\s*<version>([^<]+)</,
        /<spring-boot\.version>([^<]+)</,
      ]),
      modules: [...(pom ?? '').matchAll(/<module>([^<]+)<\/module>/g)].map((match) => match[1].trim()),
      defaults: {
        compile: [[command, '-B', '-q', '-DskipTests', 'compile', 'test-compile']],
        unit: [[command, '-B', 'test']],
      },
    };
  }

  const gradleFile = ['build.gradle.kts', 'build.gradle'].find(has);
  if (gradleFile) {
    const build = read(path.join(repoPath, gradleFile));
    const settings = read(path.join(repoPath, 'settings.gradle.kts')) ?? read(path.join(repoPath, 'settings.gradle'));
    const wrapper = windows ? 'gradlew.bat' : 'gradlew';
    const command = has(wrapper) ? (windows ? wrapper : './gradlew') : windows ? 'gradle.bat' : 'gradle';
    return {
      tool: 'gradle',
      command,
      usesWrapper: has(wrapper),
      javaVersion:
        firstMatch(build, [
          /JavaLanguageVersion\.of\((\d+)\)/,
          /sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_)?['"]?([\d._]+)/,
          /jvmToolchain\((\d+)\)/,
        ]) ?? toolVersionsJava(repoPath),
      springBootVersion: firstMatch(build, [
        /id\s*\(?\s*['"]org\.springframework\.boot['"]\s*\)?\s*version\s*['"]([^'"]+)['"]/,
        /spring-boot-gradle-plugin:([\w.-]+)/,
      ]),
      modules: [...(settings ?? '').matchAll(/include\s*\(?\s*((?:['"][^'"]+['"]\s*,?\s*)+)/g)].flatMap((match) =>
        [...match[1].matchAll(/['"]:?([^'"]+)['"]/g)].map((inner) => inner[1]),
      ),
      defaults: {
        compile: [[command, '--console=plain', 'compileJava', 'compileTestJava']],
        unit: [[command, '--console=plain', 'test']],
      },
    };
  }

  if (has('package.json')) {
    /** @type {any} */
    let pkg = {};
    try {
      pkg = JSON.parse(read(path.join(repoPath, 'package.json')) ?? '{}');
    } catch {
      // unreadable package.json: no default commands
    }
    const npm = windows ? 'npm.cmd' : 'npm';
    const scripts = pkg.scripts ?? {};
    /** @type {Record<string, string[][]>} */
    const defaults = {};
    if (scripts.build) defaults.compile = [[npm, 'run', 'build']];
    if (scripts.lint) defaults.static = [[npm, 'run', 'lint']];
    if (scripts.test) defaults.unit = [[npm, 'test']];
    return {
      tool: 'npm',
      command: npm,
      usesWrapper: false,
      javaVersion: null,
      springBootVersion: null,
      nodeVersion: pkg.engines?.node ?? null,
      modules: Array.isArray(pkg.workspaces) ? pkg.workspaces : [],
      defaults,
    };
  }

  return { tool: null, command: null, usesWrapper: false, javaVersion: null, springBootVersion: null, modules: [], defaults: {} };
}

/**
 * @param {string} repoPath
 */
function toolVersionsJava(repoPath) {
  return (
    firstMatch(read(path.join(repoPath, '.java-version')), [/^\s*([\w.-]+)/]) ??
    firstMatch(read(path.join(repoPath, '.tool-versions')), [/^java\s+(\S+)/m])
  );
}

/**
 * Describe the Java source layout so changes follow the existing conventions.
 * @param {string} repoPath
 */
export function describeLayout(repoPath) {
  const build = detectBuild(repoPath);
  const roots = ['.', ...build.modules];
  const layout = roots
    .map((root) => {
      const base = path.join(repoPath, root);
      return {
        module: root,
        mainJava: fs.existsSync(path.join(base, 'src', 'main', 'java')),
        testJava: fs.existsSync(path.join(base, 'src', 'test', 'java')),
        resources: fs.existsSync(path.join(base, 'src', 'main', 'resources')),
        basePackage: findBasePackage(path.join(base, 'src', 'main', 'java')),
      };
    })
    .filter((entry) => entry.mainJava || entry.testJava);
  return { ...build, defaults: undefined, layout };
}

/**
 * Follow single-child directories down from src/main/java to find the base package.
 * @param {string} javaRoot
 */
function findBasePackage(javaRoot) {
  if (!fs.existsSync(javaRoot)) return null;
  const parts = [];
  let current = javaRoot;
  for (let depth = 0; depth < 8; depth += 1) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory());
    if (dirs.length !== 1 || entries.some((entry) => entry.isFile())) break;
    parts.push(dirs[0].name);
    current = path.join(current, dirs[0].name);
  }
  return parts.length > 0 ? parts.join('.') : null;
}
