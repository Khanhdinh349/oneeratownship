'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildApp, makeClock, visitorPayload, agencyPayload,
  TODAY, PLUS_10, PLUS_11, OFFICE_CII, OFFICE_TG, SLOT_A, SLOT_B, SLOT_1030,
} = require('./helpers');

async function setup() {
  const clock = makeClock();
  const { services } = await buildApp({ clock });
  return { ...services, clock };
}

// ===========================================================================
// §XVIII / §XLI Process 7-10 — creation
// ===========================================================================

test('§XVIII a valid visitor registration is created with code, token and REGISTERED status', async () => {
  const { registrations } = await setup();
  const reg = await registrations.createRegistration(visitorPayload());

  assert.match(reg.confirmationCode, /^OE-[0-9A-Z]{5}$/, '§XVIII.2 OE-XXXXX');
  assert.match(reg.qrToken, /^[0-9a-f]{32}\.[0-9a-f]{16}$/, '§XVIII.3 opaque token');
  assert.equal(reg.status, 'REGISTERED', '§XXIII initial status');
  assert.equal(reg.visitorType, 'VISITOR');
  assert.equal(reg.visitor.fullName, 'Nguyễn Văn A');
  assert.equal(reg.registrationDate, TODAY, '§XX registration date recorded');
  assert.ok(reg.createdAt && reg.updatedAt, '§XX created/updated timestamps');
  assert.equal(reg.salesOffice.name, 'CII - Bình Thạnh');
  assert.equal(reg.timeSlot.label, '09:00 – 10:30');
  assert.equal(reg.parking.total, 0, 'no parking tickets yet');
});

test('§XVIII creation writes the first status-history row with an actor and timestamp', async () => {
  const { registrations } = await setup();
  const reg = await registrations.createRegistration(visitorPayload());
  assert.equal(reg.statusHistory.length, 1);
  const [h] = reg.statusHistory;
  assert.equal(h.fromStatus, null);
  assert.equal(h.toStatus, 'REGISTERED');
  assert.equal(h.changedBy, 'VISITOR');
  assert.ok(h.changedAt, '§XXIII timestamp recorded');
});

test('§XXII an agency registration stores agency, staff and masked customer data only', async () => {
  const { registrations } = await setup();
  const reg = await registrations.createRegistration(agencyPayload());
  assert.equal(reg.visitorType, 'AGENCY');
  assert.equal(reg.agency.agencyName, 'IQI');
  assert.equal(reg.agency.salesStaffName, 'Nguyễn Văn B');
  assert.equal(reg.agency.customerShortName, 'N.V.C');
  assert.equal(reg.agency.customerPhoneLast4, '4321');
  assert.equal(reg.visitor, undefined, '§XIII no full visitor record for an agency booking');
});

test('§XIII.2 only 4 digits of the customer phone are ever persisted', async () => {
  const { registrations, db } = await setup();
  const reg = await registrations.createRegistration(agencyPayload({ customerPhoneLast4: '4321' }));
  const row = await db.prepare('SELECT * FROM registrations WHERE id = ?').get(reg.id);
  assert.equal(row.customer_phone_last4, '4321');
  assert.equal(row.phone, null, 'no full customer phone column is populated');
  const dump = JSON.stringify(row);
  assert.equal(dump.includes('09012344321'), false);
});

test('§XVIII.2 confirmation codes are unique across many registrations', async () => {
  const { registrations } = await setup();
  const codes = new Set();
  const tokens = new Set();
  const days = ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'];
  for (let i = 0; i < 120; i += 1) {
    // Spread across dates and slots so slot capacity is never the limiting factor.
    const reg = await registrations.createRegistration(visitorPayload({
      cccd: String(100000000000 + i),
      numberOfVisitors: 1,
      visitDate: days[i % days.length],
      timeSlotId: [SLOT_A, SLOT_B, SLOT_1030][Math.floor(i / days.length) % 3],
    }));
    assert.equal(codes.has(reg.confirmationCode), false, 'no duplicate confirmation code');
    assert.equal(tokens.has(reg.qrToken), false, 'no duplicate QR token');
    codes.add(reg.confirmationCode);
    tokens.add(reg.qrToken);
  }
  assert.equal(codes.size, 120);
});

// ===========================================================================
// §VII / §XIV — backend enforcement of the 10-day rule (§Rule 4)
// ===========================================================================

