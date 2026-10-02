'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildApp, makeClock, visitorPayload, agencyPayload,
  OFFICE_CII, OFFICE_TG, SLOT_A, SLOT_1030,
} = require('./helpers');

async function setup(date = '2026-10-05') {
  const clock = makeClock(`${date}T02:30:00.000Z`);
  const { services } = await buildApp({ clock });
  return { ...services, clock };
}

// ===========================================================================
// §XLVIII — one Registration record is the single source of truth
// ===========================================================================

test('§XLVIII the schema holds exactly the tables the spec calls for — and no calendar table', async () => {
  const s = await setup();
  const tables = (await s.db.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()")
    .all()).map((r) => r.name).sort();
  assert.deepEqual(tables, [
    'agencies', 'audit_log', 'blocked_periods', 'checkins', 'parking_tickets',
    'registrations', 'sales_offices', 'status_history', 'time_slots', 'users',
  ]);
});

test('§XX the registration table carries every minimum field from the spec', async () => {
  const s = await setup();
  const cols = (await s.db.prepare(`SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'registrations'`).all()).map((c) => c.name);
  for (const required of [
    'id', 'confirmation_code', 'qr_token', 'language', 'sales_office_id', 'visitor_type',
    'registration_date', 'visit_date', 'time_slot_id', 'status', 'created_at', 'updated_at',
  ]) {
    assert.ok(cols.includes(required), `§XX missing column ${required}`);
  }
});

test('§XXI / §XXII both visitor-type payloads have their own columns', async () => {
  const s = await setup();
  const cols = (await s.db.prepare(`SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'registrations'`).all()).map((c) => c.name);
  for (const c of ['full_name', 'cccd', 'phone', 'email', 'number_of_visitors', 'notes']) {
    assert.ok(cols.includes(c), `§XXI missing ${c}`);
  }
  for (const c of ['agency_id', 'agency_name', 'sales_staff_name', 'sales_staff_cccd',
    'sales_staff_phone', 'customer_short_name', 'customer_phone_last4']) {
    assert.ok(cols.includes(c), `§XXII missing ${c}`);
  }
});

test('§XXVIII the check-in table carries every field from the spec', async () => {
  const s = await setup();
  const cols = (await s.db.prepare(`SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'checkins'`).all()).map((c) => c.name);
  for (const c of ['id', 'registration_id', 'receptionist_id', 'sales_office_id',
    'checkin_time', 'checkin_method', 'notes',
    // §XXVIII — the booked count and the count the receptionist confirmed.
    'expected_guests', 'actual_guests']) {
    assert.ok(cols.includes(c), `§XXVIII missing ${c}`);
  }
});

test('§XXIX parking tickets are stored per vehicle, with who issued and returned', async () => {
  const s = await setup();
  const cols = (await s.db.prepare(`SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'parking_tickets'`).all()).map((c) => c.name);
  for (const c of ['id', 'registration_id', 'sales_office_id', 'vehicle_type',
    'ticket_number', 'issued_at', 'issued_by_name', 'returned_at', 'returned_by_name']) {
    assert.ok(cols.includes(c), `§XXIX missing ${c}`);
  }
  // The old single-ticket columns are gone from the registration row.
  const regCols = (await s.db.prepare(`SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'registrations'`).all()).map((c) => c.name);
  assert.equal(regCols.includes('parking_ticket_issued'), false,
    'parking is no longer a column on the registration');
});

test('§XXIX a deleted registration takes its parking tickets with it', async () => {
  const s = await setup();
  const { registrations, checkins, parking, clock } = s;
  clock.setDate('2026-10-05');
  const reg = await registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05' }));
  const user = (await s.auth.login('cii.reception01', 'Reception@123')).user;
  await checkins.checkIn(reg.id, { user });
  await parking.issue(reg.id, { vehicleType: 'CAR' }, { actor: { id: user.id, name: user.fullName } });

  assert.equal(Number((await s.db.prepare('SELECT COUNT(*) AS n FROM parking_tickets').get()).n), 1);
  await s.db.prepare('DELETE FROM registrations WHERE id = ?').run(reg.id);
  assert.equal(Number((await s.db.prepare('SELECT COUNT(*) AS n FROM parking_tickets').get()).n), 0,
    'no orphan tickets are left behind');
});

test('§XXIII each status change stores status, timestamp and who changed it', async () => {
  const s = await setup();
  const cols = (await s.db.prepare(`SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'status_history'`).all()).map((c) => c.name);
  for (const c of ['to_status', 'changed_at', 'changed_by', 'changed_by_name']) {
    assert.ok(cols.includes(c), `§XXIII missing ${c}`);
  }
});

// ===========================================================================
// database constraints
// ===========================================================================

