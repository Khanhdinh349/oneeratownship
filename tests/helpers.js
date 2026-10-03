'use strict';

// Lower the scrypt work factor for the suite only: each test builds a fresh
// in-memory database and seeds fourteen staff accounts, and the production cost
// would dominate the run time. Same algorithm, same code paths.
process.env.KINERA_SCRYPT_COST = process.env.KINERA_SCRYPT_COST || '1024';

// Seeded accounts normally have to change their password at the first sign-in.
// Nearly every test signs in as one and is about something else, so the suite
// seeds them as already changed; admin.test.js covers the requirement itself,
// on accounts an administrator creates and on a database seeded the real way.
process.env.KINERA_SEED_REQUIRE_PASSWORD_CHANGE = process.env.KINERA_SEED_REQUIRE_PASSWORD_CHANGE || '0';

const { createApp } = require('../src/app');

/** Fixed "now" so the 10-day booking window is deterministic. */
const FIXED_NOW = new Date('2026-10-01T02:30:00.000Z'); // 01/10/2026, 09:30 ICT
const TODAY = '2026-10-01';
const PLUS_10 = '2026-10-11';
const PLUS_11 = '2026-10-12';

const OFFICE_CII = 'CII_BINH_THANH';
const OFFICE_TG = 'THUAN_GIAO_BINH_DUONG';
const SLOT_A = 'SLOT_0900_1030';   // 09:00 – 10:30
const SLOT_B = 'SLOT_1300_1430';   // 13:00 – 14:30 — a second, distinct slot
const SLOT_1030 = 'SLOT_1030_1200';

/** A mutable clock so a test can move time forward mid-scenario. */
function makeClock(initial = FIXED_NOW) {
  let current = new Date(initial);
  const clock = () => new Date(current);
  clock.set = (d) => { current = new Date(d); };
  clock.setDate = (iso, time = 'T02:30:00.000Z') => { current = new Date(`${iso}${time}`); };
  return clock;
}

async function buildApp(overrides = {}) {
  const clock = overrides.clock || makeClock();
  const app = await createApp({
    dbLocation: ':memory:',
    clock,
    secret: 'test-secret',
    qrSecret: 'test-qr-secret',
    publicBaseUrl: 'https://test.kinera.local',
    ...overrides,
  });
  return { app, clock, services: app.locals.services };
}

/** Starts the app on an ephemeral port and returns a small fetch wrapper. */
async function startServer(overrides = {}) {
  const { app, clock, services } = await buildApp(overrides);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, path, { body, token, raw = false } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) return res;
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: json };
  }

  return {
    base,
    clock,
    services,
    request,
    get: (p, o) => request('GET', p, o),
    post: (p, b, o) => request('POST', p, { body: b, ...(o || {}) }),
    patch: (p, b, o) => request('PATCH', p, { body: b, ...(o || {}) }),
    async login(username, password) {
      const res = await request('POST', '/api/auth/login', { body: { username, password } });
      if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.body)}`);
      return res.body;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await app.locals.close();
    },
  };
}

/** Valid visitor payload; override any field. */
function visitorPayload(over = {}) {
  return {
    language: 'vi',
    salesOfficeId: OFFICE_CII,
    visitorType: 'VISITOR',
    fullName: 'Nguyễn Văn A',
    cccd: '012345678901',
    phone: '0901234567',
    email: 'nguyenvana@example.com',
    numberOfVisitors: 3,
    visitDate: '2026-10-05',
    timeSlotId: SLOT_A,
    notes: 'Ghi chú kiểm thử',
    ...over,
  };
}

/** Valid agency payload; override any field. */
function agencyPayload(over = {}) {
  return {
    language: 'en',
    salesOfficeId: OFFICE_TG,
    visitorType: 'AGENCY',
    agencyId: 'AG_IQI',
    salesStaffName: 'Nguyễn Văn B',
    salesStaffCccd: '098765432109',
    salesStaffPhone: '0912345678',
    customerShortName: 'N.V.C',
    customerPhoneLast4: '4321',
    numberOfVisitors: 5,
    visitDate: '2026-10-06',
    timeSlotId: SLOT_1030,
    notes: null,
    ...over,
  };
}

const CREDS = {
  ciiReception: ['cii.reception01', 'Reception@123'],
  ciiReception2: ['cii.reception02', 'Reception@123'],
  tgReception: ['tg.reception01', 'Reception@123'],
  ciiSales: ['cii.sales01', 'Sales@123'],
  manager: ['manager01', 'Manager@123'],
  admin: ['admin', 'Admin@123'],
};

module.exports = {
  FIXED_NOW, TODAY, PLUS_10, PLUS_11,
  OFFICE_CII, OFFICE_TG, SLOT_A, SLOT_B, SLOT_1030,
  makeClock, buildApp, startServer, visitorPayload, agencyPayload, CREDS,
};