test('§VII the backend rejects a visit date beyond today+10 even if the UI allowed it', async () => {
  const { registrations } = await setup();
  await assert.rejects(
    async () => registrations.createRegistration(visitorPayload({ visitDate: PLUS_11 })),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'VALIDATION_FAILED');
      assert.equal(err.details[0].code, 'VISIT_DATE_OUT_OF_RANGE');
      return true;
    },
  );
});

test('§VII the backend accepts exactly today and exactly today+10', async () => {
  const { registrations } = await setup();
  const a = await registrations.createRegistration(visitorPayload({ visitDate: TODAY, cccd: '111111111111' }));
  assert.equal(a.visitDate, TODAY);
  const b = await registrations.createRegistration(visitorPayload({ visitDate: PLUS_10, cccd: '222222222222' }));
  assert.equal(b.visitDate, PLUS_10);
});

test('§VII the backend rejects a past visit date', async () => {
  const { registrations } = await setup();
  await assert.rejects(
    async () => registrations.createRegistration(visitorPayload({ visitDate: '2026-09-30' })),
    (err) => err.details[0].code === 'VISIT_DATE_OUT_OF_RANGE',
  );
});

test('§VII the window follows the clock — yesterday\'s valid date becomes invalid tomorrow', async () => {
  const clock = makeClock();
  const { services } = await buildApp({ clock });
  const { registrations } = services;
  // 2026-10-11 is the last selectable day while today is 2026-10-01.
  await registrations.createRegistration(visitorPayload({ visitDate: '2026-10-11', cccd: '333333333333' }));
  clock.setDate('2026-10-02');
  // A day later, 2026-10-13 is now out of range but 2026-10-12 is in range.
  await registrations.createRegistration(visitorPayload({ visitDate: '2026-10-12', cccd: '444444444444' }));
  await assert.rejects(
    async () => registrations.createRegistration(visitorPayload({ visitDate: '2026-10-13', cccd: '555555555555' })),
    (err) => err.details[0].code === 'VISIT_DATE_OUT_OF_RANGE',
  );
});

// ===========================================================================
// §VIII / §XLI Process 6 — slot availability
// ===========================================================================

test('§VIII availability lists every active slot with capacity, booked and remaining', async () => {
  const { registrations } = await setup();
  const slots = await registrations.getAvailability(OFFICE_CII, '2026-10-05');
  assert.equal(slots.length, 4, '§VIII the four booking windows');
  slots.forEach((s) => {
    assert.ok(typeof s.capacity === 'number' && typeof s.booked === 'number');
    assert.equal(s.remaining, s.capacity - s.booked);
    assert.equal(s.fullyBooked, false);
  });
});

test('§VIII booking a slot reduces remaining capacity for that office and date only', async () => {
  const { registrations } = await setup();
  await registrations.createRegistration(visitorPayload({ numberOfVisitors: 4 }));

  const same = (await registrations.getAvailability(OFFICE_CII, '2026-10-05')).find((s) => s.slotId === SLOT_A);
  assert.equal(same.booked, 4);
  assert.equal(same.remaining, 26);

  const otherSlot = (await registrations.getAvailability(OFFICE_CII, '2026-10-05')).find((s) => s.slotId === SLOT_B);
  assert.equal(otherSlot.booked, 0, 'each slot has its own independent capacity');

  const otherOffice = (await registrations.getAvailability(OFFICE_TG, '2026-10-05')).find((s) => s.slotId === SLOT_A);
  assert.equal(otherOffice.booked, 0, 'availability is per office');

  const otherDate = (await registrations.getAvailability(OFFICE_CII, '2026-10-06')).find((s) => s.slotId === SLOT_A);
  assert.equal(otherDate.booked, 0, 'availability is per date');
});

test('§VIII a full slot reports fullyBooked and refuses further registration', async () => {
  const { registrations, masterData } = await setup();
  await masterData.updateSlot(SLOT_A, { capacity: 5 });

  await registrations.createRegistration(visitorPayload({ numberOfVisitors: 5, cccd: '111111111111' }));
  const slot = (await registrations.getAvailability(OFFICE_CII, '2026-10-05')).find((s) => s.slotId === SLOT_A);
  assert.equal(slot.fullyBooked, true);
  assert.equal(slot.remaining, 0);

  await assert.rejects(
    async () => registrations.createRegistration(visitorPayload({ numberOfVisitors: 1, cccd: '222222222222' })),
    (err) => err.status === 409 && err.code === 'TIME_SLOT_FULLY_BOOKED',
  );
});