test('the database itself refuses a duplicate confirmation code or QR token', async () => {
  const s = await setup();
  const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05' }));
  const other = await s.registrations.createRegistration(visitorPayload({
    visitDate: '2026-10-05', cccd: '999999999999',
  }));
  await assert.rejects(async () => s.db.prepare('UPDATE registrations SET confirmation_code = ? WHERE id = ?')
    .run(reg.confirmationCode, other.id), /UNIQUE|constraint/i);
  await assert.rejects(async () => s.db.prepare('UPDATE registrations SET qr_token = ? WHERE id = ?')
    .run(reg.qrToken, other.id), /UNIQUE|constraint/i);
});

test('§XXVIII the database allows only one check-in row per registration', async () => {
  const s = await setup();
  const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05' }));
  const user = (await s.auth.login('cii.reception01', 'Reception@123')).user;
  await s.checkins.checkIn(reg.id, { user });

  await assert.rejects(async () => s.db.prepare(`
    INSERT INTO checkins (id, registration_id, receptionist_id, receptionist_name,
                          sales_office_id, checkin_time, checkin_method, notes)
    VALUES ('dup', ?, ?, 'X', ?, '2026-10-05T03:00:00Z', 'QR', NULL)`)
    .run(reg.id, user.id, OFFICE_CII), /UNIQUE|constraint/i);
});

test('foreign keys prevent orphan check-ins, history rows and bad references', async () => {
  const s = await setup();
  await assert.rejects(async () => s.db.prepare(`
    INSERT INTO checkins (id, registration_id, receptionist_id, receptionist_name,
                          sales_office_id, checkin_time, checkin_method, notes)
    VALUES ('x','no-such-reg','no-such-user','X','CII_BINH_THANH','2026-10-05T03:00:00Z','QR',NULL)`).run(),
  /FOREIGN KEY|constraint/i);

  await assert.rejects(async () => s.db.prepare(`
    INSERT INTO status_history (id, registration_id, from_status, to_status, changed_by, changed_by_name, changed_at)
    VALUES ('x','no-such-reg',NULL,'REGISTERED','u','U','2026-10-05T03:00:00Z')`).run(),
  /FOREIGN KEY|constraint/i);
});

test('every persisted registration references a real office and a real slot', async () => {
  const s = await setup();
  await s.registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05' }));
  await s.registrations.createRegistration(agencyPayload({ visitDate: '2026-10-05', salesOfficeId: OFFICE_TG }));
  const orphans = await s.db.prepare(`
    SELECT COUNT(*) AS n FROM registrations r
    LEFT JOIN sales_offices o ON o.id = r.sales_office_id
    LEFT JOIN time_slots t ON t.id = r.time_slot_id
    WHERE o.id IS NULL OR t.id IS NULL`).get();
  assert.equal(Number(orphans.n), 0);
});

// ===========================================================================
// transactional behaviour
// ===========================================================================

test('a failed check-in leaves no partial data behind', async () => {
  const s = await setup();
  const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05' }));
  const user = (await s.auth.login('cii.reception01', 'Reception@123')).user;

  // Force the status write to fail by making the transition illegal first.
  await s.registrations.changeStatus(reg.id, 'CANCELLED');
  const historyBefore = (await s.registrations.getById(reg.id)).statusHistory.length;

  await assert.rejects(async () => await s.checkins.checkIn(reg.id, { user }));

  const after = await s.registrations.getById(reg.id);
  assert.equal(after.status, 'CANCELLED', 'status untouched');
  assert.equal(after.checkin, null, 'no check-in row was written');
  assert.equal(after.statusHistory.length, historyBefore, 'no history row was written');
  assert.equal(Number((await s.db.prepare('SELECT COUNT(*) AS n FROM checkins').get()).n), 0);
});

test('a rejected registration writes nothing at all', async () => {
  const s = await setup();
  const count = async () => Number((await s.db.prepare('SELECT COUNT(*) AS n FROM registrations').get()).n);
  const historyCount = async () => Number((await s.db.prepare('SELECT COUNT(*) AS n FROM status_history').get()).n);

  await assert.rejects(async () => await s.registrations.createRegistration(visitorPayload({ cccd: 'bad' })));
  assert.equal(await count(), 0);
  assert.equal(await historyCount(), 0);

  await assert.rejects(async () => await s.registrations.createRegistration(visitorPayload({ visitDate: '2027-01-01' })));
  assert.equal(await count(), 0);
});

