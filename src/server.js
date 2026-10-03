'use strict';

const path = require('node:path');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

/**
 * Where the data lives.
 *
 * `KINERA_DB_URL` is a hosted PostgreSQL connection string and is what a
 * deployment sets. Without it the app runs on an embedded PGlite database in
 * `data/`, which needs no database server — the zero-setup local default.
 */
const DB_LOCATION = process.env.KINERA_DB_URL
  || process.env.KINERA_DB
  || path.join(__dirname, '..', 'data', 'pgdata');

const describeDb = (location) => (/^postgres(ql)?:\/\//.test(location)
  // Never print the password.
  ? `PostgreSQL at ${(() => { try { return new URL(location).host; } catch { return 'configured host'; } })()}`
  : `PGlite (embedded) at ${location}`);

async function main() {
  let app;
  try {
    app = await createApp({ dbLocation: DB_LOCATION });
  } catch (err) {
    process.stderr.write(`\n${err.message}\n\n`);
    process.exit(1);
  }

  const server = app.listen(PORT, HOST, () => {
    process.stdout.write(`ONE ERA Registration System listening on http://${HOST}:${PORT}\n`);
    process.stdout.write('  Visitor registration : /\n');
    process.stdout.write('  Staff area           : /staff.html\n');
    process.stdout.write(`  Database             : ${describeDb(DB_LOCATION)}\n`);
    process.stdout.write(`  Mode                 : ${process.env.NODE_ENV || 'development'}\n`);
  });

  /**
   * Close cleanly on a deploy or container stop: stop accepting connections, let
   * in-flight requests finish, then close the database so pooled connections are
   * returned rather than dropped.
   */
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n${signal} received — shutting down.\n`);

    const force = setTimeout(() => {
      process.stderr.write('Did not close in time; exiting anyway.\n');
      process.exit(1);
    }, 10000);
    force.unref();

    server.close(async () => {
      try { await app.locals.close(); } catch { /* already closed */ }
      clearTimeout(force);
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[uncaughtException] ${err.stack || err}\n`);
    shutdown('uncaughtException');
  });
}

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[unhandledRejection] ${reason instanceof Error ? reason.stack : reason}\n`);
});

main();
