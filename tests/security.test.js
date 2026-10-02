'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startServer, makeClock, visitorPayload, CREDS, SLOT_A, SLOT_1030 } = require('./helpers');
const { createApp } = require('../src/app');

async function server(t, overrides = {}) {
  const s = await startServer(overrides);
  t.after(() => s.close());
  return s;
}

// ===========================================================================
// production configuration
// ===========================================================================

test('the app refuses to start in production on the development secrets', async () => {
  await assert.rejects(
    () => createApp({ production: true }),
    (err) => {
      assert.match(err.message, /Refusing to start in production/);
      assert.match(err.message, /KINERA_SECRET/);
      assert.match(err.message, /KINERA_QR_SECRET/);
      assert.match(err.message, /KINERA_PUBLIC_URL/);
      return true;
    },
  );
});

test('production names only the settings that are actually missing', async () => {
  await assert.rejects(
    () => createApp({ production: true, secret: 'a-real-secret', qrSecret: 'another-real-secret' }),
    (err) => {
      assert.equal(err.message.includes('KINERA_SECRET,'), false, 'the supplied secret is not flagged');
      assert.match(err.message, /KINERA_PUBLIC_URL/);
      return true;
    },
  );
});

test('production starts once every secret is supplied', async () => {
  const app = await createApp({
    production: true,
    secret: 'a-real-secret',
    qrSecret: 'another-real-secret',
    publicBaseUrl: 'https://dangky.oneera.vn',
  });
  assert.ok(app);
  await app.locals.close();
});

test('development still starts with no configuration at all', async () => {
  const app = await createApp({});
  assert.ok(app);
  await app.locals.close();
});

// ===========================================================================
// security headers
// ===========================================================================

test('every response carries the security headers', async (t) => {
  const s = await server(t);
  const res = await s.request('GET', '/api/health', { raw: true });

  const csp = res.headers.get('content-security-policy');
  assert.ok(csp, 'a CSP is sent');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/, 'the app cannot be framed');
  assert.match(csp, /object-src 'none'/);
  assert.equal(csp.includes("script-src 'self' 'unsafe-inline'"), false,
    'no unsafe-inline for scripts');
  assert.equal(csp.includes('unsafe-eval'), false);

  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(res.headers.get('x-powered-by'), null, 'the server does not advertise Express');
});

test('HSTS is sent in production and withheld in development', async (t) => {
  const dev = await server(t);
  assert.equal((await dev.request('GET', '/api/health', { raw: true }))
    .headers.get('strict-transport-security'), null);

  const prod = await server(t, {
    production: true,
    secret: 'a-real-secret',
    qrSecret: 'another-real-secret',
    publicBaseUrl: 'https://dangky.oneera.vn',
  });
  assert.match((await prod.request('GET', '/api/health', { raw: true }))
    .headers.get('strict-transport-security'), /max-age=31536000/);
});

test('the CSP permits the fonts and media the app actually uses', async (t) => {
  const s = await server(t);
  const csp = (await s.request('GET', '/', { raw: true })).headers.get('content-security-policy');
  assert.match(csp, /font-src[^;]*fonts\.gstatic\.com/, 'Inter loads');
  assert.match(csp, /style-src[^;]*fonts\.googleapis\.com/);
  assert.match(csp, /img-src[^;]*blob:/, 'the QR download blob works');
  assert.match(csp, /media-src[^;]*blob:/, 'the camera preview works');
});

test('HTML is served no-cache so a deploy is picked up immediately', async (t) => {
  const s = await server(t);
  const html = await s.request('GET', '/index.html', { raw: true });
  assert.match(html.headers.get('cache-control'), /no-cache/);
});

// ===========================================================================
// rate limiting
// ===========================================================================

test('repeated failed sign-ins are throttled', async (t) => {
  const s = await server(t, { rateLimits: { loginMax: 5, loginWindowMs: 60000 } });

  const attempt = () => s.post('/api/auth/login', { username: 'cii.reception01', password: 'wrong' });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await attempt()).status, 401, `attempt ${i + 1} is a normal rejection`);
  }
  const blocked = await attempt();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'TOO_MANY_LOGIN_ATTEMPTS');

  // Even the correct password is refused while the window is open.
  const correct = await s.post('/api/auth/login', {
    username: 'cii.reception01', password: 'Reception@123',
  });
  assert.equal(correct.status, 429);
});