test('§VIII a party larger than the remaining capacity is refused with the remainder reported', async () => {
  const { registrations, masterData } = await setup();
  await masterData.updateSlot(SLOT_A, { capacity: 6 });
  await registrations.createRegistration(visitorPayload({ numberOfVisitors: 4, cccd: '111111111111' }));
  await assert.rejects(
    async () => registrations.createRegistration(visitorPayload({ numberOfVisitors: 3, cccd: '222222222222' })),
    (err) => {
      assert.equal(err.code, 'TIME_SLOT_INSUFFICIENT_CAPACITY');
      assert.equal(err.details.remaining, 2);
      assert.equal(err.details.requested, 3);
      return true;
    },
  );
  // Exactly the remainder still fits.
  const ok = await registrations.createRegistration(visitorPayload({ numberOfVisitors: 2, cccd: '333333333333' }));
  assert.equal(ok.numberOfVisitors, 2);
});

test('§VIII cancelled and no-show registrations release their seats', async () => {
  const { registrations, masterData } = await setup();
  await masterData.updateSlot(SLOT_A, { capacity: 5 });
  const a = await registrations.createRegistration(visitorPayload({ numberOfVisitors: 5, cccd: '111111111111' }));
  await registrations.changeStatus(a.id, 'CANCELLED');

  const slot = (await registrations.getAvailability(OFFICE_CII, '2026-10-05')).find((s) => s.slotId === SLOT_A);
  assert.equal(slot.booked, 0, 'cancelled seats are released');
  const b = await registrations.createRegistration(visitorPayload({ numberOfVisitors: 5, cccd: '222222222222' }));
  await registrations.changeStatus(b.id, 'NO_SHOW');
  assert.equal(
    (await registrations.getAvailability(OFFICE_CII, '2026-10-05')).find((s) => s.slotId === SLOT_A).booked, 0,
    'no-show seats are released',
  );
});

test('§VIII every slot reports the 30-guest cap and its live remaining count', async () => {
  const { registrations } = await setup();
  const before = await registrations.getAvailability(OFFICE_CII, '2026-10-05');
  before.forEach((s) => {
    assert.equal(s.capacity, 30, `${s.slotId} holds 30 guests`);
    assert.equal(s.remaining, 30, 'nothing booked yet');
    assert.equal(s.booked, 0);
  });

  await registrations.createRegistration(visitorPayload({ numberOfVisitors: 7 }));
  const after = await registrations.getAvailability(OFFICE_CII, '2026-10-05');
  const booked = after.find((s) => s.slotId === SLOT_A);
  assert.equal(booked.booked, 7, 'remaining is derived from real registrations');
  assert.equal(booked.remaining, 23);
  after.filter((s) => s.slotId !== SLOT_A)
    .forEach((s) => assert.equal(s.remaining, 30, 'other slots are unaffected'));

  // No slot carries a business-confirmation flag any more.
  after.forEach((s) => {
    assert.equal('needsBusinessConfirmation' in s, false);
    assert.equal('confirmationNote' in s, false);
  });
});

test('§VIII an inactive slot disappears from availability and is refused', async () => {
  const { registrations, masterData } = await setup();
  await masterData.updateSlot(SLOT_B, { active: false });
  const ids = (await registrations.getAvailability(OFFICE_CII, '2026-10-05')).map((s) => s.slotId);
  assert.equal(ids.includes(SLOT_B), false);
  await assert.rejects(
    async () => registrations.createRegistration(visitorPayload({ timeSlotId: SLOT_B })),
    (err) => err.details[0].code === 'INVALID_TIME_SLOT',
  );
});

test('availability rejects an unknown office or malformed date', async () => {
  const { registrations } = await setup();
  await assert.rejects(async () => registrations.getAvailability('NOWHERE', '2026-10-05'),
    (e) => e.code === 'SALES_OFFICE_NOT_FOUND');
  await assert.rejects(async () => registrations.getAvailability(OFFICE_CII, '05/10/2026'),
    (e) => e.code === 'INVALID_VISIT_DATE');
});

// ===========================================================================
// §Rule 11 — no duplicate visitor / customer records
// ===========================================================================

test('§Rule 11 the same CCCD cannot double-book the same office, date and slot', async () => {
  const { registrations } = await setup();
  const first = await registrations.createRegistration(visitorPayload());
  await assert.rejects(
    async () => registrations.createRegistration(visitorPayload()),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'DUPLICATE_REGISTRATION');
      assert.equal(err.details.confirmationCode, first.confirmationCode);
      return true;
    },
  );
});

