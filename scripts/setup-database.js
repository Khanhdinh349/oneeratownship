'use strict';

/**
 * Prepares a hosted database for a deployment: applies the schema, runs the
 * migrations and seeds the master data and staff accounts.
 *
 * It is run once, by hand, before deploying — not on every cold start, because
 * seeding hashes every staff password with scrypt and a serverless function
 * should not pay that cost each time it wakes up.
 *
 *     KINERA_DB_URL='postgresql://…' \
 *     KINERA_SEED_RECEPTION_PASSWORD='…' \
 *     KINERA_SEED_SALES_PASSWORD='…' \
 *     KINERA_SEED_MANAGER_PASSWORD='…' \
 *     KINERA_SEED_ADMIN_PASSWORD='…' \
 *     node scripts/setup-database.js
 *
 * Safe to run again: the schema uses CREATE TABLE IF NOT EXISTS, the migrations
 * are idempotent, and an account that already exists keeps the password it has.
 */

const { openDatabase } = require('../src/db');
const { seed } = require('../src/db/seed');

const DB_URL = process.env.KINERA_DB_URL || process.env.DATABASE_URL;

async function main() {
  if (!DB_URL) {
    process.stderr.write('Set KINERA_DB_URL to the database connection string.\n');
    process.exit(1);
  }

  let host = 'the configured host';
  try { host = new URL(DB_URL).host; } catch { /* keep the generic label */ }
  process.stdout.write(`Preparing ${host}…\n`);

  const db = await openDatabase(DB_URL);
  try {
    if (db.migrations && db.migrations.length) {
      process.stdout.write(`  migrations: ${db.migrations.join(', ')}\n`);
    }
    const { accounts } = await seed(db);
    // current_schema(), not 'public': a deployment may put the app's tables in a
    // schema of their own, which is what keeps them out of Supabase's REST API.
    const tables = await db.prepare(
      'SELECT table_name FROM information_schema.tables '
      + 'WHERE table_schema = current_schema() ORDER BY table_name',
    ).all();
    process.stdout.write(`  schema    : ${(await db.prepare('SELECT current_schema() AS s').get()).s}\n`);
    process.stdout.write(`  tables    : ${tables.map((t) => t.table_name).join(', ')}\n`);
    process.stdout.write(`  accounts  : ${accounts.length}\n`);
    for (const a of accounts) {
      process.stdout.write(`    ${a.username.padEnd(20)} ${a.role}\n`);
    }
    process.stdout.write('Done.\n');
  } finally {
    await db.close().catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(`\n${err.stack || err}\n`);
  process.exit(1);
});