test('the throttle is per username, so one person cannot lock out the desk', async (t) => {
  const s = await server(t, { rateLimits: { loginMax: 3, loginWindowMs: 60000 } });
  for (let i = 0; i < 4; i += 1) {
    await s.post('/api/auth/login', { username: 'cii.reception01', password: 'wrong' });
  }
  assert.equal((await s.post('/api/auth/login', {
    username: 'cii.reception01', password: 'Reception@123',
  })).status, 429, 'the fumbled account is locked');

  const colleague = await s.post('/api/auth/login', {
    username: 'cii.reception02', password: 'Reception@123',
  });
  assert.equal(colleague.status, 200, 'a different receptionist still signs in');
});

test('a successful sign-in clears that identity\'s failed-attempt budget', async (t) => {
  const s = await server(t, { rateLimits: { loginMax: 4, loginWindowMs: 60000 } });
  for (let i = 0; i < 3; i += 1) {
    await s.post('/api/auth/login', { username: 'cii.reception01', password: 'wrong' });
  }
  assert.equal((await s.post('/api/auth/login', {
    username: 'cii.reception01', password: 'Reception@123',
  })).status, 200);

  // The budget is reset, so three more fumbles are still tolerated.
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await s.post('/api/auth/login', {
      username: 'cii.reception01', password: 'wrong',
    })).status, 401, `post-reset attempt ${i + 1}`);
  }
});

test('the throttle window expires', async (t) => {
  const clock = makeClock('2026-10-01T02:30:00.000Z');
  const s = await server(t, { clock, rateLimits: { loginMax: 2, loginWindowMs: 60000 } });

  for (let i = 0; i < 3; i += 1) {
    await s.post('/api/auth/login', { username: 'cii.reception01', password: 'wrong' });
  }
  assert.equal((await s.post('/api/auth/login', {
    username: 'cii.reception01', password: 'Reception@123',
  })).status, 429);

  clock.set('2026-10-01T02:32:00.000Z');   // two minutes later
  assert.equal((await s.post('/api/auth/login', {
    username: 'cii.reception01', password: 'Reception@123',
  })).status, 200, 'the window has rolled over');
});

test('public registration is throttled so the slot table cannot be flooded', async (t) => {
  const s = await server(t, { rateLimits: { registerMax: 3, registerWindowMs: 60000 } });
  const days = ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];

  for (let i = 0; i < 3; i += 1) {
    const res = await s.post('/api/registrations', visitorPayload({
      cccd: String(600000000000 + i), visitDate: days[i], numberOfVisitors: 1,
    }));
    assert.equal(res.status, 201, `registration ${i + 1}`);
  }
  const blocked = await s.post('/api/registrations', visitorPayload({
    cccd: '699999999999', visitDate: days[3], numberOfVisitors: 1,
  }));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'TOO_MANY_REGISTRATIONS');
});

test('throttling advertises the standard RateLimit headers', async (t) => {
  const s = await server(t, { rateLimits: { loginMax: 2, loginWindowMs: 60000 } });
  const first = await s.request('POST', '/api/auth/login', {
    body: { username: 'x', password: 'y' }, raw: true,
  });
  assert.equal(first.headers.get('ratelimit-limit'), '2');
  assert.equal(first.headers.get('ratelimit-remaining'), '1');
  assert.ok(Number(first.headers.get('ratelimit-reset')) > 0);

  await s.post('/api/auth/login', { username: 'x', password: 'y' });
  const blocked = await s.request('POST', '/api/auth/login', {
    body: { username: 'x', password: 'y' }, raw: true,
  });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'Retry-After tells the client when');
});

test('reading and checking in are not throttled by the public limits', async (t) => {
  const s = await server(t, { rateLimits: { registerMax: 1, loginMax: 1 } });
  for (let i = 0; i < 25; i += 1) {
    assert.equal((await s.get('/api/config')).status, 200, `config read ${i + 1}`);
  }
  const staff = await s.login(...CREDS.ciiReception);
  for (let i = 0; i < 25; i += 1) {
    assert.equal((await s.get('/api/staff/registrations', { token: staff.token })).status, 200);
  }
});