test('§Rule 11 the same CCCD may book a different slot, date or office', async () => {
  const { registrations } = await setup();
  await registrations.createRegistration(visitorPayload());
  assert.ok(await registrations.createRegistration(visitorPayload({ timeSlotId: SLOT_B })), 'different slot');
  assert.ok(await registrations.createRegistration(visitorPayload({ visitDate: '2026-10-07' })), 'different date');
  assert.ok(await registrations.createRegistration(visitorPayload({ salesOfficeId: OFFICE_TG })), 'different office');
});

test('§Rule 11 a cancelled registration frees the person to re-book the same slot', async () => {
  const { registrations } = await setup();
  const first = await registrations.createRegistration(visitorPayload());
  await registrations.changeStatus(first.id, 'CANCELLED');
  const again = await registrations.createRegistration(visitorPayload());
  assert.notEqual(again.id, first.id);
  assert.equal(again.status, 'REGISTERED');
});

test('§Rule 11 duplicate detection for agencies keys on staff CCCD plus the customer', async () => {
  const { registrations } = await setup();
  await registrations.createRegistration(agencyPayload());
  await assert.rejects(
    async () => registrations.createRegistration(agencyPayload()),
    (err) => err.code === 'DUPLICATE_REGISTRATION',
  );
  // A different customer from the same staff member is a separate booking.
  assert.ok(await registrations.createRegistration(agencyPayload({ customerShortName: 'T.T.D' })));
  // The same customer via a different staff member is also separate.
  assert.ok(await registrations.createRegistration(agencyPayload({ salesStaffCccd: '111111111111' })));
});

// ===========================================================================
// §XXVI — lookup by QR token and confirmation code
// ===========================================================================

test('§XXVI.1 a registration is retrievable by its QR token', async () => {
  const { registrations } = await setup();
  const created = await registrations.createRegistration(visitorPayload());
  const found = await registrations.getByQrToken(created.qrToken);
  assert.equal(found.id, created.id);
  assert.equal(found.qrToken, undefined, 'the token is not echoed back in staff read models');
});

test('§XXVI.1 an invalid QR token is rejected before any database lookup', async () => {
  const { registrations } = await setup();
  for (const bad of ['garbage', '', 'abc.def', `${'a'.repeat(32)}.${'b'.repeat(16)}`]) {
    await assert.rejects(async () => registrations.getByQrToken(bad),
      (e) => e.status === 400 && e.code === 'INVALID_QR_TOKEN', `token ${bad}`);
  }
});

test('§XXVI.1 a well-formed but unknown QR token yields 404, not 400', async () => {
  const { registrations } = await setup();
  const { generateQrToken } = require('../src/domain/codes');
  const orphan = generateQrToken('test-qr-secret');
  await assert.rejects(async () => registrations.getByQrToken(orphan),
    (e) => e.status === 404 && e.code === 'REGISTRATION_NOT_FOUND');
});

test('§XXVI.2 lookup by confirmation code is case- and whitespace-insensitive', async () => {
  const { registrations } = await setup();
  const created = await registrations.createRegistration(visitorPayload());
  const lower = created.confirmationCode.toLowerCase();
  assert.equal((await registrations.getByConfirmationCode(lower)).id, created.id);
  assert.equal((await registrations.getByConfirmationCode(`  ${created.confirmationCode}  `)).id, created.id);
  assert.equal(await registrations.getByConfirmationCode('OE-ZZZZZ'), null, 'unknown code returns null');
  assert.equal(await registrations.getByConfirmationCode('not-a-code'), null, 'malformed code returns null');
});

// ===========================================================================
// §XXIII — status changes
// ===========================================================================

test('§XXIII each status change appends a history row with actor and timestamp', async () => {
  const { registrations } = await setup();
  const reg = await registrations.createRegistration(visitorPayload());
  const actor = { id: 'u1', name: 'Nguyễn Lễ Tân' };
  await registrations.changeStatus(reg.id, 'CONFIRMED', { actor, note: 'phone confirmed' });
  const after = await registrations.changeStatus(reg.id, 'EXPECTED', { actor });

  assert.equal(after.status, 'EXPECTED');
  assert.equal(after.statusHistory.length, 3);
  const last = after.statusHistory.at(-1);
  assert.equal(last.fromStatus, 'CONFIRMED');
  assert.equal(last.toStatus, 'EXPECTED');
  assert.equal(last.changedByName, 'Nguyễn Lễ Tân');
  assert.ok(last.changedAt);
  assert.equal(after.statusHistory[1].note, 'phone confirmed');
});

