'use strict';

/**
 * What the desk asked for after the first weeks of real use:
 *
 *  1. Parking tickets are issued in a quantity. Typing "10" used to produce ONE
 *     ticket numbered "10", which is why the register and the pile of tickets in
 *     the drawer stopped agreeing.
 *  2. A check-in can be corrected afterwards — the arrival count, the slot the
 *     group really walked into, the agency's sales staff.
 *  3. Reception registers a walk-in at the desk, instead of asking the guest to
 *     fill in the public form on a phone.
 *  4. Every registration carries a guest category.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startServer, makeClock, visitorPayload, agencyPayload, CREDS,
  OFFICE_CII, SLOT_A, SLOT_1030,
} = require('./helpers');
const { MAX_TICKETS_PER_ISSUE } = require('../src/config/master-data');

const A = (t) => ({ token: t });
const DAY = '2026-10-05';
const at = (hhmm, day = DAY) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(...day.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))), h - 7, m));
};

/** A desk mid-morning: inside SLOT_A (09:00–10:30), at the CII office. */
async function desk(hhmm = '09:30') {
  const server = await startServer({ clock: makeClock(at(hhmm)) });
  const reception = await server.login(...CREDS.ciiReception);
  const sales = await server.login(...CREDS.ciiSales);
  let n = 0;
  const book = async (over = {}) => {
    n += 1;
    const res = await server.post('/api/registrations', visitorPayload({
      salesOfficeId: OFFICE_CII, visitDate: DAY, timeSlotId: SLOT_A, numberOfVisitors: 2,
      cccd: String(790000000000 + n), phone: `09${String(10000000 + n)}`, ...over,
    }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };
  const checkin = (id, body = {}) => server.post(`/api/staff/registrations/${id}/checkin`,
    { method: 'SEARCH', ...body }, A(reception.token));
  return { server, reception, sales, book, checkin };
}

// ===========================================================================
// 1. Parking tickets come in quantities
// ===========================================================================

test('a quantity issues that many tickets — the bug where "10" produced one ticket', async (t) => {
  const d = await desk();
  t.after(() => d.server.close());

  const reg = await d.book();
  await d.checkin(reg.registrationId);

  const res = await d.server.post(
    `/api/staff/registrations/${reg.registrationId}/parking-tickets`,
    { vehicleType: 'MOTORBIKE', quantity: 10 }, A(d.reception.token),
  );

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.issued, 10, 'ten tickets asked for, ten issued');
  assert.equal(res.body.tickets.length, 10);
  assert.equal(res.body.parking.byVehicleType.MOTORBIKE.issued, 10,
    'the register agrees with what the desk handed out');
  assert.equal(res.body.parking.byVehicleType.MOTORBIKE.outstanding, 10);
  // Nothing was silently written as a ticket NUMBER of 10.
  assert.deepEqual(res.body.tickets.map((x) => x.ticketNumber), new Array(10).fill(null));
});

test('ticket numbers are one per ticket, and a short list is refused rather than padded', async (t) => {
  const d = await desk();
  t.after(() => d.server.close());

  const reg = await d.book();
  await d.checkin(reg.registrationId);
  const url = `/api/staff/registrations/${reg.registrationId}/parking-tickets`;

  const ok = await d.server.post(url,
    { vehicleType: 'CAR', ticketNumbers: ['12', '13', '14'] }, A(d.reception.token));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.issued, 3, 'three numbers means three tickets');
  assert.deepEqual(ok.body.tickets.map((x) => x.ticketNumber), ['12', '13', '14']);

  const mismatch = await d.server.post(url,
    { vehicleType: 'CAR', quantity: 3, ticketNumbers: ['20'] }, A(d.reception.token));
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.code, 'TICKET_NUMBER_COUNT_MISMATCH');

  const repeated = await d.server.post(url,
    { vehicleType: 'CAR', ticketNumbers: ['30', '30'] }, A(d.reception.token));
  assert.equal(repeated.status, 400);
  assert.equal(repeated.body.error.code, 'PARKING_TICKET_NUMBER_REPEATED');

  // Neither failure may leave a partial batch behind.
  const after = await d.server.get(`/api/staff/registrations/${reg.registrationId}/parking-tickets`,
    A(d.reception.token));
  assert.equal(after.body.byVehicleType.CAR.issued, 3, 'only the good batch is on the register');
});