// ===========================================================================
// error handling does not leak internals
// ===========================================================================

test('an unexpected failure returns a generic message, not a stack trace', async (t) => {
  const s = await server(t);
  const staff = await s.login(...CREDS.manager);

  // Force an internal failure by closing the database under the running app.
  await s.services.db.close();
  const res = await s.get('/api/staff/registrations', { token: staff.token });

  assert.equal(res.status, 500);
  assert.equal(res.body.error.code, 'INTERNAL_ERROR');
  assert.equal(res.body.error.message, 'Unexpected server error.');
  const dump = JSON.stringify(res.body);
  assert.equal(/at \w+ \(/.test(dump), false, 'no stack frames');
  assert.equal(/pglite|postgres|PGlite/i.test(dump), false, 'no driver internals');
  assert.equal(dump.includes('/home/'), false, 'no filesystem paths');
});

// ===========================================================================
// database backends
// ===========================================================================

test('the embedded database persists to a directory and survives a reopen', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { openDatabase } = require('../src/db');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinera-db-'));
  const location = path.join(dir, 'nested', 'pgdata');

  const first = await openDatabase(location);
  assert.equal(first.driver, 'pglite', 'no database server is needed locally');
  await first.exec("INSERT INTO agencies (id, name, active) VALUES ('T', 'Test', 1)");
  await first.close();

  // Reopening finds the row: this is a real database on disk, not a scratch copy.
  const second = await openDatabase(location);
  assert.equal(Number((await second.prepare('SELECT COUNT(*) AS c FROM agencies').get()).c), 1);
  await second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an in-memory database leaves nothing behind', async () => {
  const { openDatabase } = require('../src/db');
  const db = await openDatabase(':memory:');
  assert.equal(db.driver, 'pglite');
  assert.equal(db.location, ':memory:');
  await db.close();
});

test('an unreachable PostgreSQL fails with an actionable message, not a stack trace', async () => {
  const { openDatabase } = require('../src/db');
  // Port 1 is reserved and never listening, so this fails the same way anywhere.
  await assert.rejects(
    () => openDatabase('postgresql://kinera:secret@127.0.0.1:1/kinera'),
    (err) => {
      assert.match(err.message, /Cannot reach the database named by KINERA_DB_URL/);
      assert.equal(err.message.includes('secret'), false, 'the password is never echoed');
      return true;
    },
  );
});

test('parameters are bound, never interpolated into the SQL', async () => {
  const { openDatabase } = require('../src/db');
  const { toPgPlaceholders } = require('../src/db/adapter');
  const db = await openDatabase(':memory:');

  // A value that would end the statement if it were pasted in as text.
  const hostile = "x'); DROP TABLE agencies; --";
  await db.prepare('INSERT INTO agencies (id, name, active) VALUES (?, ?, 1)').run('H', hostile);
  const row = await db.prepare('SELECT name FROM agencies WHERE id = ?').get('H');
  assert.equal(row.name, hostile, 'stored verbatim');
  assert.ok(await db.prepare('SELECT 1 AS ok FROM agencies LIMIT 1').get(), 'the table still exists');

  // A question mark inside a string literal is not a placeholder.
  assert.equal(toPgPlaceholders("SELECT 'why? because' WHERE a = ?"),
    "SELECT 'why? because' WHERE a = $1");
  await db.close();
});

test('a failed transaction leaves nothing behind', async () => {
  const { openDatabase } = require('../src/db');
  const db = await openDatabase(':memory:');
  await assert.rejects(() => db.transaction(async (tx) => {
    await tx.prepare('INSERT INTO agencies (id, name, active) VALUES (?,?,1)').run('R1', 'Rolled back');
    throw new Error('something went wrong half way');
  }), /something went wrong/);
  assert.equal(await db.prepare('SELECT * FROM agencies WHERE id = ?').get('R1'), undefined);
  await db.close();
});