test('§XXIII an illegal transition is refused and leaves the record untouched', async () => {
  const { registrations } = await setup();
  const reg = await registrations.createRegistration(visitorPayload());
  await registrations.changeStatus(reg.id, 'CANCELLED');
  await assert.rejects(async () => registrations.changeStatus(reg.id, 'CHECKED_IN'),
    (e) => e.code === 'INVALID_STATUS_TRANSITION');
  const after = await registrations.getById(reg.id);
  assert.equal(after.status, 'CANCELLED');
  assert.equal(after.statusHistory.length, 2, 'no history row written for the refused change');
});

test('§XXIII changing the status of an unknown registration is a 404', async () => {
  const { registrations } = await setup();
  await assert.rejects(async () => registrations.changeStatus('no-such-id', 'CONFIRMED'),
    (e) => e.status === 404 && e.code === 'REGISTRATION_NOT_FOUND');
});

// ===========================================================================
// §XXXVIII — list: search, filter, sort, pagination, office scope
// ===========================================================================

async function seedList(services) {
  const { registrations } = services;
  const a = await registrations.createRegistration(visitorPayload({
    fullName: 'Trần Thị Bích', cccd: '111111111111', phone: '0911111111',
    visitDate: '2026-10-02', timeSlotId: SLOT_A, numberOfVisitors: 2,
  }));
  const b = await registrations.createRegistration(visitorPayload({
    salesOfficeId: OFFICE_TG, fullName: 'Lê Văn Cường', cccd: '222222222222',
    phone: '0922222222', visitDate: '2026-10-03', timeSlotId: SLOT_1030, numberOfVisitors: 1,
  }));
  const c = await registrations.createRegistration(agencyPayload({
    salesOfficeId: OFFICE_CII, visitDate: '2026-10-04', timeSlotId: SLOT_1030,
    salesStaffName: 'Phạm Văn Dũng', salesStaffCccd: '333333333333',
    salesStaffPhone: '0933333333', customerShortName: 'H.T.E', customerPhoneLast4: '7788',
    numberOfVisitors: 6,
  }));
  return { a, b, c };
}

test('§XXXVIII the list returns every registration with office and slot resolved', async () => {
  const services = await setup();
  await seedList(services);
  const page = await services.registrations.list();
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 3);
  page.items.forEach((r) => {
    assert.ok(r.salesOffice.name);
    assert.ok(r.timeSlot.label);
    assert.equal(r.qrToken, undefined, 'the QR token never appears in a listing');
  });
});

test('§XXV a receptionist scope hides the other office entirely', async () => {
  const services = await setup();
  await seedList(services);
  const cii = await services.registrations.list({ scopeOfficeId: OFFICE_CII });
  assert.equal(cii.total, 2);
  assert.ok(cii.items.every((r) => r.salesOfficeId === OFFICE_CII));

  const tg = await services.registrations.list({ scopeOfficeId: OFFICE_TG });
  assert.equal(tg.total, 1);
  assert.equal(tg.items[0].visitor.fullName, 'Lê Văn Cường');
});

test('§XXV an office scope cannot be widened by also passing a salesOfficeId filter', async () => {
  const services = await setup();
  await seedList(services);
  const page = await services.registrations.list({ scopeOfficeId: OFFICE_CII, salesOfficeId: OFFICE_TG });
  assert.equal(page.total, 0, 'contradictory scope + filter yields nothing, never the other office');
});

test('§XXXVIII filters by visitor type, status and date range', async () => {
  const services = await setup();
  const { a } = await seedList(services);
  assert.equal((await services.registrations.list({ visitorType: 'AGENCY' })).total, 1);
  assert.equal((await services.registrations.list({ visitorType: 'VISITOR' })).total, 2);

  await services.registrations.changeStatus(a.id, 'CANCELLED');
  assert.equal((await services.registrations.list({ status: 'CANCELLED' })).total, 1);
  assert.equal((await services.registrations.list({ status: ['REGISTERED', 'CANCELLED'] })).total, 3);

  assert.equal((await services.registrations.list({ dateFrom: '2026-10-03' })).total, 2);
  assert.equal((await services.registrations.list({ dateTo: '2026-10-02' })).total, 1);
  assert.equal((await services.registrations.list({ dateFrom: '2026-10-03', dateTo: '2026-10-03' })).total, 1);
});

