import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { describeLayout, detectBuild } from '../../src/adapters/java/detect.js';
import { removeDir, tempDir } from '../helpers.js';

const root = tempDir('autodev-java-');
after(() => removeDir(root));

let counter = 0;
/** @param {Record<string, string>} files */
function fixture(files) {
  counter += 1;
  const dir = path.join(root, `repo-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

const POM = `<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.4</version>
  </parent>
  <properties>
    <java.version>17</java.version>
  </properties>
  <modules>
    <module>api</module>
    <module> core </module>
  </modules>
</project>
`;

describe('detectBuild: maven', () => {
  test('detects maven, java version, spring boot version and modules', () => {
    const build = detectBuild(fixture({ 'pom.xml': POM }), 'linux');
    assert.equal(build.tool, 'maven');
    assert.equal(build.javaVersion, '17');
    assert.equal(build.springBootVersion, '3.2.4');
    assert.deepEqual(build.modules, ['api', 'core']);
    assert.equal(build.usesWrapper, false);
    assert.equal(build.command, 'mvn');
    assert.deepEqual(build.defaults.unit, [['mvn', '-B', 'test']]);
    assert.equal(build.defaults.compile[0][0], 'mvn');
  });

  test('without a wrapper uses mvn.cmd on win32', () => {
    const build = detectBuild(fixture({ 'pom.xml': POM }), 'win32');
    assert.equal(build.command, 'mvn.cmd');
    assert.equal(build.usesWrapper, false);
  });

  test('prefers ./mvnw on posix when the wrapper exists', () => {
    const build = detectBuild(fixture({ 'pom.xml': POM, mvnw: '#!/bin/sh\n', 'mvnw.cmd': '@echo off\r\n' }), 'darwin');
    assert.equal(build.command, './mvnw');
    assert.equal(build.usesWrapper, true);
  });

  test('prefers mvnw.cmd on win32 when the wrapper exists', () => {
    const build = detectBuild(fixture({ 'pom.xml': POM, mvnw: '#!/bin/sh\n', 'mvnw.cmd': '@echo off\r\n' }), 'win32');
    assert.equal(build.command, 'mvnw.cmd');
    assert.equal(build.usesWrapper, true);
    assert.equal(build.defaults.unit[0][0], 'mvnw.cmd');
  });

  test('a posix-only wrapper is not treated as a wrapper on win32', () => {
    const build = detectBuild(fixture({ 'pom.xml': POM, mvnw: '#!/bin/sh\n' }), 'win32');
    assert.equal(build.usesWrapper, false);
    assert.equal(build.command, 'mvn.cmd');
  });

  test('java version from maven.compiler.release wins, spring boot from property', () => {
    const pom = '<project><properties><java.version>11</java.version><maven.compiler.release>21</maven.compiler.release><spring-boot.version>2.7.18</spring-boot.version></properties></project>';
    const build = detectBuild(fixture({ 'pom.xml': pom }), 'linux');
    assert.equal(build.javaVersion, '21');
    assert.equal(build.springBootVersion, '2.7.18');
    assert.deepEqual(build.modules, []);
  });

  test('falls back to .java-version / .tool-versions, and reports null when nothing declares it', () => {
    assert.equal(detectBuild(fixture({ 'pom.xml': '<project/>', '.java-version': '21.0.2\n' }), 'linux').javaVersion, '21.0.2');
    assert.equal(detectBuild(fixture({ 'pom.xml': '<project/>', '.tool-versions': 'nodejs 22.1.0\njava temurin-17.0.9\n' }), 'linux').javaVersion, 'temurin-17.0.9');
    const bare = detectBuild(fixture({ 'pom.xml': '<project/>' }), 'linux');
    assert.equal(bare.javaVersion, null);
    assert.equal(bare.springBootVersion, null);
  });
});

describe('detectBuild: gradle', () => {
  const GROOVY = `plugins {
  id 'java'
  id 'org.springframework.boot' version '3.1.5'
}
java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
`;
  const KTS = `plugins {
  id("org.springframework.boot") version "3.3.0"
}
kotlin { jvmToolchain(17) }
`;

  test('groovy build file: versions, modules and wrapper choice per platform', () => {
    const dir = fixture({ 'build.gradle': GROOVY, 'settings.gradle': "rootProject.name = 'svc'\ninclude 'api', 'core'\ninclude ':web'\n", gradlew: '', 'gradlew.bat': '' });
    const posix = detectBuild(dir, 'linux');
    assert.equal(posix.tool, 'gradle');
    assert.equal(posix.command, './gradlew');
    assert.equal(posix.usesWrapper, true);
    assert.equal(posix.javaVersion, '21');
    assert.equal(posix.springBootVersion, '3.1.5');
    assert.deepEqual(posix.modules, ['api', 'core', 'web']);
    const windows = detectBuild(dir, 'win32');
    assert.equal(windows.command, 'gradlew.bat');
    assert.deepEqual(windows.defaults.unit, [['gradlew.bat', '--console=plain', 'test']]);
  });

  test('kotlin build file: versions and include(...) modules, no wrapper', () => {
    const dir = fixture({ 'build.gradle.kts': KTS, 'settings.gradle.kts': 'include(":api", ":core")\n' });
    const build = detectBuild(dir, 'linux');
    assert.equal(build.tool, 'gradle');
    assert.equal(build.command, 'gradle');
    assert.equal(build.usesWrapper, false);
    assert.equal(build.javaVersion, '17');
    assert.equal(build.springBootVersion, '3.3.0');
    assert.deepEqual(build.modules, ['api', 'core']);
    assert.equal(detectBuild(dir, 'win32').command, 'gradle.bat');
  });

  test('sourceCompatibility forms are read', () => {
    assert.equal(detectBuild(fixture({ 'build.gradle': "sourceCompatibility = '11'\n" }), 'linux').javaVersion, '11');
    assert.equal(detectBuild(fixture({ 'build.gradle': 'sourceCompatibility = JavaVersion.VERSION_17\n' }), 'linux').javaVersion, '17');
  });

  test('includeBuild is not reported as a module', () => {
    const build = detectBuild(fixture({ 'build.gradle': '', 'settings.gradle': "includeBuild('build-logic')\ninclude 'app'\n" }), 'linux');
    assert.deepEqual(build.modules, ['app']);
  });

  test('maven wins when both pom.xml and build.gradle exist', () => {
    assert.equal(detectBuild(fixture({ 'pom.xml': POM, 'build.gradle': GROOVY }), 'linux').tool, 'maven');
  });
});

describe('detectBuild: npm and unknown', () => {
  test('npm: default commands only for scripts that exist, npm.cmd on win32', () => {
    const pkg = JSON.stringify({ scripts: { build: 'tsc', test: 'node --test' }, engines: { node: '>=22' }, workspaces: ['packages/a'] });
    const dir = fixture({ 'package.json': pkg });
    const posix = detectBuild(dir, 'linux');
    assert.equal(posix.tool, 'npm');
    assert.equal(posix.command, 'npm');
    assert.equal(posix.javaVersion, null);
    assert.equal(posix.springBootVersion, null);
    assert.equal(posix.nodeVersion, '>=22');
    assert.deepEqual(posix.modules, ['packages/a']);
    assert.deepEqual(posix.defaults, { compile: [['npm', 'run', 'build']], unit: [['npm', 'test']] });
    const windows = detectBuild(dir, 'win32');
    assert.equal(windows.command, 'npm.cmd');
    assert.deepEqual(windows.defaults.unit, [['npm.cmd', 'test']]);
  });

  test('npm: a corrupt package.json yields no default commands instead of throwing', () => {
    const build = detectBuild(fixture({ 'package.json': '{ not json' }), 'linux');
    assert.equal(build.tool, 'npm');
    assert.deepEqual(build.defaults, {});
    assert.deepEqual(build.modules, []);
  });

  test('nothing recognised: everything is null, nothing is guessed', () => {
    assert.deepEqual(detectBuild(fixture({ 'README.md': '# hi\n' }), 'linux'), {
      tool: null, command: null, usesWrapper: false, javaVersion: null, springBootVersion: null, modules: [], defaults: {},
    });
  });

  test('a directory that does not exist is reported as unknown, not an error', () => {
    assert.equal(detectBuild(path.join(root, 'does-not-exist'), 'linux').tool, null);
  });
});

describe('describeLayout', () => {
  test('reports modules that have java sources and their base package', () => {
    const dir = fixture({
      'pom.xml': POM,
      'api/src/main/java/com/example/orders/App.java': 'package com.example.orders;\n',
      'api/src/test/java/com/example/orders/AppTest.java': '',
      'api/src/main/resources/application.yml': '',
      'core/README.md': '',
    });
    const layout = describeLayout(dir);
    assert.equal(layout.tool, 'maven');
    assert.equal(layout.defaults, undefined);
    assert.equal(layout.layout.length, 1);
    assert.deepEqual(layout.layout[0], { module: 'api', mainJava: true, testJava: true, resources: true, basePackage: 'com.example.orders' });
  });
});