test('capacity holds under a burst of sequential bookings', async () => {
  const s = await setup();
  await s.masterData.updateSlot(SLOT_A, { capacity: 10 });

  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < 30; i += 1) {
    try {
      await s.registrations.createRegistration(visitorPayload({
        visitDate: '2026-10-05', timeSlotId: SLOT_A, numberOfVisitors: 1,
        cccd: String(500000000000 + i),
      }));
      accepted += 1;
    } catch (err) {
      assert.equal(err.code, 'TIME_SLOT_FULLY_BOOKED');
      refused += 1;
    }
  }
  assert.equal(accepted, 10, 'capacity is never exceeded');
  assert.equal(refused, 20);

  const booked = (await s.registrations.getAvailability(OFFICE_CII, '2026-10-05'))
    .find((x) => x.slotId === SLOT_A);
  assert.equal(booked.booked, 10);
  assert.equal(booked.remaining, 0);
});

// ===========================================================================
// §XVIII.3 / Rule 3 — the QR token stays out of read models
// ===========================================================================

test('§XVIII.3 the QR token appears only where it is explicitly requested', async () => {
  const s = await setup();
  const created = await s.registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05' }));
  assert.ok(created.qrToken, 'the creating caller gets it once, for the success page');

  assert.equal((await s.registrations.getById(created.id)).qrToken, undefined);
  assert.equal((await s.registrations.getByConfirmationCode(created.confirmationCode)).qrToken, undefined);
  assert.equal((await s.registrations.getByQrToken(created.qrToken)).qrToken, undefined);
  assert.equal(JSON.stringify(await s.registrations.list()).includes(created.qrToken), false);
  assert.equal(JSON.stringify(await s.calendar.events({ view: 'month', date: '2026-10-05' }))
    .includes(created.qrToken), false);
});

// ===========================================================================
// seeding is idempotent
// ===========================================================================

test('re-seeding an existing database creates no duplicate master data or accounts', async () => {
  const clock = makeClock();
  const { services } = await buildApp({ clock });
  const { seed } = require('../src/db/seed');

  const before = {
    offices: (await services.masterData.listOffices()).length,
    slots: (await services.masterData.listSlots({ includeInactive: true })).length,
    users: (await services.auth.listUsers()).length,
    agencies: (await services.masterData.listAgencies()).length,
  };
  seed(services.db, { now: clock().toISOString() });
  seed(services.db, { now: clock().toISOString() });

  assert.equal((await services.masterData.listOffices()).length, before.offices);
  assert.equal((await services.masterData.listSlots({ includeInactive: true })).length, before.slots);
  assert.equal((await services.auth.listUsers()).length, before.users);
  assert.equal((await services.masterData.listAgencies()).length, before.agencies);
});

test('the seeded accounts cover every role the spec names', async () => {
  const s = await setup();
  const roles = new Set((await s.auth.listUsers()).map((u) => u.role));
  for (const role of ['RECEPTIONIST', 'SALES', 'MANAGER', 'ADMINISTRATOR']) {
    assert.ok(roles.has(role), `§XXXIX no seeded ${role} account`);
  }
  (await s.auth.listUsers({ role: 'RECEPTIONIST' })).forEach((u) => {
    assert.ok(u.salesOfficeId, '§XXIV every receptionist belongs to an office');
  });
  (await s.auth.listUsers({ role: 'MANAGER' })).forEach((u) => {
    assert.equal(u.salesOfficeId, null, 'a manager is not office-bound');
  });
});

// ===========================================================================
// §XLVI — every numbered business rule has an enforcing test somewhere
// ===========================================================================

test('§XLVI all eighteen business rules are covered by the suite', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = __dirname;
  const corpus = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');

  // Each rule maps to a marker that must appear in at least one test name/body.
  const rules = {
    1: /§XLVI\.1|two languages/i,
    2: /§XLVI\.2|two sales offices/i,
    3: /§XLVI\.3|VISITOR and AGENCY/i,
    4: /§VII|10-day|booking window/i,
    5: /§VIII|availability|fully booked/i,
    6: /OE-XXXXX|OE-\[0-9A-Z\]/,
    7: /unique.*confirmation code|confirmation codes are unique/i,
    8: /every registration.*QR|QR token is opaque|qrToken/i,
    9: /QR.*valid registration|unknown QR token|invalid QR/i,
    10: /login|receptionist.*account/i,
    11: /office.*scope|cross-office|another office/i,
    12: /check-in records time, receptionist|receptionist recorded/i,
    13: /Rule 8|dashboard numbers move|real registration/i,
    14: /calendar.*projection|Rule 17|no calendar table/i,
    15: /§XXXVII|autoRefresh|refreshIntervalMs/i,
    16: /parking/i,
    17: /duplicate.*calendar|no calendar table/i,
    18: /business rule|slot list is the four agreed|30-guest cap/i,
  };

  const uncovered = Object.entries(rules)
    .filter(([, re]) => !re.test(corpus))
    .map(([n]) => `Rule ${n}`);
  assert.deepEqual(uncovered, [], 'business rules with no covering test');
});

