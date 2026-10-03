'use strict';

/**
 * The database handle every service talks to.
 *
 * One SQL dialect — PostgreSQL — behind two drivers:
 *
 *   • **PGlite** (`@electric-sql/pglite`): PostgreSQL compiled to WebAssembly and
 *     embedded in this process. It is what local development and the whole test
 *     suite run on, so `npm test` needs no database server, no container and no
 *     setup on anyone's laptop — while still exercising real PostgreSQL rather
 *     than an approximation of it.
 *   • **pg**: a connection pool to a hosted PostgreSQL (Supabase), which is what
 *     the deployed app uses. Serverless functions do not keep a disk, so the data
 *     has to live somewhere that outlives the request.
 *
 * Both are driven through the same small surface, modelled on `node:sqlite` so
 * the services read the way they always did:
 *
 *     const row  = await db.prepare('SELECT * FROM t WHERE id = ?').get(id);
 *     const rows = await db.prepare('SELECT * FROM t').all();
 *     const n    = (await db.prepare('DELETE FROM t').run()).changes;
 *     await db.transaction(async (tx) => { await tx.prepare(...).run(...); });
 *
 * Parameters stay `?`-style and are rewritten to PostgreSQL's `$1, $2, …` here,
 * so every call site keeps one placeholder convention.
 */

/**
 * Rewrites `?` placeholders as `$1, $2, …`.
 *
 * Quoted strings, quoted identifiers and comments are skipped, so a literal
 * question mark inside a string is left alone rather than being mistaken for a
 * parameter and silently shifting every placeholder after it.
 */
function toPgPlaceholders(sql) {
  let out = '';
  let n = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];

    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { j += 2; continue; } // an escaped quote
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j;
      continue;
    }

    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }

    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }

    if (c === '?') {
      n += 1;
      out += `$${n}`;
      continue;
    }

    out += c;
  }
  return out;
}

/** `undefined` is not a value PostgreSQL accepts; it means SQL NULL here. */
const normalizeParams = (params) => params.map((p) => (p === undefined ? null : p));

class Statement {
  constructor(runner, sql) {
    this.runner = runner;
    this.text = toPgPlaceholders(sql);
  }

  async all(...params) {
    const res = await this.runner(this.text, normalizeParams(params));
    return res.rows;
  }

  async get(...params) {
    const rows = await this.all(...params);
    return rows.length ? rows[0] : undefined;
  }

  /** `changes` mirrors node:sqlite, so callers that counted rows still do. */
  async run(...params) {
    const res = await this.runner(this.text, normalizeParams(params));
    return { changes: res.rowCount ?? 0 };
  }
}

/** The handle passed to a `transaction` callback: one connection, nothing else. */
class TransactionHandle {
  constructor(runner) {
    this.runner = runner;
  }

  prepare(sql) {
    return new Statement(this.runner, sql);
  }

  async exec(sql) {
    await this.runner(sql, []);
  }
}

// --------------------------------------------------------------------- PGlite

class PGliteDatabase {
  constructor(pglite, { location }) {
    this.pglite = pglite;
    this.location = location;
    this.driver = 'pglite';
    // Only ever one connection, so a transaction cannot interleave with anything.
    this.inTransaction = false;
  }

  #runner = async (text, params) => {
    const res = params.length
      ? await this.pglite.query(text, params)
      : await this.pglite.exec(text).then((r) => r[r.length - 1] ?? { rows: [], affectedRows: 0 });
    return { rows: res.rows ?? [], rowCount: res.affectedRows ?? (res.rows ? res.rows.length : 0) };
  };

  prepare(sql) {
    return new Statement(this.#runner, sql);
  }

  async exec(sql) {
    await this.pglite.exec(sql);
  }

  async transaction(fn) {
    await this.exec('BEGIN');
    try {
      const result = await fn(new TransactionHandle(this.#runner));
      await this.exec('COMMIT');
      return result;
    } catch (err) {
      await this.exec('ROLLBACK');
      throw err;
    }
  }

  async close() {
    await this.pglite.close();
  }
}

// ------------------------------------------------------------------------- pg

class PgDatabase {
  constructor(pool, { location }) {
    this.pool = pool;
    this.location = location;
    this.driver = 'pg';
  }

  #runner = async (text, params) => {
    const res = await this.pool.query(text, params);
    return { rows: res.rows ?? [], rowCount: res.rowCount ?? 0 };
  };

  prepare(sql) {
    return new Statement(this.#runner, sql);
  }

  async exec(sql) {
    await this.pool.query(sql);
  }

  /**
   * A transaction takes a connection out of the pool for its whole life — the
   * queries inside must run on that one connection, or a concurrent request
   * could commit half of someone else's work.
   */
  async transaction(fn) {
    const client = await this.pool.connect();
    const runner = async (text, params) => {
      const res = await client.query(text, params);
      return { rows: res.rows ?? [], rowCount: res.rowCount ?? 0 };
    };
    try {
      await client.query('BEGIN');
      const result = await fn(new TransactionHandle(runner));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* the connection is going anyway */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

/**
 * Opens a database.
 *
 * @param {string} location
 *   - `':memory:'` (the default) — an in-process PGlite, discarded on exit.
 *   - a path — a PGlite data directory on local disk.
 *   - `postgres://…` / `postgresql://…` — a hosted PostgreSQL.
 */
async function connect(location = ':memory:') {
  if (/^postgres(ql)?:\/\//.test(location)) {
    // Required only on this path, so a local run never needs the dependency.
    // eslint-disable-next-line global-require
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: location,
      // Supabase terminates TLS with its own certificate chain.
      ssl: /supabase|neon|render|railway/.test(location) ? { rejectUnauthorized: false } : undefined,
      // A serverless function is one short request; a big pool would exhaust the
      // database's connection limit the moment several instances wake up.
      max: Number(process.env.KINERA_DB_POOL || 3),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    try {
      const probe = await pool.connect();
      probe.release();
    } catch (err) {
      await pool.end().catch(() => {});
      throw new Error(
        `Cannot reach the database named by KINERA_DB_URL: ${err.message}. `
        + 'Check the connection string, that the database is running, and that it '
        + 'accepts connections from this host.',
      );
    }
    return new PgDatabase(pool, { location });
  }

  // eslint-disable-next-line global-require
  const { PGlite } = require('@electric-sql/pglite');
  if (location !== ':memory:') {
    // PGlite creates its own data directory but not the path leading to it, so a
    // first run against `data/pgdata` would otherwise fail with ENOENT.
    // eslint-disable-next-line global-require
    const fs = require('node:fs');
    // eslint-disable-next-line global-require
    const path = require('node:path');
    try {
      fs.mkdirSync(path.dirname(path.resolve(location)), { recursive: true });
    } catch (err) {
      throw new Error(`Cannot create the database directory for ${location}: ${err.message}`);
    }
  }
  const pglite = location === ':memory:' ? new PGlite() : new PGlite(location);
  await pglite.waitReady;
  return new PGliteDatabase(pglite, { location });
}

module.exports = { connect, toPgPlaceholders, Statement };
