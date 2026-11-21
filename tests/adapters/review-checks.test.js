import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseDiff, reviewDiff } from '../../src/adapters/review/checks.js';

/**
 * Build a one-hunk diff that adds `lines` to `file`.
 * @param {string} file
 * @param {string[]} lines
 * @param {{ isNew?: boolean, start?: number }} [options]
 */
function addDiff(file, lines, options = {}) {
  const start = options.start ?? 1;
  return [
    `diff --git a/${file} b/${file}`,
    ...(options.isNew ? ['new file mode 100644', '--- /dev/null'] : [`--- a/${file}`]),
    `+++ b/${file}`,
    `@@ -${start},0 +${start},${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

/** @param {string} patch @param {Parameters<typeof reviewDiff>[1]} [options] */
const review = (patch, options) => reviewDiff(parseDiff(patch), options);
/** @param {ReturnType<typeof reviewDiff>} result @param {string} rule */
const found = (result, rule) => result.findings.filter((finding) => finding.rule === rule);

// A test file change, appended where a case should not trip "no-test-change".
const TEST_TOUCH = addDiff('src/test/java/com/example/FooTest.java', ['// covered']);

describe('parseDiff', () => {
  const PATCH = [
    'diff --git a/src/A.java b/src/A.java',
    'index 111..222 100644',
    '--- a/src/A.java',
    '+++ b/src/A.java',
    '@@ -10,4 +10,5 @@ class A {',
    ' context one',
    '-removed line',
    '+added at 11',
    '+added at 12',
    ' context two',
    '@@ -40,2 +41,3 @@',
    ' ctx',
    '+added at 42',
    '\\ No newline at end of file',
    'diff --git a/docs/new.md b/docs/new.md',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/docs/new.md',
    '@@ -0,0 +1,2 @@',
    '+# Title',
    '+body',
    'diff --git a/img/logo.png b/img/logo.png',
    'Binary files a/img/logo.png and b/img/logo.png differ',
    'diff --git a/old.txt b/old.txt',
    'deleted file mode 100644',
    '--- a/old.txt',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-gone 1',
    '-gone 2',
  ].join('\n');

  test('tracks new-file line numbers across hunks, context and deletions', () => {
    const files = parseDiff(PATCH);
    assert.equal(files.length, 4);
    assert.equal(files[0].path, 'src/A.java');
    assert.deepEqual(files[0].added, [
      { line: 11, text: 'added at 11' },
      { line: 12, text: 'added at 12' },
      { line: 42, text: 'added at 42' },
    ]);
    assert.equal(files[0].deleted, 1);
    assert.equal(files[0].isNew, false);
  });

  test('flags new, binary and deleted files', () => {
    const files = parseDiff(PATCH);
    assert.equal(files[1].isNew, true);
    assert.deepEqual(files[1].added.map((a) => a.line), [1, 2]);
    assert.equal(files[2].isBinary, true);
    assert.equal(files[2].added.length, 0);
    assert.equal(files[3].path, 'old.txt');
    assert.equal(files[3].deleted, 2);
    assert.equal(files[3].added.length, 0);
  });

  test('empty input and text before the first header yield no files', () => {
    assert.deepEqual(parseDiff(''), []);
    assert.deepEqual(parseDiff('+not in a file\nrandom text\n'), []);
  });

  test('paths with spaces are kept whole', () => {
    const files = parseDiff(addDiff('docs/my notes.md', ['x']));
    assert.equal(files[0].path, 'docs/my notes.md');
  });

  test('an added line that itself starts with "++" is still an added line', () => {
    const files = parseDiff(addDiff('src/A.java', ['int a = 0;', '++a; String password = "hunter2hunter2";', 'return a;']));
    assert.deepEqual(files[0].added.map((a) => a.line), [1, 2, 3]);
    assert.equal(review(addDiff('src/A.java', ['++a; String password = "hunter2hunter2";'])).passed, false);
  });

  test('an added line reading "++ b/other" must not rename the file being parsed', () => {
    const files = parseDiff(addDiff('src/Real.java', ['first', '++ b/docs/readme.md', 'third']));
    assert.equal(files[0].path, 'src/Real.java');
  });

  test('a deleted line that starts with "--" is counted as deleted', () => {
    const patch = ['diff --git a/a.sql b/a.sql', '--- a/a.sql', '+++ b/a.sql', '@@ -1,2 +1,0 @@', '--- a comment', '-select 1'].join('\n');
    assert.equal(parseDiff(patch)[0].deleted, 2);
  });
});

describe('reviewDiff rules', () => {
  test('a clean source + test change passes with no blockers', () => {
    const result = review(addDiff('src/main/java/com/example/Foo.java', ['int total = a + b;']) + TEST_TOUCH);
    assert.equal(result.passed, true);
    assert.deepEqual(result.counts, { blocker: 0, major: 0, minor: 0, info: 0 });
    assert.deepEqual(result.stats, { files: 2, addedLines: 2, sourceChanged: true, testsChanged: true });
  });

  test('secret: a hard-coded password is a blocker with file and line', () => {
    const result = review(addDiff('src/Db.java', ['// ok', 'String password = "hunter2hunter2";'], { start: 7 }));
    const [finding] = found(result, 'secret-in-diff');
    assert.ok(finding);
    assert.equal(finding.severity, 'blocker');
    assert.equal(finding.file, 'src/Db.java');
    assert.equal(finding.line, 8);
    assert.equal(result.passed, false);
  });

  test('secret: tokens, JWTs, URL credentials and AWS keys are blockers in any file type', () => {
    for (const line of [
      'Authorization: Bearer abcdefghijklmnop1234',
      'jwt = eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456',
      'url: https://svc_user:s3cr3tpw@db.example.internal/app',
      'key = AKIAIOSFODNN7EXAMPLE',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    ]) {
      const result = review(addDiff('config/app.yml', [line]));
      assert.equal(found(result, 'secret-in-diff').length, 1, line);
      assert.equal(result.passed, false, line);
    }
  });

  test('secret: findings never echo the secret itself', () => {
    const result = review(addDiff('src/Db.java', ['String password = "hunter2hunter2";']));
    assert.ok(!JSON.stringify(result).includes('hunter2hunter2'));
  });

  test('secret: a PEM private key pasted into a non-key file is a blocker', () => {
    const result = review(addDiff('src/main/resources/application.yml', [
      'signingKey: |',
      '  -----BEGIN RSA PRIVATE KEY-----',
      '  MIIEowIBAAKCAQEAv1k3Zq0n0m4m9Vb0oQk2mJ3x8l7o5cXkq1Xo2n3Jw4Pq5Rs6',
      '  -----END RSA PRIVATE KEY-----',
    ]));
    assert.equal(result.passed, false);
    assert.ok(found(result, 'secret-in-diff').length >= 1);
  });

  test('TLS disabled: every known way of switching validation off is a blocker', () => {
    for (const line of [
      'HttpsURLConnection.setDefaultHostnameVerifier((h, s) -> true);',
      'const agent = new https.Agent({ rejectUnauthorized: false });',
      "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';",
      'builder.sslContext(SslContextBuilder.forClient().trustManager(InsecureTrustManagerFactory.INSTANCE));',
      'new NoopHostnameVerifier()',
      'requests.get(url, verify=False)',
      'curl --insecure https://x',
      'ignoreHTTPSErrors: true,',
    ]) {
      const result = review(addDiff('scripts/any.txt', [line]));
      assert.equal(found(result, 'tls-validation-disabled').length, 1, line);
      assert.equal(found(result, 'tls-validation-disabled')[0].severity, 'blocker');
      assert.equal(result.passed, false, line);
    }
  });

  test('TLS: ordinary TLS configuration is not flagged', () => {
    const result = review(addDiff('src/Http.js', ['const agent = new https.Agent({ rejectUnauthorized: true });']) + TEST_TOUCH);
    assert.equal(found(result, 'tls-validation-disabled').length, 0);
  });

  test('SQL concatenation is major in source files', () => {
    for (const line of [
      'String sql = "SELECT * FROM APP.ORDERS WHERE ID = " + id;',
      'query = base + " WHERE NAME = \'" + name + "\'";',
      'String q = String.format("select * from t where id = %s", id);',
      'String sql = "delete from APP.T where k=" + key;',
    ]) {
      const result = review(addDiff('src/main/java/Repo.java', [line]) + TEST_TOUCH);
      assert.equal(found(result, 'sql-string-concatenation').length, 1, line);
      assert.equal(found(result, 'sql-string-concatenation')[0].severity, 'major');
      assert.equal(result.passed, true, 'major findings do not block on their own');
    }
  });

  test('SQL: a bind-parameter query is not flagged, and non-source files are exempt', () => {
    const bound = review(addDiff('src/main/java/Repo.java', ['String sql = "SELECT * FROM APP.ORDERS WHERE ID = ?";']) + TEST_TOUCH);
    assert.equal(found(bound, 'sql-string-concatenation').length, 0);
    const docs = review(addDiff('docs/notes.md', ['String sql = "SELECT * FROM T WHERE ID = " + id;']));
    assert.equal(found(docs, 'sql-string-concatenation').length, 0);
  });

  test('schema change is a blocker unless authorized, then info', () => {
    for (const file of ['db/schema.sql', 'src/main/resources/db/migration/V2__add.sql', 'changes/TABLES.DDL', 'src/main/resources/db/changelog-master.yaml', 'liquibase/001.xml']) {
      const blocked = review(addDiff(file, ['ALTER TABLE APP.T ADD COLUMN C INT;']));
      assert.equal(found(blocked, 'schema-change')[0]?.severity, 'blocker', file);
      assert.equal(blocked.passed, false, file);
      const authorized = review(addDiff(file, ['ALTER TABLE APP.T ADD COLUMN C INT;']), { schemaChangeAuthorized: true });
      assert.equal(found(authorized, 'schema-change')[0]?.severity, 'info', file);
      assert.equal(authorized.passed, true, file);
    }
  });

  test('schema change: deleting a migration file is still a schema change', () => {
    const patch = ['diff --git a/db/migration/V1.sql b/db/migration/V1.sql', 'deleted file mode 100644', '--- a/db/migration/V1.sql', '+++ /dev/null', '@@ -1 +0,0 @@', '-create table t(x int);'].join('\n');
    assert.equal(review(patch).passed, false);
  });

  test('dependency change: adding a dependency is major, other build edits are info', () => {
    const added = review(addDiff('pom.xml', ['<dependency>', '<artifactId>commons-lang3</artifactId>', '</dependency>']));
    assert.equal(found(added, 'dependency-change')[0].severity, 'major');
    const npm = review(addDiff('package.json', ['    "left-pad": "^1.3.0",']));
    assert.equal(found(npm, 'dependency-change')[0].severity, 'major');
    const gradle = review(addDiff('service/build.gradle.kts', ['    implementation ("org.apache.commons:commons-text:1.11.0")']));
    assert.equal(found(gradle, 'dependency-change')[0].severity, 'major');
    const info = review(addDiff('gradle.properties', ['org.gradle.parallel=true']));
    assert.equal(found(info, 'dependency-change')[0].severity, 'info');
    assert.equal(found(review(addDiff('src/pom.xml.md', ['x'])), 'dependency-change').length, 0);
  });

  test('disabled or focused tests are major', () => {
    for (const [file, line] of [
      ['src/test/java/FooTest.java', '@Disabled("flaky")'],
      ['src/test/java/FooTest.java', '@Ignore'],
      ['web/app.test.js', "it.skip('does a thing', () => {});"],
      ['web/app.test.js', "describe.only('suite', () => {});"],
      ['web/app.spec.ts', "xit('nope', () => {});"],
    ]) {
      const result = review(addDiff(file, [line]));
      assert.equal(found(result, 'test-disabled').length, 1, line);
      assert.equal(found(result, 'test-disabled')[0].severity, 'major');
    }
    assert.equal(found(review(addDiff('web/app.test.js', ["it('works', () => {});"])), 'test-disabled').length, 0);
  });

  test('debug output is minor in source and ignored in tests', () => {
    for (const [file, line] of [
      ['src/main/java/Foo.java', 'System.out.println("here");'],
      ['src/main/java/Foo.java', 'e.printStackTrace();'],
      ['web/src/app.ts', "console.log('x');"],
      ['web/src/app.js', 'debugger;'],
    ]) {
      const result = review(addDiff(file, [line]) + TEST_TOUCH);
      assert.equal(found(result, 'debug-output').length, 1, line);
      assert.equal(found(result, 'debug-output')[0].severity, 'minor');
      assert.equal(result.passed, true);
    }
    assert.equal(found(review(addDiff('src/test/java/FooTest.java', ['System.out.println("x");'])), 'debug-output').length, 0);
  });

  test('no-test-change: source changed without any test is major; with a test it is absent', () => {
    const without = review(addDiff('src/main/java/Foo.java', ['int a = 1;']));
    assert.equal(found(without, 'no-test-change').length, 1);
    assert.equal(found(without, 'no-test-change')[0].severity, 'major');
    assert.equal(without.stats.testsChanged, false);
    assert.equal(found(review(addDiff('src/main/java/Foo.java', ['int a = 1;']) + TEST_TOUCH), 'no-test-change').length, 0);
    assert.equal(found(review(addDiff('README.md', ['docs only'])), 'no-test-change').length, 0, 'docs-only change needs no test');
  });

  test('change-too-large: too many files or too many lines is major', () => {
    const manyLines = review(addDiff('docs/big.md', Array.from({ length: 11 }, (_, i) => `line ${i}`)), { maxLines: 10 });
    assert.equal(found(manyLines, 'change-too-large').length, 1);
    assert.match(found(manyLines, 'change-too-large')[0].message, /1 files, 11 added lines/);
    const manyFiles = review(['a.md', 'b.md', 'c.md'].map((f) => addDiff(f, ['x'])).join(''), { maxFiles: 2 });
    assert.equal(found(manyFiles, 'change-too-large').length, 1);
    const atLimit = review(addDiff('docs/big.md', Array.from({ length: 10 }, (_, i) => `line ${i}`)), { maxLines: 10, maxFiles: 1 });
    assert.equal(found(atLimit, 'change-too-large').length, 0);
  });

  test('credential files are blockers by name, even when binary or empty', () => {
    for (const file of ['.env', 'config/.env.production', 'certs/server.pem', 'keys/store.JKS', 'a/b/client.p12', 'x.pfx', 'app.keystore']) {
      const result = review(`diff --git a/${file} b/${file}\nnew file mode 100644\nBinary files /dev/null and b/${file} differ\n`);
      assert.equal(found(result, 'credential-file').length, 1, file);
      assert.equal(result.passed, false, file);
    }
    for (const file of ['src/environment.ts', 'docs/env.md', '.envrc.md']) {
      assert.equal(found(review(addDiff(file, ['x'])), 'credential-file').length, 0, file);
    }
  });

  test('counts add up to the findings and an empty diff passes', () => {
    const result = review(addDiff('src/Db.java', ['String password = "hunter2hunter2"; // TODO remove', 'System.out.println(1);']));
    const total = Object.values(result.counts).reduce((a, b) => a + b, 0);
    assert.equal(total, result.findings.length);
    assert.ok(result.counts.blocker >= 1 && result.counts.minor >= 2 && result.counts.major >= 1);
    const empty = reviewDiff([]);
    assert.equal(empty.passed, true);
    assert.equal(empty.findings.length, 0);
  });
});
