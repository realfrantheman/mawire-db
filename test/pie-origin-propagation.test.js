'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isRetryableOriginError, validateOriginWithRetry } = require('../FIX-file-integrity');

test('PIE retries a stale production manifest until deployment propagation completes', async () => {
  let calls = 0;
  const result = await validateOriginWithRetry({ dealCount: 25216 }, {
    attempts: 3,
    delayMs: 0,
    sleep: async () => {},
    validate: async () => {
      calls += 1;
      if (calls < 3) throw new Error('origin manifest is stale');
      return { origin: 'https://mawire.vercel.app', remoteDealCount: 25216 };
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.remoteDealCount, 25216);
});

test('PIE retries deployment-era deal count mismatch but remains bounded', async () => {
  let calls = 0;
  await assert.rejects(
    validateOriginWithRetry({ dealCount: 25216 }, {
      attempts: 2,
      delayMs: 0,
      sleep: async () => {},
      validate: async () => {
        calls += 1;
        throw new Error('origin/local deal count mismatch: 25210 != 25216');
      },
    }),
    /origin\/local deal count mismatch/,
  );
  assert.equal(calls, 2);
});

test('PIE does not retry permanent origin validation failures', async () => {
  let calls = 0;
  await assert.rejects(
    validateOriginWithRetry({}, {
      attempts: 8,
      delayMs: 0,
      sleep: async () => {},
      validate: async () => {
        calls += 1;
        throw new Error('origin manifest HTTP 403');
      },
    }),
    /HTTP 403/,
  );
  assert.equal(calls, 1);
});

test('PIE classifies only transient deployment and network failures as retryable', () => {
  assert.equal(isRetryableOriginError(new Error('origin manifest HTTP 503')), true);
  assert.equal(isRetryableOriginError(new Error('origin deals-index HTTP 404')), true);
  assert.equal(isRetryableOriginError(new Error('timeout: https://mawire.vercel.app/app.js')), true);
  assert.equal(isRetryableOriginError(new Error('origin manifest HTTP 401')), false);
  assert.equal(isRetryableOriginError(new Error('Unexpected token in JSON')), false);
});
