'use strict';

const fs = require('fs');
const { Client } = require('pg');

async function probeDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) return { available: false, reason: 'DATABASE_URL missing' };

  const client = new Client({
    connectionString: url,
    ssl: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true'
      ? { rejectUnauthorized: false }
      : { rejectUnauthorized: true },
    connectionTimeoutMillis: Math.max(1000, Number(process.env.DATABASE_PROBE_TIMEOUT_MS || 5000)),
    statement_timeout: 5000,
  });

  try {
    await client.connect();
    await client.query('SELECT 1 AS ok');
    return { available: true, reason: 'ok' };
  } catch (error) {
    return { available: false, reason: error.code || error.message || 'connection failed' };
  } finally {
    await client.end().catch(() => {});
  }
}

async function run() {
  const result = await probeDatabase();
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `available=${result.available}\n`);
  }
  console.log(`[DB PROBE] available=${result.available} reason=${result.reason}`);
  return result;
}

module.exports = { probeDatabase, run };

if (require.main === module) {
  run().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
