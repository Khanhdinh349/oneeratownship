'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./adapter');
const { migrate } = require('./migrate');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/**
 * Opens the database, applies the schema and brings an older one up to date.
 *
 * @param {string} location `':memory:'`, a PGlite data directory, or a
 *   `postgres://` connection string. See `adapter.js`.
 */
async function openDatabase(location = ':memory:') {
  const db = await connect(location);
  try {
    await db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    // CREATE TABLE IF NOT EXISTS never alters an existing table, so a database
    // from an earlier release is brought up to date here.
    db.migrations = await migrate(db);
  } catch (err) {
    await db.close().catch(() => {});
    throw err;
  }
  return db;
}

module.exports = { openDatabase };