test('§XXVI.2 search matches code, name, phone, CCCD, agency, staff and last-4', async () => {
  const services = await setup();
  const { a, c } = await seedList(services);
  const find = (q) => services.registrations.list({ search: q });

  assert.equal((await find(a.confirmationCode)).total, 1, 'confirmation code');
  assert.equal((await find(a.confirmationCode.toLowerCase())).total, 1, 'code lower-case');
  assert.equal((await find('bích')).total, 1, 'visitor name, diacritics');
  assert.equal((await find('TRẦN')).total, 1, 'visitor name, different case');
  assert.equal((await find('0911111111')).total, 1, 'visitor phone');
  assert.equal((await find('111111111111')).total, 1, 'visitor CCCD');
  assert.equal((await find('IQI')).total, 1, 'agency name');
  assert.equal((await find('Phạm Văn Dũng')).total, 1, 'sales staff name');
  assert.equal((await find('0933333333')).total, 1, 'sales staff phone');
  assert.equal((await find('H.T.E')).total, 1, 'customer short name');
  assert.equal((await find('7788')).total, 1, 'customer phone last 4');
  assert.equal((await find('nothing-matches-this')).total, 0);
  assert.equal((await find(c.confirmationCode)).items[0].visitorType, 'AGENCY');
});

test('§XXXVIII sorting works on visit date and number of visitors, both directions', async () => {
  const services = await setup();
  await seedList(services);
  const asc = await services.registrations.list({ sortBy: 'visit_date', sortDir: 'asc' });
  assert.deepEqual(asc.items.map((r) => r.visitDate), ['2026-10-02', '2026-10-03', '2026-10-04']);
  const desc = await services.registrations.list({ sortBy: 'visit_date', sortDir: 'desc' });
  assert.deepEqual(desc.items.map((r) => r.visitDate), ['2026-10-04', '2026-10-03', '2026-10-02']);
  const byPeople = await services.registrations.list({ sortBy: 'number_of_visitors', sortDir: 'desc' });
  assert.deepEqual(byPeople.items.map((r) => r.numberOfVisitors), [6, 2, 1]);
});

test('§XXXVIII an unknown sort column falls back to visit_date instead of failing', async () => {
  const services = await setup();
  await seedList(services);
  const page = await services.registrations.list({ sortBy: 'drop table; --' });
  assert.equal(page.total, 3);
  assert.deepEqual(page.items.map((r) => r.visitDate), ['2026-10-02', '2026-10-03', '2026-10-04']);
});

test('§XXXVIII pagination reports totals and clamps page size', async () => {
  const services = await setup();
  for (let i = 0; i < 25; i += 1) {
    await services.registrations.createRegistration(visitorPayload({
      cccd: String(400000000000 + i), numberOfVisitors: 1,
    }));
  }
  const p1 = await services.registrations.list({ page: 1, pageSize: 10 });
  assert.equal(p1.total, 25);
  assert.equal(p1.totalPages, 3);
  assert.equal(p1.items.length, 10);
  const p3 = await services.registrations.list({ page: 3, pageSize: 10 });
  assert.equal(p3.items.length, 5);
  const beyond = await services.registrations.list({ page: 99, pageSize: 10 });
  assert.equal(beyond.items.length, 0, 'a page past the end is empty, not an error');
  assert.equal((await services.registrations.list({ pageSize: 9999 })).pageSize, 200, 'page size is capped');
  assert.equal((await services.registrations.list({ pageSize: 0 })).pageSize, 20, 'invalid page size falls back');
});

// ===========================================================================
// §XXIX / §XXXIV — parking ticket (CII only)
// ===========================================================================

test('§XXIX parking tickets are refused for Thuận Giao', async () => {
  const services = await setup();
  const { registrations, checkins, parking, clock } = services;
  clock.setDate('2026-10-06');
  const reg = await registrations.createRegistration(agencyPayload({ visitDate: '2026-10-06' }));
  const user = (await services.auth.login('tg.reception01', 'Reception@123')).user;
  await checkins.checkIn(reg.id, { allowTimeOverride: true, user, method: 'SEARCH' });

  await assert.rejects(
    async () => parking.issue(reg.id, { vehicleType: 'CAR' }, { actor: { id: user.id, name: user.fullName } }),
    (e) => e.status === 400 && e.code === 'PARKING_TICKET_NOT_APPLICABLE',
  );
});