test('a clash part-way through a batch writes none of it', async (t) => {
  const d = await desk();
  t.after(() => d.server.close());

  const a = await d.book();
  await d.checkin(a.registrationId);
  const b = await d.book();
  await d.checkin(b.registrationId);

  await d.server.post(`/api/staff/registrations/${a.registrationId}/parking-tickets`,
    { vehicleType: 'CAR', ticketNumbers: ['PX-5'] }, A(d.reception.token));

  const clash = await d.server.post(`/api/staff/registrations/${b.registrationId}/parking-tickets`,
    { vehicleType: 'CAR', ticketNumbers: ['PX-1', 'PX-2', 'PX-5'] }, A(d.reception.token));
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, 'PARKING_TICKET_NUMBER_IN_USE');

  const after = await d.server.get(`/api/staff/registrations/${b.registrationId}/parking-tickets`,
    A(d.reception.token));
  assert.equal(after.body.total, 0,
    'PX-1 and PX-2 are not left out on their own after the batch failed');
});

test('a mistyped quantity is refused at the desk, not written', async (t) => {
  const d = await desk();
  t.after(() => d.server.close());

  const reg = await d.book();
  await d.checkin(reg.registrationId);
  const url = `/api/staff/registrations/${reg.registrationId}/parking-tickets`;

  for (const [quantity, code] of [
    [0, 'INVALID_TICKET_QUANTITY'],
    [-3, 'INVALID_TICKET_QUANTITY'],
    [2.5, 'INVALID_TICKET_QUANTITY'],
    [MAX_TICKETS_PER_ISSUE + 1, 'TOO_MANY_TICKETS'],
    [100, 'TOO_MANY_TICKETS'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await d.server.post(url, { vehicleType: 'CAR', quantity }, A(d.reception.token));
    assert.equal(res.body.error.code, code, `quantity ${quantity}`);
  }

  const after = await d.server.get(url, A(d.reception.token));
  assert.equal(after.body.total, 0);
});

test('a returned number can be issued again — the physical ticket is back in the drawer', async (t) => {
  const d = await desk();
  t.after(() => d.server.close());

  const reg = await d.book();
  await d.checkin(reg.registrationId);
  const url = `/api/staff/registrations/${reg.registrationId}/parking-tickets`;

  const first = await d.server.post(url,
    { vehicleType: 'CAR', ticketNumbers: ['PX-1'] }, A(d.reception.token));
  const id = first.body.tickets[0].id;

  const blocked = await d.server.post(url,
    { vehicleType: 'CAR', ticketNumbers: ['PX-1'] }, A(d.reception.token));
  assert.equal(blocked.body.error.code, 'PARKING_TICKET_NUMBER_IN_USE',
    'while it is still out, the same number cannot go out twice');

  await d.server.post(`/api/staff/parking-tickets/${id}/return`, {}, A(d.reception.token));

  const again = await d.server.post(url,
    { vehicleType: 'CAR', ticketNumbers: ['PX-1'] }, A(d.reception.token));
  assert.equal(again.status, 201, 'once returned it may be handed out again');
});

// ===========================================================================
// 2. Correcting a check-in
// ===========================================================================

test('reception corrects the arrival count after check-in, and the correction is on the record', async (t) => {
  const d = await desk();
  t.after(() => d.server.close());

  const reg = await d.book({ numberOfVisitors: 5 });
  await d.checkin(reg.registrationId, { actualGuests: 4 });

  const res = await d.server.patch(`/api/staff/registrations/${reg.registrationId}/checkin`,
    { actualGuests: 6 }, A(d.reception.token));

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.changed, true);
  assert.equal(res.body.checkin.actualGuests, 6);
  assert.equal(res.body.checkin.expectedGuests, 5, 'what was booked is still history');

  const note = res.body.registration.statusHistory.at(-1);
  assert.match(note.note, /Check-in corrected/);
  assert.match(note.note, /guests 4 → 6/);
  assert.equal(note.changedByName, d.reception.user.fullName,
    'who made the correction is recorded (§Rule 7)');
  assert.equal(res.body.registration.status, 'CHECKED_IN', 'the status does not move');
});

test('a correction cannot push a slot past its capacity', async (t) => {
  const d = await desk();
  t.after(() => d.server.close());

  // 28 of the 30 places in SLOT_A are taken by other groups.
  const big = await d.book({ numberOfVisitors: 20 });
  await d.checkin(big.registrationId);
  const mid = await d.book({ numberOfVisitors: 8 });
  await d.checkin(mid.registrationId);

  const ours = await d.book({ numberOfVisitors: 2 });
  await d.checkin(ours.registrationId, { actualGuests: 2 });

  const res = await d.server.patch(`/api/staff/registrations/${ours.registrationId}/checkin`,
    { actualGuests: 5 }, A(d.reception.token));

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'SLOT_CAPACITY_EXCEEDED');
  assert.equal(res.body.error.details.maxGuests, 2,
    'the group is not counted against itself — two places really are free');

  // Correcting to exactly what fits is allowed.
  const ok = await d.server.patch(`/api/staff/registrations/${ours.registrationId}/checkin`,
    { actualGuests: 2 }, A(d.reception.token));
  assert.equal(ok.status, 200);
});

