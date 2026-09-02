'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS = [
  'database/migrations/20260611_ingestion_quality.sql',
  'database/migrations/20260617_ingestion_observability.sql',
  'database/migrations/20260625_review_queue_health.sql',
  'database/migrations/20260901_platform_hardening.sql',
];

function sslConfig() {
  if (process.env.NODE_ENV !== 'production') return false;
  return {
    rejectUnauthorized: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED !== 'true',
  };
}

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for migrations');

  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslConfig(),
  });
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('mawire-platform-migrations'))");
    await client.query("SET LOCAL statement_timeout = '10min'");
    await client.query("SET LOCAL lock_timeout = '30s'");

    for (const relativePath of MIGRATIONS) {
      const absolutePath = path.join(__dirname, '..', relativePath);
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`Missing migration: ${relativePath}`);
      }
      const sql = fs.readFileSync(absolutePath, 'utf8');
      await client.query(sql);
      console.log(`[MIGRATE] Applied ${relativePath}`);
    }

    await client.query('COMMIT');
    console.log('[MIGRATE] All platform migrations applied');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await db.end();
  }
}

if (require.main === module) {
  run().catch(error => {
    console.error('[MIGRATE] Failed:', error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { MIGRATIONS, run, sslConfig };