test('§XXIX a parking ticket cannot be issued before check-in', async () => {
  const services = await setup();
  const reg = await services.registrations.createRegistration(visitorPayload());
  await assert.rejects(
    async () => await services.parking.issue(reg.id, { vehicleType: 'CAR' }, { actor: { id: 'u', name: 'U' } }),
    (e) => e.status === 409 && e.code === 'PARKING_TICKET_REQUIRES_CHECKIN',
  );
});

test('§XXIX tickets are counted separately for cars and motorbikes', async () => {
  const services = await setup();
  const { registrations, checkins, parking, clock } = services;
  clock.setDate('2026-10-05');
  const reg = await registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05' }));
  const user = (await services.auth.login('cii.reception01', 'Reception@123')).user;
  const actor = { id: user.id, name: user.fullName };
  await checkins.checkIn(reg.id, { allowTimeOverride: true, user, method: 'QR' });

  const car = await parking.issue(reg.id, { vehicleType: 'CAR', ticketNumber: 'PX-001' }, { actor });
  await parking.issue(reg.id, { vehicleType: 'MOTORBIKE', ticketNumber: 'XM-11' }, { actor });
  await parking.issue(reg.id, { vehicleType: 'MOTORBIKE' }, { actor });

  assert.equal(car.vehicleType, 'CAR');
  assert.equal(car.ticketNumber, 'PX-001');
  assert.ok(car.issuedAt);
  assert.equal(car.issuedByName, user.fullName);
  assert.equal(car.returnedAt, null);

  const sum = await parking.summaryFor(reg.id);
  assert.equal(sum.total, 3);
  assert.deepEqual(sum.byVehicleType.CAR, { issued: 1, returned: 0, outstanding: 1 });
  assert.deepEqual(sum.byVehicleType.MOTORBIKE, { issued: 2, returned: 0, outstanding: 2 });
  assert.equal(sum.outstanding, 3);

  // The registration read model carries the same breakdown.
  const reread = await registrations.getById(reg.id);
  assert.equal(reread.parking.total, 3);
  assert.equal(reread.parking.byVehicleType.MOTORBIKE.issued, 2);
  assert.equal(reread.parkingTicketApplicable, true);
});

test('§XXIX an unknown vehicle type is refused', async () => {
  const services = await setup();
  const { registrations, checkins, parking, clock } = services;
  clock.setDate('2026-10-05');
  const reg = await registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05' }));
  const user = (await services.auth.login('cii.reception01', 'Reception@123')).user;
  await checkins.checkIn(reg.id, { allowTimeOverride: true, user });
  for (const bad of ['BICYCLE', 'car', '', null, undefined]) {
    await assert.rejects(
      async () => parking.issue(reg.id, { vehicleType: bad }, { actor: { id: user.id, name: user.fullName } }),
      (e) => e.code === 'INVALID_VEHICLE_TYPE', String(bad),
    );
  }
});

test('§XXIX returning a ticket records who took it back, and only once', async () => {
  const services = await setup();
  const { registrations, checkins, parking, clock } = services;
  clock.setDate('2026-10-05');
  const reg = await registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05' }));
  const user = (await services.auth.login('cii.reception01', 'Reception@123')).user;
  const actor = { id: user.id, name: user.fullName };
  await checkins.checkIn(reg.id, { allowTimeOverride: true, user });

  const t = await parking.issue(reg.id, { vehicleType: 'CAR', ticketNumber: 'PX-7' }, { actor });
  const returned = await parking.markReturned(t.id, { actor });
  assert.ok(returned.returnedAt);
  assert.equal(returned.returnedByName, user.fullName);
  assert.equal(returned.ticketNumber, 'PX-7', 'the number survives the return');

  await assert.rejects(async () => parking.markReturned(t.id, { actor }),
    (e) => e.code === 'PARKING_TICKET_ALREADY_RETURNED');
  await assert.rejects(async () => parking.markReturned('no-such-ticket', { actor }),
    (e) => e.status === 404 && e.code === 'PARKING_TICKET_NOT_FOUND');

  const sum = await parking.summaryFor(reg.id);
  assert.deepEqual(sum.byVehicleType.CAR, { issued: 1, returned: 1, outstanding: 0 });
});