test('reception corrects the slot a group actually walked into', async (t) => {
  const d = await desk();
  t.after(() => d.server.close());

  const reg = await d.book();
  await d.checkin(reg.registrationId);

  const res = await d.server.patch(`/api/staff/registrations/${reg.registrationId}/checkin`,
    { admittedSlotId: SLOT_1030 }, A(d.reception.token));

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.checkin.admittedSlotId, SLOT_1030);
  assert.match(res.body.registration.statusHistory.at(-1).note, /slot /);

  const bad = await d.server.patch(`/api/staff/registrations/${reg.registrationId}/checkin`,
    { admittedSlotId: 'SLOT_NOPE' }, A(d.reception.token));
  assert.equal(bad.body.error.code, 'INVALID_TIME_SLOT');
});

test('the agency sales staff can be corrected; a walk-in visitor has none to correct', async (t) => {
  const d = await desk();
  t.after(() => d.server.close());

  const ag = await d.server.post('/api/registrations', agencyPayload({
    salesOfficeId: OFFICE_CII, visitDate: DAY, timeSlotId: SLOT_A, numberOfVisitors: 2,
  }));
  assert.equal(ag.status, 201, JSON.stringify(ag.body));
  await d.checkin(ag.body.registrationId);

  const ok = await d.server.patch(`/api/staff/registrations/${ag.body.registrationId}/checkin`,
    { salesStaffName: 'Trần Thị Đúng' }, A(d.reception.token));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.registration.agency.salesStaffName, 'Trần Thị Đúng');

  const blank = await d.server.patch(`/api/staff/registrations/${ag.body.registrationId}/checkin`,
    { salesStaffName: '   ' }, A(d.reception.token));
  assert.equal(blank.body.error.code, 'SALES_STAFF_NAME_REQUIRED');

  const visitor = await d.book();
  await d.checkin(visitor.registrationId);
  const wrong = await d.server.patch(`/api/staff/registrations/${visitor.registrationId}/checkin`,
    { salesStaffName: 'Ai Đó' }, A(d.reception.token));
  assert.equal(wrong.body.error.code, 'NOT_AN_AGENCY_REGISTRATION');
});

