'use strict';

/**
 * The Vercel entry point.
 *
 * `src/server.js` runs the app as a long-lived process; this runs the same
 * Express app as a serverless function. Two things matter here:
 *
 *  1. **The app is built once per instance, not once per request.** The promise
 *     is held in module scope, so a warm instance reuses the same app and the
 *     same PostgreSQL pool. Building it per request would open a new pool every
 *     time and exhaust the database's connection limit within a few minutes.
 *
 *  2. **Nothing is seeded here.** Seeding hashes ten passwords with scrypt, which
 *     is deliberately slow, and a cold start must not pay for that. The database
 *     is prepared once, before deploying, by `scripts/setup-database.js`.
 */

const { createApp } = require('../src/app');

const DB_URL = process.env.KINERA_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;

let appPromise = null;

function getApp() {
  if (!appPromise) {
    appPromise = createApp({
      dbLocation: DB_URL,
      // The schema is already applied and the accounts already exist.
      seedData: false,
      // Behind Vercel's proxy, req.ip comes from X-Forwarded-For — without this
      // every visitor looks like the proxy to the rate limiter and the first
      // twenty registrations would use up everyone's budget.
      trustProxy: process.env.KINERA_TRUST_PROXY || 'true',
    }).catch((err) => {
      // Let the next request try again rather than caching a failed start — a
      // database that was briefly unreachable should not break the instance
      // until it happens to be recycled.
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
}

module.exports = async (req, res) => {
  if (!DB_URL) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      error: {
        code: 'DATABASE_NOT_CONFIGURED',
        message: 'KINERA_DB_URL is not set on this deployment.',
      },
    }));
    return;
  }

  try {
    const app = await getApp();
    app(req, res);
  } catch (err) {
    process.stderr.write(`[startup] ${err.stack || err}\n`);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Retry-After', '5');
    res.end(JSON.stringify({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'The service is starting up. Please try again in a moment.',
      },
    }));
  }
};
