'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startServer, makeClock, visitorPayload, agencyPayload, CREDS,
  OFFICE_CII, OFFICE_TG, SLOT_A, SLOT_B, SLOT_1030,
} = require('./helpers');
const { toDateString, minutesOfDay } = require('../src/domain/dates');
const { openDatabase } = require('../src/db');
const { seed } = require('../src/db/seed');

const A = (t) => ({ token: t });
const DAY = '2026-10-05';
/** Vietnam wall-clock time on DAY, as the UTC instant the server sees. */
const at = (hhmm, day = DAY) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(...day.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))), h - 7, m));
};

async function desk(hhmm = '09:30') {
  const clock = makeClock(at(hhmm));
  const server = await startServer({ clock });
  const reception = await server.login(...CREDS.ciiReception);
  const manager = await server.login(...CREDS.manager);
  let n = 0;
  const book = async (over = {}) => {
    n += 1;
    const res = await server.post('/api/registrations', visitorPayload({
      visitDate: DAY, timeSlotId: SLOT_A, numberOfVisitors: 2,
      cccd: String(790000000000 + n), phone: `09${String(10000000 + n)}`, ...over,
    }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };
  const checkin = (id, body = {}) => server.post(`/api/staff/registrations/${id}/checkin`,
    { method: 'SEARCH', ...body }, A(reception.token));
  const lookup = async (code) => (await server.post('/api/staff/checkin/lookup',
    { query: code }, A(reception.token))).body;
  return { server, clock, reception, manager, book, checkin, lookup };
}

// ===========================================================================
// The business clock
// ===========================================================================

test('"today" is the date in Vietnam, not on the server', () => {
  // 23:30 UTC on the 1st is already 06:30 on the 2nd in Vietnam.
  assert.equal(toDateString(new Date('2026-10-01T23:30:00Z')), '2026-10-02');
  assert.equal(toDateString(new Date('2026-10-01T16:59:00Z')), '2026-10-01');
  assert.equal(toDateString(new Date('2026-10-01T17:00:00Z')), '2026-10-02');
  assert.equal(minutesOfDay(new Date('2026-10-01T02:30:00Z')), 9 * 60 + 30);
});

test('a visitor booking at dawn is offered today, not yesterday', async (t) => {
  const server = await startServer({ clock: makeClock(at('06:00')) });
  t.after(() => server.close());
  const cfg = await server.get('/api/config');
  assert.equal(cfg.body.today, DAY);
  assert.equal(cfg.body.selectableDates[0], DAY);
});

// ===========================================================================
// 1 — the 30-guest limit cannot be talked around
// ===========================================================================

test('a slot holds thirty guests and not one more', async (t) => {
  const d = await desk();
  t.after(() => d.server.close());

  for (let i = 0; i < 3; i += 1) await d.book({ numberOfVisitors: 10 });
  const full = await d.server.post('/api/registrations',
    visitorPayload({ visitDate: DAY, timeSlotId: SLOT_A, numberOfVisitors: 1, cccd: '079111111111' }));
  assert.equal(full.status, 409);
  assert.equal(full.body.error.code, 'TIME_SLOT_FULLY_BOOKED');

  const av = await d.server.get(`/api/availability?salesOfficeId=${OFFICE_CII}&visitDate=${DAY}`);
  const slot = av.body.slots.find((x) => x.slotId === SLOT_A);
  assert.equal(slot.capacity, 30);
  assert.equal(slot.remaining, 0);
});

test('understating the party to get into a nearly-full slot does not work', async (t) => {
  const d = await desk();
  t.after(() => d.server.close());

  // 28 places are taken; an agency with nine people books the last two.
  await d.book({ numberOfVisitors: 20 });
  await d.book({ numberOfVisitors: 8 });
  const sneaky = await d.book({ numberOfVisitors: 2 });

  await t.test('the desk is shown the real ceiling before pressing anything', async () => {
    const found = await d.lookup(sneaky.confirmationCode);
    assert.equal(found.readiness.capacity.capacity, 30);
    assert.equal(found.readiness.capacity.occupiedByOthers, 28);
    assert.equal(found.readiness.capacity.maxGuests, 2);
  });

  await t.test('arriving with nine is refused, with the number that can be admitted', async () => {
    const res = await d.checkin(sneaky.registrationId, { actualGuests: 9 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'SLOT_CAPACITY_EXCEEDED');
    assert.equal(res.body.error.details.maxGuests, 2);
    assert.equal(res.body.error.details.occupiedByOthers, 28);
  });

  await t.test('no override flag gets past it', async () => {
    const res = await d.checkin(sneaky.registrationId,
      { actualGuests: 9, allowTimeOverride: true, allowDateOverride: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'SLOT_CAPACITY_EXCEEDED');
  });

  await t.test('the two who were booked are admitted', async () => {
    const res = await d.checkin(sneaky.registrationId, { actualGuests: 2 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });
});

test('extra guests are welcome while the slot has room, and they use real places', async (t) => {
  const d = await desk();
  t.after(() => d.server.close());

  const group = await d.book({ numberOfVisitors: 2 });
  const res = await d.checkin(group.registrationId, { actualGuests: 6 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.guests.variance, 4);

  // The slot now holds six, not the two that were typed into the form.
  const av = await d.server.get(`/api/availability?salesOfficeId=${OFFICE_CII}&visitDate=${DAY}`);
  const slot = av.body.slots.find((x) => x.slotId === SLOT_A);
  assert.equal(slot.booked, 6);
  assert.equal(slot.remaining, 24);

  await t.test('and a group that arrives short hands its places back', async () => {
    const big = await d.book({ numberOfVisitors: 10 });
    const short = await d.checkin(big.registrationId, { actualGuests: 4 });
    assert.equal(short.status, 200);
    const after = await d.server.get(`/api/availability?salesOfficeId=${OFFICE_CII}&visitDate=${DAY}`);
    assert.equal(after.body.slots.find((x) => x.slotId === SLOT_A).booked, 10, '6 + 4, not 6 + 10');
  });
});

test('an administrator can lower a slot below thirty but never raise it above', async (t) => {
  const d = await desk();
  t.after(() => d.server.close());
  const admin = await d.server.login(...CREDS.admin);

  const up = await d.server.request('PATCH', `/api/admin/time-slots/${SLOT_A}`,
    { body: { capacity: 31 }, token: admin.token });
  assert.equal(up.status, 400);
  assert.equal(up.body.error.code, 'INVALID_CAPACITY');

  const down = await d.server.request('PATCH', `/api/admin/time-slots/${SLOT_A}`,
    { body: { capacity: 20 }, token: admin.token });
  assert.equal(down.status, 200);
  assert.equal(down.body.capacity, 20);
});

// ===========================================================================
// 2 — a slot that has ended cannot be chosen
// ===========================================================================

test('slots that have ended are flagged for the form and refused by the API', async (t) => {
  const d = await desk('10:45'); // the first slot ended at 10:30
  t.after(() => d.server.close());

  const today = await d.server.get(`/api/availability?salesOfficeId=${OFFICE_CII}&visitDate=${DAY}`);
  const flags = Object.fromEntries(today.body.slots.map((x) => [x.slotId, x.passed]));
  assert.deepEqual(flags, {
    SLOT_0900_1030: true, SLOT_1030_1200: false, SLOT_1300_1430: false, SLOT_1430_1600: false,
  });
  assert.equal(today.body.slots.find((x) => x.slotId === SLOT_A).remaining, 0);

  await t.test('booking the finished slot is refused even if the form is bypassed', async () => {
    const res = await d.server.post('/api/registrations',
      visitorPayload({ visitDate: DAY, timeSlotId: SLOT_A }));
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'TIME_SLOT_PASSED');
  });

  await t.test('the slot in progress can still be booked until it ends', async () => {
    const res = await d.server.post('/api/registrations',
      visitorPayload({ visitDate: DAY, timeSlotId: SLOT_1030 }));
    assert.equal(res.status, 201);
  });

  await t.test('tomorrow\'s morning slot is untouched', async () => {
    const tomorrow = await d.server.get(`/api/availability?salesOfficeId=${OFFICE_CII}&visitDate=2026-10-06`);
    assert.ok(tomorrow.body.slots.every((x) => x.passed === false));
  });

  await t.test('after the last slot, the whole day has passed', async () => {
    d.clock.set(at('16:05'));
    const late = await d.server.get(`/api/availability?salesOfficeId=${OFFICE_CII}&visitDate=${DAY}`);
    assert.ok(late.body.slots.every((x) => x.passed === true));
  });
});

// ===========================================================================
// 4 — groups arriving early or late
// ===========================================================================

test('arrival is classified against the booked slot', async (t) => {
  const d = await desk('08:50');
  t.after(() => d.server.close());

  const onTime = await d.book();          // 09:00 slot
  const late = await d.book();
  const res1 = await d.checkin(onTime.registrationId);
  assert.equal(res1.status, 200, JSON.stringify(res1.body));
  assert.equal(res1.body.checkin.arrivalStatus, 'ON_TIME', 'ten minutes early is inside the grace');
  assert.equal(res1.body.checkin.minutesFromSlotStart, -10);
  assert.equal(res1.body.checkin.timeOverride, false);

  d.clock.set(at('09:40'));
  const res2 = await d.checkin(late.registrationId);
  assert.equal(res2.status, 200);
  assert.equal(res2.body.checkin.arrivalStatus, 'LATE', 'forty minutes in, still inside the slot');
  assert.equal(res2.body.checkin.minutesFromSlotStart, 40);
  assert.equal(res2.body.checkin.admittedSlotId, SLOT_A, 'a late group is still in its own slot');
  assert.equal(res2.body.checkin.timeOverride, false, 'no confirmation is needed inside the slot');
});

test('a group that arrives well before its slot needs the desk to confirm', async (t) => {
  const d = await desk('09:30');
  t.after(() => d.server.close());
  const early = await d.book({ timeSlotId: SLOT_B }); // booked 13:00, arrives 09:30

  await t.test('the desk is told how early, and where they would be counted', async () => {
    const found = await d.lookup(early.confirmationCode);
    assert.equal(found.readiness.canCheckIn, false);
    assert.deepEqual(found.readiness.reasons.map((x) => x.code), ['ARRIVED_EARLY']);
    assert.equal(found.readiness.timing.status, 'EARLY');
    assert.equal(found.readiness.timing.minutesFromSlotStart, -210);
    assert.equal(found.readiness.timing.admittedSlotId, SLOT_A, 'the slot running right now');
  });

  await t.test('a plain check-in is refused as overridable', async () => {
    const res = await d.checkin(early.registrationId);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ARRIVAL_OUTSIDE_SLOT');
    assert.equal(res.body.error.details.overridable, true);
  });

  await t.test('confirmed, they are admitted into the running slot and it is recorded', async () => {
    const res = await d.checkin(early.registrationId, { allowTimeOverride: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.checkin.arrivalStatus, 'EARLY');
    assert.equal(res.body.checkin.admittedSlotId, SLOT_A);
    assert.equal(res.body.checkin.timeOverride, true);

    // Their two places moved from the afternoon slot to the morning one.
    const av = await d.server.get(`/api/availability?salesOfficeId=${OFFICE_CII}&visitDate=${DAY}`);
    assert.equal(av.body.slots.find((x) => x.slotId === SLOT_A).booked, 2);
    assert.equal(av.body.slots.find((x) => x.slotId === SLOT_B).booked, 0);
  });
});

test('an early group cannot be squeezed into a running slot that is full', async (t) => {
  const d = await desk('09:30');
  t.after(() => d.server.close());
  for (let i = 0; i < 3; i += 1) await d.book({ numberOfVisitors: 10 }); // 09:00 slot full
  const early = await d.book({ timeSlotId: SLOT_B, numberOfVisitors: 4 });

  const found = await d.lookup(early.confirmationCode);
  assert.ok(found.readiness.reasons.some((x) => x.code === 'SLOT_FULL'));
  assert.equal(found.readiness.capacity.maxGuests, 0);

  const res = await d.checkin(early.registrationId, { allowTimeOverride: true });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'SLOT_CAPACITY_EXCEEDED');

  await t.test('but in their own slot they are admitted as booked', async () => {
    d.clock.set(at('13:05'));
    const ok = await d.checkin(early.registrationId);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.checkin.arrivalStatus, 'ON_TIME');
  });
});

test('a group that misses its slot can be admitted into the next one, if there is room', async (t) => {
  const d = await desk('09:30');
  t.after(() => d.server.close());
  const missed = await d.book({ numberOfVisitors: 3 }); // 09:00 – 10:30

  d.clock.set(at('11:00'));
  const plain = await d.checkin(missed.registrationId);
  assert.equal(plain.status, 409);
  assert.equal(plain.body.error.code, 'ARRIVAL_OUTSIDE_SLOT');

  const res = await d.checkin(missed.registrationId, { allowTimeOverride: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.checkin.arrivalStatus, 'AFTER_SLOT');
  assert.equal(res.body.checkin.admittedSlotId, SLOT_1030);
  assert.equal(res.body.checkin.timeOverride, true);

  const av = await d.server.get(`/api/availability?salesOfficeId=${OFFICE_CII}&visitDate=${DAY}`);
  assert.equal(av.body.slots.find((x) => x.slotId === SLOT_1030).booked, 3,
    'they are counted in the slot they walked into');
});

test('a group checked in on the wrong day is counted on the day it came', async (t) => {
  const d = await desk('09:30');
  t.after(() => d.server.close());
  const tomorrow = await d.book({ visitDate: '2026-10-06', numberOfVisitors: 5 });

  const res = await d.checkin(tomorrow.registrationId, { allowDateOverride: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.checkin.arrivalStatus, 'OTHER_DAY');
  assert.equal(res.body.checkin.admittedDate, DAY);
  assert.equal(res.body.checkin.timeOverride, true);

  const today = await d.server.get(`/api/availability?salesOfficeId=${OFFICE_CII}&visitDate=${DAY}`);
  assert.equal(today.body.slots.find((x) => x.slotId === SLOT_A).booked, 5);
  const next = await d.server.get(`/api/availability?salesOfficeId=${OFFICE_CII}&visitDate=2026-10-06`);
  assert.equal(next.body.slots.find((x) => x.slotId === SLOT_A).booked, 0, 'their places tomorrow are free again');
});

// ===========================================================================
// 3 — the report carries what the desk actually counted
// ===========================================================================

test('reports show actual attendance from the check-in records', async (t) => {
  const d = await desk('09:10');
  t.after(() => d.server.close());

  const a = await d.book({ numberOfVisitors: 4 });
  const b = await d.server.post('/api/registrations', agencyPayload({
    salesOfficeId: OFFICE_CII, visitDate: DAY, timeSlotId: SLOT_A, numberOfVisitors: 3,
  }));
  await d.book({ numberOfVisitors: 6 }); // never arrives

  assert.equal((await d.checkin(a.registrationId, { actualGuests: 2 })).status, 200);
  d.clock.set(at('09:50'));
  assert.equal((await d.checkin(b.body.registrationId, { actualGuests: 5 })).status, 200);

  const stats = (await d.server.get('/api/staff/customer-stats', A(d.manager.token))).body;

  await t.test('the totals are the counted figures, not the booked ones', () => {
    assert.equal(stats.overview.people, 13, 'booked by everyone');
    assert.equal(stats.attendance.checkins, 2);
    assert.equal(stats.attendance.bookedPeople, 7, 'booked by those who came');
    assert.equal(stats.attendance.actualPeople, 7, '2 + 5 counted at the desk');
    assert.equal(stats.attendance.arrivedWithFewer, 1);
    assert.equal(stats.attendance.arrivedWithMore, 1);
    assert.equal(stats.overview.arrivedPeople, 7);
  });

  await t.test('punctuality is reported', () => {
    assert.deepEqual(stats.attendance.punctuality,
      { onTime: 1, late: 1, early: 0, afterSlot: 0, otherDay: 0 });
    assert.equal(stats.attendance.onTimeRate, 0.5);
    assert.equal(stats.attendance.averageLateMinutes, 50);
  });

  await t.test('each breakdown carries the counted figure beside the booked one', () => {
    const agency = stats.byAgency[0];
    assert.equal(agency.people, 3);
    assert.equal(agency.arrivedPeople, 5);
    const slot = stats.byTimeSlot.find((x) => x.slotId === SLOT_A);
    assert.equal(slot.people, 13);
    assert.equal(slot.arrivedPeople, 7);
    assert.equal(stats.dailyTrend[0].arrivedPeople, 7);
  });

  await t.test('there is one record per check-in behind the totals', () => {
    assert.equal(stats.checkinRecords.length, 2);
    const late = stats.checkinRecords.find((x) => x.arrivalStatus === 'LATE');
    assert.equal(late.expectedGuests, 3);
    assert.equal(late.actualGuests, 5);
    assert.equal(late.variance, 2);
    assert.equal(late.minutesFromSlotStart, 50);
    assert.ok(late.receptionistName);
  });

  await t.test('the dashboard agrees', async () => {
    const dash = (await d.server.get('/api/staff/dashboard', A(d.manager.token))).body;
    assert.equal(dash.guestAccuracy.actualGuests, 7);
    assert.deepEqual(dash.guestAccuracy.punctuality,
      { onTime: 1, late: 1, early: 0, afterSlot: 0, otherDay: 0 });
  });

  await t.test('both exports include the check-in data', async () => {
    const zlib = require('node:zlib');
    const sheetText = (buffer) => {
      // Inflate every part and search the lot: this asserts presence, not layout.
      let out = '';
      let i = 0;
      while ((i = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), i)) !== -1) {
        const method = buffer.readUInt16LE(i + 8);
        const size = buffer.readUInt32LE(i + 18);
        const start = i + 30 + buffer.readUInt16LE(i + 26) + buffer.readUInt16LE(i + 28);
        const raw = buffer.subarray(start, start + size);
        out += (method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8');
        i = start + size;
      }
      return out;
    };
    const statsFile = await d.server.request('GET', '/api/staff/customer-stats/export.xlsx',
      { token: d.manager.token, raw: true });
    const statsXml = sheetText(Buffer.from(await statsFile.arrayBuffer()));
    assert.match(statsXml, /Check-in thực tế/);
    assert.match(statsXml, /Số người thực đến \(lễ tân đếm\)/);
    assert.match(statsXml, /Đến trễ/);

    const listFile = await d.server.request('GET', '/api/staff/registrations/export.xlsx',
      { token: d.manager.token, raw: true });
    const listXml = sheetText(Buffer.from(await listFile.arrayBuffer()));
    assert.match(listXml, /Đúng giờ\?/);
    assert.match(listXml, /Lệch giờ \(phút\)/);
  });
});

// ===========================================================================
// 5 — account activity, and the forced first-login password change
// ===========================================================================

test('an account an administrator creates must change its password before anything else', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const admin = await server.login(...CREDS.admin);

  const made = await server.post('/api/admin/users', {
    username: 'cii.new01', fullName: 'Lễ tân mới', role: 'RECEPTIONIST',
    salesOfficeId: OFFICE_CII, password: 'Assigned@1',
  }, A(admin.token));
  assert.equal(made.status, 201);
  assert.equal(made.body.mustChangePassword, true);

  const first = await server.login('cii.new01', 'Assigned@1');
  assert.equal(first.mustChangePassword, true, 'the sign-in says a change is owed');

  await t.test('every route is closed until the password is changed', async () => {
    for (const path of ['/api/staff/registrations', '/api/staff/calendar', '/api/staff/office-summary']) {
      const res = await server.get(path, A(first.token));
      assert.equal(res.status, 403, path);
      assert.equal(res.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
    }
    const lookup = await server.post('/api/staff/checkin/lookup', { query: 'x' }, A(first.token));
    assert.equal(lookup.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
  });

  await t.test('the account can still see who it is, and change the password', async () => {
    const me = await server.get('/api/auth/me', A(first.token));
    assert.equal(me.status, 200);
    assert.equal(me.body.user.mustChangePassword, true);

    const same = await server.post('/api/auth/password',
      { currentPassword: 'Assigned@1', newPassword: 'Assigned@1' }, A(first.token));
    assert.equal(same.body.error.code, 'PASSWORD_UNCHANGED', 'keeping the assigned one is not a change');

    const ok = await server.post('/api/auth/password',
      { currentPassword: 'Assigned@1', newPassword: 'MyOwn@Pass2' }, A(first.token));
    assert.equal(ok.status, 200);
  });

  await t.test('after which the same session works normally', async () => {
    assert.equal((await server.get('/api/staff/registrations', A(first.token))).status, 200);
    const again = await server.login('cii.new01', 'MyOwn@Pass2');
    assert.equal(again.mustChangePassword, false);
  });

  await t.test('an administrator reset puts the requirement back', async () => {
    const list = await server.get('/api/admin/users', A(admin.token));
    const id = list.body.items.find((u) => u.username === 'cii.new01').id;
    await server.post(`/api/admin/users/${id}/password`, { password: 'Reset@Pass3' }, A(admin.token));
    const after = await server.login('cii.new01', 'Reset@Pass3');
    assert.equal(after.mustChangePassword, true);
    assert.equal((await server.get('/api/staff/registrations', A(after.token))).status, 403);
  });
});

test('seeded accounts owe a password change too, unless the suite switches it off', async () => {
  const saved = process.env.KINERA_SEED_REQUIRE_PASSWORD_CHANGE;
  delete process.env.KINERA_SEED_REQUIRE_PASSWORD_CHANGE;
  try {
    const db = await openDatabase(':memory:');
    await seed(db);
    const rows = await db.prepare('SELECT username, must_change_password AS m FROM users').all();
    assert.equal(rows.length, 10);
    assert.ok(rows.every((r) => r.m === 1), 'every seeded account must change its password');
    await db.close();
  } finally {
    process.env.KINERA_SEED_REQUIRE_PASSWORD_CHANGE = saved;
  }
});

test('the administrator sees each account\'s activity', async (t) => {
  const clock = makeClock(at('09:00'));
  const server = await startServer({ clock });
  t.after(() => server.close());
  const admin = await server.login(...CREDS.admin);
  const byName = async () => Object.fromEntries(
    (await server.get('/api/admin/users', A(admin.token))).body.items.map((u) => [u.username, u]));

  await t.test('an account that has never signed in says so', async () => {
    const u = (await byName())['tg.reception02'];
    assert.equal(u.activity, 'NEVER');
    assert.equal(u.lastLoginAt, null);
    assert.equal(u.loginCount, 0);
  });

  await t.test('signing in is recorded, and the account shows as online', async () => {
    await server.login(...CREDS.ciiReception);
    await server.login(...CREDS.ciiReception);
    const u = (await byName())['cii.reception01'];
    assert.equal(u.activity, 'ONLINE');
    assert.equal(u.loginCount, 2);
    assert.equal(u.lastLoginAt, at('09:00').toISOString());
  });

  await t.test('using the system keeps "last seen" current', async () => {
    const rec = await server.login(...CREDS.ciiReception);
    clock.set(at('11:20'));
    await server.get('/api/staff/calendar', A(rec.token));
    clock.set(at('11:22'));
    const u = (await byName())['cii.reception01'];
    assert.equal(u.lastSeenAt, at('11:20').toISOString());
    assert.equal(u.activity, 'ONLINE');
  });

  await t.test('idle accounts age from online to today, recent and dormant', async () => {
    clock.set(at('15:00'));
    const again = await server.login(...CREDS.admin);
    const list = async () => Object.fromEntries((await server.get('/api/admin/users', A(again.token)))
      .body.items.map((u) => [u.username, u.activity]));
    assert.equal((await list())['cii.reception01'], 'TODAY');

    clock.set(at('10:00', '2026-10-08'));
    const later = await server.login(...CREDS.admin);
    const recent = Object.fromEntries((await server.get('/api/admin/users', A(later.token)))
      .body.items.map((u) => [u.username, u.activity]));
    assert.equal(recent['cii.reception01'], 'RECENT');

    clock.set(at('10:00', '2026-10-20'));
    const muchLater = await server.login(...CREDS.admin);
    const dormant = Object.fromEntries((await server.get('/api/admin/users', A(muchLater.token)))
      .body.items.map((u) => [u.username, u.activity]));
    assert.equal(dormant['cii.reception01'], 'DORMANT');
    assert.equal(dormant.admin, 'ONLINE');
  });

  await t.test('the list never exposes a password hash', async () => {
    const fresh = await server.login(...CREDS.admin);
    const list = await server.get('/api/admin/users', A(fresh.token));
    assert.equal(list.status, 200);
    assert.equal(/password_hash|passwordHash|salt/i.test(JSON.stringify(list.body)), false);
  });
});

test('other-office desks are unaffected by this office\'s occupancy', async (t) => {
  const d = await desk('09:30');
  t.after(() => d.server.close());
  for (let i = 0; i < 3; i += 1) await d.book({ numberOfVisitors: 10 });
  const tg = await d.server.post('/api/registrations', visitorPayload({
    salesOfficeId: OFFICE_TG, visitDate: DAY, timeSlotId: SLOT_A, numberOfVisitors: 10, cccd: '079222222222',
  }));
  assert.equal(tg.status, 201, 'capacity is per office, per day, per slot');
});