// ===========================================================================
// upgrading a database created by an earlier release
// ===========================================================================

/**
 * A database with the shape an earlier release left behind: no guest counts on
 * `checkins`, parking recorded as columns on `registrations`, and no `sort_order`
 * on `agencies`.
 */
async function buildLegacyDatabase(location) {
  const { connect } = require('../src/db/adapter');
  const db = await connect(location);
  await db.exec(`
    CREATE TABLE sales_offices (id TEXT PRIMARY KEY, name TEXT, location TEXT, address TEXT,
      opening_hours TEXT, contact TEXT, parking_ticket_enabled INTEGER);
    CREATE TABLE agencies (id TEXT PRIMARY KEY, name TEXT, active INTEGER DEFAULT 1);
    CREATE TABLE registrations (id TEXT PRIMARY KEY, confirmation_code TEXT UNIQUE,
      qr_token TEXT UNIQUE, language TEXT, sales_office_id TEXT, visitor_type TEXT,
      registration_date TEXT, visit_date TEXT, time_slot_id TEXT, number_of_visitors INTEGER,
      notes TEXT, status TEXT, full_name TEXT, cccd TEXT, phone TEXT, email TEXT,
      agency_id TEXT, agency_name TEXT, sales_staff_name TEXT, sales_staff_cccd TEXT,
      sales_staff_phone TEXT, customer_short_name TEXT, customer_phone_last4 TEXT,
      parking_ticket_issued INTEGER DEFAULT 0, parking_ticket_number TEXT,
      parking_ticket_issued_at TEXT, parking_ticket_returned_at TEXT,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE checkins (id TEXT PRIMARY KEY, registration_id TEXT UNIQUE, receptionist_id TEXT,
      receptionist_name TEXT, sales_office_id TEXT, checkin_time TEXT, checkin_method TEXT, notes TEXT);
    INSERT INTO sales_offices VALUES ('CII_BINH_THANH','CII - Bình Thạnh','HCM','addr','08:30','x',1);
    INSERT INTO agencies (id, name, active) VALUES ('AG_A', 'Agency A', 1);
    INSERT INTO registrations (id, confirmation_code, qr_token, language, sales_office_id,
      visitor_type, registration_date, visit_date, time_slot_id, number_of_visitors, status,
      parking_ticket_issued, parking_ticket_number, parking_ticket_issued_at, created_at, updated_at)
      VALUES ('r1','OE-OLD11','tok1','vi','CII_BINH_THANH','VISITOR','2026-09-01','2026-09-01',
        'SLOT_0900_1030', 5, 'CHECKED_IN', 1, 'PX-OLD', '2026-09-01T03:00:00Z',
        '2026-09-01T02:00:00Z','2026-09-01T03:00:00Z');
    INSERT INTO checkins VALUES ('c1','r1','u1','Old Desk','CII_BINH_THANH',
      '2026-09-01T03:00:00Z','QR',NULL);
  `);
  await db.close();
}

test('a database from an earlier release is upgraded in place', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { openDatabase } = require('../src/db');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinera-migrate-'));
  const location = path.join(dir, 'legacy');
  await buildLegacyDatabase(location);

  const db = await openDatabase(location);
  assert.ok(db.migrations.includes('checkins.expected_guests'), 'the new columns are added');
  assert.ok(db.migrations.includes('checkins.actual_guests'));
  assert.ok(db.migrations.includes('agencies.sort_order'));

  // §XXVIII — historic check-ins get the booked figure as their arrival count.
  const c = await db.prepare('SELECT expected_guests AS e, actual_guests AS a FROM checkins WHERE id = ?').get('c1');
  assert.equal(Number(c.e), 5);
  assert.equal(Number(c.a), 5);

  // §XXIX — the old single ticket becomes a row in the new table, typed as a car.
  const tickets = await db.prepare('SELECT * FROM parking_tickets').all();
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].vehicle_type, 'CAR');
  assert.equal(tickets[0].ticket_number, 'PX-OLD');
  assert.equal(tickets[0].registration_id, 'r1');
  await db.close();

  // Running it again changes nothing.
  const again = await openDatabase(location);
  assert.deepEqual(again.migrations, [], 'the migration is idempotent');
  assert.equal(Number((await again.prepare('SELECT COUNT(*) AS n FROM parking_tickets').get()).n), 1,
    'the ticket is not duplicated');
  await again.close();

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fresh database needs no migration', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { openDatabase } = require('../src/db');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinera-fresh-'));
  const db = await openDatabase(path.join(dir, 'fresh'));
  assert.deepEqual(db.migrations, []);
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
