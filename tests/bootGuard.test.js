const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
require('./helpers').isolate();

const submissions = require('../src/submissions');
const { assertNoTestData } = require('../server');

const newId = () => crypto.randomUUID();

// assertNoTestData calls process.exit(1) on contamination. Stub it to throw a
// sentinel so we can assert it fired without killing the test runner, and make
// sure NODE_ENV doesn't short-circuit the guard.
function runGuard() {
  const realExit = process.exit;
  const realNodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  let exited = false;
  process.exit = (code) => { exited = true; throw new Error(`__exit_${code}__`); };
  try {
    assertNoTestData();
    return { exited: false };
  } catch (err) {
    if (/^__exit_/.test(err.message)) return { exited, code: err.message };
    throw err;
  } finally {
    process.exit = realExit;
    if (realNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = realNodeEnv;
  }
}

function insertTestRow() {
  submissions.insert({
    submissionUuid: newId(),
    jobUuid: newId(),
    caller: 'test',
    scope: 'content',
    operation: 'patchItem',
    status: 'APPLIED',
    requestBody: {}
  });
}

test('boot guard passes when the database has no caller=test rows', () => {
  const result = runGuard();
  assert.equal(result.exited, false);
});

test('boot guard aborts boot when caller=test fixtures are present', () => {
  insertTestRow();
  const result = runGuard();
  assert.equal(result.exited, true);
  assert.match(result.code, /__exit_1__/);
});

test('boot guard is bypassed by ALLOW_TEST_ROWS=true', () => {
  const prev = process.env.ALLOW_TEST_ROWS;
  process.env.ALLOW_TEST_ROWS = 'true';
  try {
    insertTestRow();
    const result = runGuard();
    assert.equal(result.exited, false);
  } finally {
    if (prev === undefined) delete process.env.ALLOW_TEST_ROWS;
    else process.env.ALLOW_TEST_ROWS = prev;
  }
});
