'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const v2 = require('../refresh-file-backed-v2');

test('file-backed refresh safely bounds large SEC filing bodies instead of failing', () => {
  const state = { chunks: [], capturedBytes: 0, totalBytes: 0, truncated: false };
  v2.appendBoundedChunk(state, Buffer.alloc(400000, 65), 600000);
  v2.appendBoundedChunk(state, Buffer.alloc(400000, 66), 600000);
  assert.equal(state.totalBytes, 800000);
  assert.equal(state.capturedBytes, 600000);
  assert.equal(Buffer.concat(state.chunks).length, 600000);
  assert.equal(state.truncated, true);
});

test('scheduled file-backed runner uses the large-document-safe implementation', () => {
  const runner = fs.readFileSync('refresh-file-backed-runner.js', 'utf8');
  assert.match(runner, /require\(['"]\.\/refresh-file-backed-v2['"]\)\.run\(\)/);
});

test('SEC discovery retries transient 5xx failures before giving up coverage', async () => {
  let calls = 0;
  const rows = await v2.fetchRecentFilingsWithRetry('DEFM14A', {
    attempts: 3,
    baseDelayMs: 0,
    fetcher: async () => {
      calls += 1;
      if (calls < 3) throw new Error('SEC EFTS HTTP 500: temporary upstream failure');
      return [{ accession_no: '0000000000-26-000001' }];
    },
  });
  assert.equal(calls, 3);
  assert.equal(rows.length, 1);
});

test('SEC discovery does not retry permanent source errors', async () => {
  let calls = 0;
  await assert.rejects(
    v2.fetchRecentFilingsWithRetry('DEFM14A', {
      attempts: 3,
      baseDelayMs: 0,
      fetcher: async () => {
        calls += 1;
        throw new Error('SEC EFTS HTTP 400: invalid query');
      },
    }),
    /HTTP 400/,
  );
  assert.equal(calls, 1);
});