test('nothing can be corrected before a check-in exists, and sales may not correct one', async (t) => {
  const d = await desk();
  t.after(() => d.server.close());

  const reg = await d.book();

  const early = await d.server.patch(`/api/staff/registrations/${reg.registrationId}/checkin`,
    { actualGuests: 3 }, A(d.reception.token));
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'NOT_CHECKED_IN');

  await d.checkin(reg.registrationId);
  const bySales = await d.server.patch(`/api/staff/registrations/${reg.registrationId}/checkin`,
    { actualGuests: 3 }, A(d.sales.token));
  assert.equal(bySales.status, 403, 'correcting a check-in belongs to the desk that made it');
});

// ===========================================================================
// 3. Walk-in registration at the desk
// ===========================================================================

test('reception registers a walk-in and checks them in, in one sitting', async (t) => {
  const d = await desk();
  t.after(() => d.server.close());

  const created = await d.server.post('/api/registrations', visitorPayload({
    salesOfficeId: OFFICE_CII, visitDate: DAY, timeSlotId: SLOT_A,
    numberOfVisitors: 3, cccd: '011122233344', phone: '0988777666',
    guestCategory: 'BOARD_GUEST',
  }), A(d.reception.token));

  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.summary.guestCategory, 'BOARD_GUEST');

  const checked = await d.checkin(created.body.registrationId, { actualGuests: 3 });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal(checked.body.registration.status, 'CHECKED_IN');
  assert.equal(checked.body.checkin.actualGuests, 3);
});

test('a walk-in is still held to the slot capacity', async (t) => {
  const d = await desk();
  t.after(() => d.server.close());

  const full = await d.book({ numberOfVisitors: 20 });
  await d.checkin(full.registrationId);
  const more = await d.book({ numberOfVisitors: 10 });
  await d.checkin(more.registrationId);

  const walkIn = await d.server.post('/api/registrations', visitorPayload({
    salesOfficeId: OFFICE_CII, visitDate: DAY, timeSlotId: SLOT_A, numberOfVisitors: 1,
    cccd: '011199988877', phone: '0912000111',
  }), A(d.reception.token));

  assert.equal(walkIn.status, 409, 'the desk cannot register past a full slot either');
});

// ===========================================================================
// 4. Guest category
// ===========================================================================

test('guest category is stored, returned and refused when missing or unknown', async (t) => {
  const d = await desk();
  t.after(() => d.server.close());

  const ok = await d.server.post('/api/registrations', visitorPayload({
    salesOfficeId: OFFICE_CII, visitDate: DAY, timeSlotId: SLOT_A,
    cccd: '011100022233', phone: '0901000222', guestCategory: 'OTHER_PARTNER',
  }));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.summary.guestCategory, 'OTHER_PARTNER');

  const missing = await d.server.post('/api/registrations', (() => {
    const p = visitorPayload({
      salesOfficeId: OFFICE_CII, visitDate: DAY, timeSlotId: SLOT_A,
      cccd: '011100022234', phone: '0901000223',
    });
    delete p.guestCategory;
    return p;
  })());
  assert.equal(missing.status, 400);
  assert.ok(missing.body.error.details.some((e) => e.code === 'GUEST_CATEGORY_REQUIRED'));

  const unknown = await d.server.post('/api/registrations', visitorPayload({
    salesOfficeId: OFFICE_CII, visitDate: DAY, timeSlotId: SLOT_A,
    cccd: '011100022235', phone: '0901000224', guestCategory: 'VIP',
  }));
  assert.equal(unknown.status, 400);
  assert.ok(unknown.body.error.details.some((e) => e.code === 'INVALID_GUEST_CATEGORY'));
});

test('the four categories are published to the registration form', async (t) => {
  const d = await desk();
  t.after(() => d.server.close());

  const cfg = await d.server.get('/api/config');
  assert.deepEqual(cfg.body.guestCategories.map((c) => c.id),
    ['BOARD_GUEST', 'SALES_PARTNER', 'CUSTOMER', 'OTHER_PARTNER']);
  assert.equal(cfg.body.guestCategories[0].vi, 'Khách của HĐQT');
  assert.equal(cfg.body.rules.maxTicketsPerIssue, MAX_TICKETS_PER_ISSUE);
});