test('§XXIX the same physical ticket cannot be out twice', async () => {
  const services = await setup();
  const { registrations, checkins, parking, clock } = services;
  clock.setDate('2026-10-05');
  const a = await registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05', cccd: '111111111111' }));
  const b = await registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05', cccd: '222222222222' }));
  const user = (await services.auth.login('cii.reception01', 'Reception@123')).user;
  const actor = { id: user.id, name: user.fullName };
  await checkins.checkIn(a.id, { allowTimeOverride: true, user });
  await checkins.checkIn(b.id, { allowTimeOverride: true, user });

  const first = await parking.issue(a.id, { vehicleType: 'CAR', ticketNumber: 'PX-9' }, { actor });
  await assert.rejects(
    async () => parking.issue(b.id, { vehicleType: 'CAR', ticketNumber: 'PX-9' }, { actor }),
    (e) => e.status === 409 && e.code === 'PARKING_TICKET_NUMBER_IN_USE',
  );

  // The same number for a motorbike is a different book of tickets.
  assert.ok(await parking.issue(b.id, { vehicleType: 'MOTORBIKE', ticketNumber: 'PX-9' }, { actor }));

  // Once returned, the car ticket can be handed out again.
  await parking.markReturned(first.id, { actor });
  assert.ok(await parking.issue(b.id, { vehicleType: 'CAR', ticketNumber: 'PX-9' }, { actor }));
});

test('§XXIX a ticket issued in error can be removed', async () => {
  const services = await setup();
  const { registrations, checkins, parking, clock } = services;
  clock.setDate('2026-10-05');
  const reg = await registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05' }));
  const user = (await services.auth.login('cii.reception01', 'Reception@123')).user;
  const actor = { id: user.id, name: user.fullName };
  await checkins.checkIn(reg.id, { allowTimeOverride: true, user });

  const t = await parking.issue(reg.id, { vehicleType: 'MOTORBIKE' }, { actor });
  assert.equal((await parking.summaryFor(reg.id)).total, 1);
  await parking.remove(t.id);
  assert.equal((await parking.summaryFor(reg.id)).total, 0);
  await assert.rejects(async () => parking.remove(t.id), (e) => e.code === 'PARKING_TICKET_NOT_FOUND');
});

test('§XXXVIII the list can be filtered by ticket state and by vehicle type', async () => {
  const services = await setup();
  const { registrations, checkins, parking, clock } = services;
  clock.setDate('2026-10-05');
  const withCar = await registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05', cccd: '111111111111' }));
  const withMoto = await registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05', cccd: '222222222222', timeSlotId: SLOT_1030 }));
  const without = await registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05', cccd: '333333333333', timeSlotId: SLOT_B }));
  const user = (await services.auth.login('cii.reception01', 'Reception@123')).user;
  const actor = { id: user.id, name: user.fullName };
  for (const r of [withCar, withMoto, without]) {
    // eslint-disable-next-line no-await-in-loop
    await checkins.checkIn(r.id, { allowTimeOverride: true, user });
  }
  await parking.issue(withCar.id, { vehicleType: 'CAR' }, { actor });
  const m = await parking.issue(withMoto.id, { vehicleType: 'MOTORBIKE' }, { actor });

  assert.equal((await registrations.list({ parkingTicket: 'issued' })).total, 2);
  assert.equal((await registrations.list({ parkingTicket: 'not_issued' })).total, 1);
  assert.equal((await registrations.list({ parkingTicket: 'car' })).items[0].id, withCar.id);
  assert.equal((await registrations.list({ parkingTicket: 'motorbike' })).items[0].id, withMoto.id);
  assert.equal((await registrations.list({ parkingTicket: 'outstanding' })).total, 2);

  await parking.markReturned(m.id, { actor });
  assert.equal((await registrations.list({ parkingTicket: 'returned' })).total, 1);
  assert.equal((await registrations.list({ parkingTicket: 'outstanding' })).total, 1);
});

// ===========================================================================
// §XXV — office access guard
// ===========================================================================

test('§XXV assertOfficeAccess blocks cross-office access but frees manager and admin', async () => {
  const services = await setup();
  const reg = await services.registrations.createRegistration(visitorPayload()); // CII
  const ciiUser = { role: 'RECEPTIONIST', salesOfficeId: OFFICE_CII };
  const tgUser = { role: 'RECEPTIONIST', salesOfficeId: OFFICE_TG };

  assert.doesNotThrow(() => services.registrations.assertOfficeAccess(reg, ciiUser));
  assert.throws(() => services.registrations.assertOfficeAccess(reg, tgUser), (e) => e.status === 403);
  assert.doesNotThrow(() => services.registrations.assertOfficeAccess(reg, { role: 'MANAGER', salesOfficeId: null }));
  assert.doesNotThrow(() => services.registrations.assertOfficeAccess(reg, { role: 'ADMINISTRATOR', salesOfficeId: null }));
});
