'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
