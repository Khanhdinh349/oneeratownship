'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startServer, makeClock, visitorPayload, agencyPayload,
  TODAY, PLUS_10, PLUS_11, OFFICE_CII, OFFICE_TG, SLOT_A, SLOT_B, SLOT_1030, CREDS,
} = require('./helpers');

/** Boots a server whose "today" is `date`, and tears it down after the test. */
async function server(t, date = '2026-10-01') {
  const clock = makeClock(`${date}T02:30:00.000Z`);
  const s = await startServer({ clock });
  t.after(() => s.close());
  return s;
}

// ===========================================================================
// META / CONFIG
// ===========================================================================

test('GET /api/health reports the server clock', async (t) => {
  const s = await server(t);
  const res = await s.get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.now, '2026-10-01T02:30:00.000Z');
});

test('GET /api/config exposes the master data the wizard needs', async (t) => {
  const s = await server(t);
  const { status, body } = await s.get('/api/config');
  assert.equal(status, 200);
  assert.deepEqual(body.languages, ['vi', 'en'], '§XLVI.1');
  assert.deepEqual(body.visitorTypes, ['VISITOR', 'AGENCY'], '§XLVI.3');
  assert.equal(body.salesOffices.length, 2, '§XLVI.2');
  assert.equal(body.timeSlots.length, 4, '§VIII four booking windows');
  body.timeSlots.forEach((sl) => assert.equal(sl.capacity, 30, '§VIII 30 guests per slot'));
  assert.equal(body.rules.slotCapacity, 30);
  assert.equal(body.rules.maxAdvanceDays, 10, '§XLVI.4');
  assert.equal(body.rules.confirmationCodeFormat, 'OE-XXXXX', '§XLVI.6');
  assert.equal(body.rules.autoRefreshMs, 60000, '§XXXVII / §XLVI.15');
  assert.equal(body.today, TODAY);
  assert.equal(body.selectableDates.length, 11);
  assert.equal(body.selectableDates.at(-1), PLUS_10);
  assert.ok(body.agencies.length >= 1, '§XI agencies come from master data');
});

test('GET /api/config no longer carries any business-confirmation message', async (t) => {
  const s = await server(t);
  const { body } = await s.get('/api/config');
  assert.equal(body.openBusinessQuestions, undefined, 'the open-question block is gone');
  const nine = body.timeSlots.filter((sl) => sl.label === '09:00 – 10:30');
  assert.equal(nine.length, 1, 'one 09:00 slot');
  body.timeSlots.forEach((sl) => {
    assert.equal(sl.needsBusinessConfirmation, undefined);
    assert.equal(sl.confirmationNote, undefined);
  });
  assert.equal(JSON.stringify(body).toLowerCase().includes('confirmation note'), false);
});

test('GET /api/availability requires both office and date', async (t) => {
  const s = await server(t);
  assert.equal((await s.get('/api/availability')).status, 400);
  assert.equal((await s.get(`/api/availability?salesOfficeId=${OFFICE_CII}`)).status, 400);
  const ok = await s.get(`/api/availability?salesOfficeId=${OFFICE_CII}&visitDate=2026-10-05`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.slots.length, 4);
  assert.equal(ok.body.slots[0].fullyBooked, false);
});

test('unknown API endpoints return a structured 404', async (t) => {
  const s = await server(t);
  const { status, body } = await s.get('/api/does-not-exist');
  assert.equal(status, 404);
  assert.equal(body.error.code, 'ENDPOINT_NOT_FOUND');
});

test('a malformed JSON body returns a structured 400', async (t) => {
  const s = await server(t);
  const res = await fetch(`${s.base}/api/registrations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'INVALID_JSON');
});

// ===========================================================================
// §XVIII / §XIX — public registration + success page payload
// ===========================================================================

test('POST /api/registrations creates a visitor registration and returns the success payload', async (t) => {
  const s = await server(t);
  const { status, body } = await s.post('/api/registrations', visitorPayload());

  assert.equal(status, 201);
  assert.match(body.confirmationCode, /^OE-[0-9A-Z]{5}$/, '§XVIII.2');
  assert.ok(body.registrationId, '§XVIII.1');
  assert.match(body.qrPayload, /^https:\/\/test\.kinera\.local\/checkin\?t=/, '§XVIII.3');
  assert.equal(body.status, 'REGISTERED');
  assert.equal(body.summary.displayName, 'Nguyễn Văn A', '§XIX');
  assert.equal(body.summary.salesOffice.name, 'CII - Bình Thạnh');
  assert.equal(body.summary.timeSlot.label, '09:00 – 10:30');
  assert.equal(body.summary.numberOfVisitors, 3);
  assert.equal(body.summary.visitDate, '2026-10-05');
});

test('§XVIII.3 the QR payload embeds no personal information', async (t) => {
  const s = await server(t);
  const { body } = await s.post('/api/registrations', visitorPayload());
  for (const personal of ['Nguyễn', '012345678901', '0901234567', 'example.com', 'CII']) {
    assert.equal(body.qrPayload.includes(personal), false, `QR must not contain ${personal}`);
  }
});

test('§XIX the QR PNG renders only when the matching token is presented', async (t) => {
  const s = await server(t);
  const { body } = await s.post('/api/registrations', visitorPayload());

  const ok = await s.request('GET', body.qrImageUrl, { raw: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await ok.arrayBuffer());
  assert.ok(bytes.length > 100, 'a real PNG came back');
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG magic number');

  const noToken = await s.get(`/api/registrations/${body.confirmationCode}/qr.png`);
  assert.equal(noToken.status, 403, 'the confirmation code alone cannot mint the QR');
  const wrongToken = await s.get(`/api/registrations/${body.confirmationCode}/qr.png?token=nope`);
  assert.equal(wrongToken.status, 403);
  const unknown = await s.get('/api/registrations/OE-ZZZZZ/qr.png?token=x');
  assert.equal(unknown.status, 404);
});

test('§XIX a visitor can re-open their own confirmation with code plus token', async (t) => {
  const s = await server(t);
  const { body } = await s.post('/api/registrations', visitorPayload());
  const ok = await s.get(`/api/registrations/lookup?code=${body.confirmationCode}&token=${encodeURIComponent(body.qrToken)}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.confirmationCode, body.confirmationCode);
  assert.equal(ok.body.status, 'REGISTERED');

  const bad = await s.get(`/api/registrations/lookup?code=${body.confirmationCode}&token=wrong`);
  assert.equal(bad.status, 404, 'the code alone reveals nothing');
});

test('§XXII POST /api/registrations creates an agency registration', async (t) => {
  const s = await server(t);
  const { status, body } = await s.post('/api/registrations', agencyPayload());
  assert.equal(status, 201);
  assert.equal(body.summary.displayName, 'IQI');
  assert.equal(body.summary.salesOffice.name, 'Thuận Giao - Bình Dương');
  assert.equal(body.summary.numberOfVisitors, 5);
});

test('§XLI Process 4 validation failures come back field by field', async (t) => {
  const s = await server(t);
  const { status, body } = await s.post('/api/registrations', visitorPayload({
    fullName: '', cccd: '123', phone: 'abc', email: 'nope', numberOfVisitors: 0,
  }));
  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_FAILED');
  const byField = Object.fromEntries(body.error.details.map((d) => [d.field, d.code]));
  assert.equal(byField.fullName, 'REQUIRED');
  assert.equal(byField.cccd, 'INVALID_CCCD');
  assert.equal(byField.phone, 'INVALID_PHONE');
  assert.equal(byField.email, 'INVALID_EMAIL');
  assert.equal(byField.numberOfVisitors, 'NUMBER_OF_VISITORS_TOO_LOW');
});

test('§VII the API rejects a visit date past the 10-day window', async (t) => {
  const s = await server(t);
  const { status, body } = await s.post('/api/registrations', visitorPayload({ visitDate: PLUS_11 }));
  assert.equal(status, 400);
  assert.equal(body.error.details[0].code, 'VISIT_DATE_OUT_OF_RANGE');

  const edge = await s.post('/api/registrations', visitorPayload({ visitDate: PLUS_10 }));
  assert.equal(edge.status, 201, 'today+10 is still accepted');
});

test('§VIII the API refuses a fully booked slot and reports availability', async (t) => {
  const s = await server(t);
  const admin = await s.login(...CREDS.admin);
  await s.patch(`/api/admin/time-slots/${SLOT_A}`, { capacity: 3 }, { token: admin.token });

  const first = await s.post('/api/registrations', visitorPayload({ numberOfVisitors: 3, cccd: '111111111111' }));
  assert.equal(first.status, 201);

  const avail = await s.get(`/api/availability?salesOfficeId=${OFFICE_CII}&visitDate=2026-10-05`);
  const slot = avail.body.slots.find((x) => x.slotId === SLOT_A);
  assert.equal(slot.fullyBooked, true);
  assert.equal(slot.remaining, 0);
  assert.equal(slot.booked, 3, 'remaining is computed from live registrations');

  const second = await s.post('/api/registrations', visitorPayload({ numberOfVisitors: 1, cccd: '222222222222' }));
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'TIME_SLOT_FULLY_BOOKED');
});

test('§Rule 11 the API rejects a duplicate registration with the original code', async (t) => {
  const s = await server(t);
  const first = await s.post('/api/registrations', visitorPayload());
  const dup = await s.post('/api/registrations', visitorPayload());
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'DUPLICATE_REGISTRATION');
  assert.equal(dup.body.error.details.confirmationCode, first.body.confirmationCode);
});

// ===========================================================================
// §XXV — login
// ===========================================================================

test('§XXV POST /api/auth/login returns a token, the office and the permission set', async (t) => {
  const s = await server(t);
  const { status, body } = await s.post('/api/auth/login', {
    username: 'cii.reception01', password: 'Reception@123',
  });
  assert.equal(status, 200);
  assert.ok(body.token);
  assert.equal(body.user.role, 'RECEPTIONIST');
  assert.equal(body.user.salesOffice.name, 'CII - Bình Thạnh');
  assert.ok(body.permissions.includes('checkin:perform'));
  assert.equal(body.permissions.includes('dashboard:view'), false);
});

test('§XXV bad credentials return 401 without leaking which part was wrong', async (t) => {
  const s = await server(t);
  const a = await s.post('/api/auth/login', { username: 'cii.reception01', password: 'nope' });
  const b = await s.post('/api/auth/login', { username: 'ghost', password: 'nope' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.body.error.message, b.body.error.message);
});

test('§XXV protected endpoints reject missing and invalid bearer tokens', async (t) => {
  const s = await server(t);
  for (const token of [undefined, 'garbage', 'a.b']) {
    const res = await s.get('/api/staff/registrations', { token });
    assert.equal(res.status, 401, `token ${token}`);
  }
});

test('GET /api/auth/me echoes the caller identity, permissions and office scope', async (t) => {
  const s = await server(t);
  const reception = await s.login(...CREDS.ciiReception);
  const me = await s.get('/api/auth/me', { token: reception.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, 'cii.reception01');
  assert.equal(me.body.scopeOfficeId, OFFICE_CII);

  const manager = await s.login(...CREDS.manager);
  const mgr = await s.get('/api/auth/me', { token: manager.token });
  assert.equal(mgr.body.scopeOfficeId, null, 'a manager is not office-scoped');
});

// ===========================================================================
// §XXVI–§XXVIII — reception check-in over HTTP
// ===========================================================================

test('§XXVI–§XXVIII the full arrival flow: scan → review → check in', async (t) => {
  const s = await server(t, '2026-10-05');
  const created = await s.post('/api/registrations', visitorPayload({ visitDate: '2026-10-05' }));
  const reception = await s.login(...CREDS.ciiReception);

  const scan = await s.post('/api/staff/checkin/scan',
    { token: created.body.qrToken }, { token: reception.token });
  assert.equal(scan.status, 200);
  assert.equal(scan.body.method, 'QR');
  assert.equal(scan.body.readiness.canCheckIn, true);
  assert.equal(scan.body.registration.confirmationCode, created.body.confirmationCode);
  assert.equal(scan.body.registration.qrToken, undefined, 'the token is never echoed back');

  const done = await s.post(`/api/staff/registrations/${scan.body.registration.id}/checkin`,
    { method: 'QR' }, { token: reception.token });
  assert.equal(done.status, 200);
  assert.equal(done.body.message, 'Check-in Successful', '§XLIII');
  assert.equal(done.body.registration.status, 'CHECKED_IN');
  assert.ok(done.body.checkin.checkinTime);
  assert.equal(done.body.checkin.receptionistName, reception.user.fullName);

  const again = await s.post(`/api/staff/registrations/${scan.body.registration.id}/checkin`,
    { method: 'QR' }, { token: reception.token });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ALREADY_CHECKED_IN');
});

test('§XXVI.2 the desk can resolve a visitor by confirmation code', async (t) => {
  const s = await server(t, '2026-10-05');
  const created = await s.post('/api/registrations', visitorPayload({ visitDate: '2026-10-05' }));
  const reception = await s.login(...CREDS.ciiReception);

  const res = await s.post('/api/staff/checkin/resolve',
    { confirmationCode: created.body.confirmationCode.toLowerCase() }, { token: reception.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.method, 'SEARCH');
  assert.equal(res.body.registration.confirmationCode, created.body.confirmationCode);

  const miss = await s.post('/api/staff/checkin/resolve',
    { confirmationCode: 'OE-ZZZZZ' }, { token: reception.token });
  assert.equal(miss.status, 404);
});

test('§XXVI.1 an invalid QR is rejected with 400 before any lookup', async (t) => {
  const s = await server(t, '2026-10-05');
  const reception = await s.login(...CREDS.ciiReception);
  const res = await s.post('/api/staff/checkin/scan', { token: 'not-a-token' }, { token: reception.token });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'INVALID_QR_TOKEN');
});

test('§XXV a receptionist cannot scan or check in the other office\'s visitor', async (t) => {
  const s = await server(t, '2026-10-05');
  const created = await s.post('/api/registrations', visitorPayload({ visitDate: '2026-10-05' })); // CII
  const tg = await s.login(...CREDS.tgReception);

  const scan = await s.post('/api/staff/checkin/scan', { token: created.body.qrToken }, { token: tg.token });
  assert.equal(scan.status, 403);

  const checkin = await s.post(`/api/staff/registrations/${created.body.registrationId}/checkin`,
    {}, { token: tg.token });
  assert.equal(checkin.status, 403);

  const detail = await s.get(`/api/staff/registrations/${created.body.registrationId}`, { token: tg.token });
  assert.equal(detail.status, 403, 'nor read its detail');
});

test('§XXVIII.3 check-in on the wrong day needs an explicit override', async (t) => {
  const s = await server(t, '2026-10-05');
  const created = await s.post('/api/registrations', visitorPayload({ visitDate: '2026-10-09' }));
  const reception = await s.login(...CREDS.ciiReception);

  const refused = await s.post(`/api/staff/registrations/${created.body.registrationId}/checkin`,
    {}, { token: reception.token });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'VISIT_DATE_MISMATCH');
  assert.equal(refused.body.error.details.overridable, true);

  const forced = await s.post(`/api/staff/registrations/${created.body.registrationId}/checkin`,
    { allowDateOverride: true }, { token: reception.token });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.registration.status, 'CHECKED_IN');
});

test('§XXXIX sales and manager roles cannot perform a check-in over the API', async (t) => {
  const s = await server(t, '2026-10-05');
  const created = await s.post('/api/registrations', visitorPayload({ visitDate: '2026-10-05' }));
  for (const creds of [CREDS.ciiSales, CREDS.manager]) {
    const who = await s.login(...creds);
    const res = await s.post(`/api/staff/registrations/${created.body.registrationId}/checkin`,
      {}, { token: who.token });
    assert.equal(res.status, 403, creds[0]);
  }
});

// ===========================================================================
// §XXIII — status endpoint
// ===========================================================================

test('§XXIII the status endpoint enforces the lifecycle', async (t) => {
  const s = await server(t, '2026-10-05');
  const created = await s.post('/api/registrations', visitorPayload({ visitDate: '2026-10-05' }));
  const reception = await s.login(...CREDS.ciiReception);
  const id = created.body.registrationId;

  const confirmed = await s.post(`/api/staff/registrations/${id}/status`,
    { status: 'CONFIRMED', note: 'phoned' }, { token: reception.token });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.status, 'CONFIRMED');

  const illegal = await s.post(`/api/staff/registrations/${id}/status`,
    { status: 'COMPLETED' }, { token: reception.token });
  assert.equal(illegal.status, 409);
  assert.equal(illegal.body.error.code, 'INVALID_STATUS_TRANSITION');
  assert.deepEqual(illegal.body.error.details.allowed,
    ['EXPECTED', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW']);

  const unknown = await s.post(`/api/staff/registrations/${id}/status`,
    { status: 'TELEPORTED' }, { token: reception.token });
  assert.equal(unknown.status, 409);
  assert.equal(unknown.body.error.code, 'UNKNOWN_STATUS');
});

test('§XXIII status history is returned with actor and note', async (t) => {
  const s = await server(t, '2026-10-05');
  const created = await s.post('/api/registrations', visitorPayload({ visitDate: '2026-10-05' }));
  const reception = await s.login(...CREDS.ciiReception);
  const id = created.body.registrationId;
  await s.post(`/api/staff/registrations/${id}/status`, { status: 'CONFIRMED', note: 'phoned' }, { token: reception.token });
  await s.post(`/api/staff/registrations/${id}/checkin`, { method: 'SEARCH' }, { token: reception.token });

  const detail = await s.get(`/api/staff/registrations/${id}`, { token: reception.token });
  assert.deepEqual(detail.body.statusHistory.map((h) => h.toStatus),
    ['REGISTERED', 'CONFIRMED', 'CHECKED_IN']);
  assert.equal(detail.body.statusHistory[1].note, 'phoned');
  assert.equal(detail.body.statusHistory[2].changedByName, reception.user.fullName);
});

// ===========================================================================
// §XXIX — parking ticket endpoint
// ===========================================================================

test('§XXIX parking tickets are issued and returned per vehicle over the API', async (t) => {
  const s = await server(t, '2026-10-05');
  const reception = await s.login(...CREDS.ciiReception);
  const created = await s.post('/api/registrations', visitorPayload({ visitDate: '2026-10-05' }));
  const id = created.body.registrationId;

  const tooEarly = await s.post(`/api/staff/registrations/${id}/parking-tickets`,
    { vehicleType: 'CAR' }, { token: reception.token });
  assert.equal(tooEarly.status, 409);
  assert.equal(tooEarly.body.error.code, 'PARKING_TICKET_REQUIRES_CHECKIN');

  await s.post(`/api/staff/registrations/${id}/checkin`, { method: 'QR' }, { token: reception.token });

  const car = await s.post(`/api/staff/registrations/${id}/parking-tickets`,
    { vehicleType: 'CAR', ticketNumber: 'PX-42' }, { token: reception.token });
  assert.equal(car.status, 201);
  assert.equal(car.body.ticket.vehicleType, 'CAR');
  assert.equal(car.body.ticket.ticketNumber, 'PX-42');
  assert.equal(car.body.parking.byVehicleType.CAR.issued, 1);

  const moto = await s.post(`/api/staff/registrations/${id}/parking-tickets`,
    { vehicleType: 'motorbike' }, { token: reception.token });
  assert.equal(moto.status, 201, 'the vehicle type is case-insensitive');
  assert.equal(moto.body.parking.byVehicleType.MOTORBIKE.issued, 1);
  assert.equal(moto.body.parking.total, 2);

  const bad = await s.post(`/api/staff/registrations/${id}/parking-tickets`,
    { vehicleType: 'BOAT' }, { token: reception.token });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_VEHICLE_TYPE');

  const returned = await s.post(`/api/staff/parking-tickets/${car.body.ticket.id}/return`,
    {}, { token: reception.token });
  assert.equal(returned.status, 200);
  assert.ok(returned.body.ticket.returnedAt);
  assert.equal(returned.body.parking.byVehicleType.CAR.outstanding, 0);

  const listed = await s.get(`/api/staff/registrations/${id}/parking-tickets`, { token: reception.token });
  assert.equal(listed.body.total, 2);
  assert.equal(listed.body.outstanding, 1, 'the motorbike ticket is still out');

  const removed = await s.request('DELETE', `/api/staff/parking-tickets/${moto.body.ticket.id}`,
    { token: reception.token });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.parking.total, 1);
});

test('§XXIX the parking endpoints refuse Thuận Giao', async (t) => {
  const s = await server(t, '2026-10-06');
  const tg = await s.login(...CREDS.tgReception);
  const created = await s.post('/api/registrations', agencyPayload({ visitDate: '2026-10-06' }));
  await s.post(`/api/staff/registrations/${created.body.registrationId}/checkin`,
    { method: 'SEARCH' }, { token: tg.token });

  const res = await s.post(`/api/staff/registrations/${created.body.registrationId}/parking-tickets`,
    { vehicleType: 'CAR' }, { token: tg.token });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'PARKING_TICKET_NOT_APPLICABLE');
});

test('§XXV a receptionist cannot touch another office\'s parking tickets', async (t) => {
  const s = await server(t, '2026-10-05');
  const cii = await s.login(...CREDS.ciiReception);
  const tg = await s.login(...CREDS.tgReception);
  const created = await s.post('/api/registrations', visitorPayload({ visitDate: '2026-10-05' }));
  const id = created.body.registrationId;
  await s.post(`/api/staff/registrations/${id}/checkin`, { method: 'QR' }, { token: cii.token });
  const car = await s.post(`/api/staff/registrations/${id}/parking-tickets`,
    { vehicleType: 'CAR' }, { token: cii.token });

  assert.equal((await s.post(`/api/staff/registrations/${id}/parking-tickets`,
    { vehicleType: 'CAR' }, { token: tg.token })).status, 403);
  assert.equal((await s.post(`/api/staff/parking-tickets/${car.body.ticket.id}/return`,
    {}, { token: tg.token })).status, 403);
  assert.equal((await s.request('DELETE', `/api/staff/parking-tickets/${car.body.ticket.id}`,
    { token: tg.token })).status, 403);
});

// ===========================================================================
// §XXVIII — confirming how many guests actually arrived
// ===========================================================================

test('§XXVIII check-in records the confirmed arrival count', async (t) => {
  const s = await server(t, '2026-10-05');
  const reception = await s.login(...CREDS.ciiReception);
  const created = await s.post('/api/registrations',
    visitorPayload({ visitDate: '2026-10-05', numberOfVisitors: 4 }));

  const res = await s.post(`/api/staff/registrations/${created.body.registrationId}/checkin`,
    { method: 'QR', actualGuests: 3 }, { token: reception.token });

  assert.equal(res.status, 200);
  assert.equal(res.body.guests.expected, 4);
  assert.equal(res.body.guests.actual, 3);
  assert.equal(res.body.guests.variance, -1);
  assert.equal(res.body.guests.matches, false);
  assert.equal(res.body.checkin.expectedGuests, 4);
  assert.equal(res.body.checkin.actualGuests, 3);
  assert.match(res.body.checkin.notes, /Arrived 3 of 4 booked/);
  assert.match(res.body.registration.statusHistory.at(-1).note, /3\/4 guests \(-1\)/);
});

test('§XXVIII omitting the count accepts the booked number unchanged', async (t) => {
  const s = await server(t, '2026-10-05');
  const reception = await s.login(...CREDS.ciiReception);
  const created = await s.post('/api/registrations',
    visitorPayload({ visitDate: '2026-10-05', numberOfVisitors: 2 }));

  const res = await s.post(`/api/staff/registrations/${created.body.registrationId}/checkin`,
    { method: 'QR' }, { token: reception.token });
  assert.equal(res.body.guests.expected, 2);
  assert.equal(res.body.guests.actual, 2);
  assert.equal(res.body.guests.matches, true);
  assert.equal(res.body.guests.confirmed, false, 'recorded as unconfirmed, not as a verified count');
});

test('§XXVIII an impossible arrival count is refused', async (t) => {
  const s = await server(t, '2026-10-05');
  const reception = await s.login(...CREDS.ciiReception);
  const mk = async (cccd) => (await s.post('/api/registrations', visitorPayload({
    visitDate: '2026-10-05', numberOfVisitors: 3, cccd,
  }))).body.registrationId;

  const zero = await s.post(`/api/staff/registrations/${await mk('111111111111')}/checkin`,
    { actualGuests: 0 }, { token: reception.token });
  assert.equal(zero.status, 400);
  assert.equal(zero.body.error.code, 'GUEST_COUNT_TOO_LOW');

  // More than the slot can hold at all: the capacity limit answers first.
  const silly = await s.post(`/api/staff/registrations/${await mk('222222222222')}/checkin`,
    { actualGuests: 500 }, { token: reception.token });
  assert.equal(silly.status, 409);
  assert.equal(silly.body.error.code, 'SLOT_CAPACITY_EXCEEDED');

  // Within the slot's capacity but far above the booking: almost certainly a typo.
  const typo = await s.post(`/api/staff/registrations/${await mk('444444444444')}/checkin`,
    { actualGuests: 20 }, { token: reception.token });
  assert.equal(typo.status, 400);
  assert.equal(typo.body.error.code, 'GUEST_COUNT_TOO_HIGH');

  const fraction = await s.post(`/api/staff/registrations/${await mk('333333333333')}/checkin`,
    { actualGuests: 2.5 }, { token: reception.token });
  assert.equal(fraction.status, 400);
  assert.equal(fraction.body.error.code, 'INVALID_GUEST_COUNT');
});

test('§XXVIII a few extra guests are allowed and recorded', async (t) => {
  const s = await server(t, '2026-10-05');
  const reception = await s.login(...CREDS.ciiReception);
  const created = await s.post('/api/registrations',
    visitorPayload({ visitDate: '2026-10-05', numberOfVisitors: 2 }));

  const res = await s.post(`/api/staff/registrations/${created.body.registrationId}/checkin`,
    { actualGuests: 5 }, { token: reception.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.guests.variance, 3);
  assert.equal(res.body.registration.numberOfVisitors, 2,
    'the booking is history and is not rewritten');
});

test('§XXVIII the dashboard reports arrivals against bookings', async (t) => {
  const s = await server(t, '2026-10-05');
  const reception = await s.login(...CREDS.ciiReception);
  const manager = await s.login(...CREDS.manager);
  const a = await s.post('/api/registrations', visitorPayload({ visitDate: '2026-10-05', numberOfVisitors: 3, cccd: '111111111111' }));
  const b = await s.post('/api/registrations', visitorPayload({ visitDate: '2026-10-05', numberOfVisitors: 2, cccd: '222222222222', timeSlotId: SLOT_1030 }));
  await s.post(`/api/staff/registrations/${a.body.registrationId}/checkin`, { actualGuests: 2 }, { token: reception.token });
  // b is booked for 10:30 and arrives at 09:30 — early, so the desk confirms it.
  await s.post(`/api/staff/registrations/${b.body.registrationId}/checkin`,
    { actualGuests: 2, allowTimeOverride: true }, { token: reception.token });

  const d = await s.get('/api/staff/dashboard', { token: manager.token });
  assert.equal(d.body.guestAccuracy.checkins, 2);
  assert.equal(d.body.guestAccuracy.expectedGuests, 5);
  assert.equal(d.body.guestAccuracy.actualGuests, 4);
  assert.equal(d.body.guestAccuracy.variance, -1);
  assert.equal(d.body.guestAccuracy.arrivedWithFewer, 1);
  assert.equal(d.body.guestAccuracy.matched, 1);
});

// ===========================================================================
// §XXXVIII — registration management endpoint
// ===========================================================================

async function seedTwoOffices(s) {
  const a = await s.post('/api/registrations', visitorPayload({
    visitDate: '2026-10-05', cccd: '111111111111', fullName: 'Trần Thị Bích', phone: '0911111111',
  }));
  const b = await s.post('/api/registrations', visitorPayload({
    salesOfficeId: OFFICE_TG, visitDate: '2026-10-05', timeSlotId: SLOT_1030,
    cccd: '222222222222', fullName: 'Lê Văn Cường', phone: '0922222222',
  }));
  const c = await s.post('/api/registrations', agencyPayload({
    salesOfficeId: OFFICE_CII, visitDate: '2026-10-06', timeSlotId: SLOT_B,
  }));
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(c.status, 201);
  return { a: a.body, b: b.body, c: c.body };
}

test('§XXXVIII a manager sees every office; a receptionist sees only their own', async (t) => {
  const s = await server(t, '2026-10-05');
  await seedTwoOffices(s);

  const manager = await s.login(...CREDS.manager);
  const all = await s.get('/api/staff/registrations', { token: manager.token });
  assert.equal(all.body.total, 3);

  const cii = await s.login(...CREDS.ciiReception);
  const scoped = await s.get('/api/staff/registrations', { token: cii.token });
  assert.equal(scoped.body.total, 2);
  assert.ok(scoped.body.items.every((r) => r.salesOfficeId === OFFICE_CII));

  const tg = await s.login(...CREDS.tgReception);
  const tgList = await s.get('/api/staff/registrations', { token: tg.token });
  assert.equal(tgList.body.total, 1);
});

test('§XXV a receptionist cannot widen scope through the salesOfficeId query parameter', async (t) => {
  const s = await server(t, '2026-10-05');
  await seedTwoOffices(s);
  const cii = await s.login(...CREDS.ciiReception);
  const res = await s.get(`/api/staff/registrations?salesOfficeId=${OFFICE_TG}`, { token: cii.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 0, 'never returns the other office\'s data');
});

test('§XXXVIII the list supports search, filters, sorting and pagination over HTTP', async (t) => {
  const s = await server(t, '2026-10-05');
  const { a } = await seedTwoOffices(s);
  const manager = await s.login(...CREDS.manager);
  const q = (qs) => s.get(`/api/staff/registrations?${qs}`, { token: manager.token });

  assert.equal((await q(`search=${a.confirmationCode}`)).body.total, 1);
  assert.equal((await q('search=Bích')).body.total, 1);
  assert.equal((await q('search=0922222222')).body.total, 1);
  assert.equal((await q('visitorType=AGENCY')).body.total, 1);
  assert.equal((await q('status=REGISTERED')).body.total, 3);
  assert.equal((await q('dateFrom=2026-10-06')).body.total, 1);
  assert.equal((await q(`salesOfficeId=${OFFICE_TG}`)).body.total, 1);

  const sorted = await q('sortBy=visit_date&sortDir=desc');
  assert.deepEqual(sorted.body.items.map((r) => r.visitDate), ['2026-10-06', '2026-10-05', '2026-10-05']);

  const paged = await q('pageSize=2&page=2');
  assert.equal(paged.body.page, 2);
  assert.equal(paged.body.totalPages, 2);
  assert.equal(paged.body.items.length, 1);
});

test('§XXXVIII the list never leaks the QR token', async (t) => {
  const s = await server(t, '2026-10-05');
  await seedTwoOffices(s);
  const manager = await s.login(...CREDS.manager);
  const res = await s.get('/api/staff/registrations', { token: manager.token });
  assert.equal(JSON.stringify(res.body).includes('qrToken'), false);
});

test('§XXXVIII a registration detail includes office, slot, history and parking applicability', async (t) => {
  const s = await server(t, '2026-10-05');
  const { a } = await seedTwoOffices(s);
  const cii = await s.login(...CREDS.ciiReception);
  const res = await s.get(`/api/staff/registrations/${a.registrationId}`, { token: cii.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.salesOffice.name, 'CII - Bình Thạnh');
  assert.ok(res.body.timeSlot.label);
  assert.equal(res.body.statusHistory.length, 1);
  assert.equal(res.body.parkingTicketApplicable, true);
  assert.equal((await s.get('/api/staff/registrations/nope', { token: cii.token })).status, 404);
});

// ===========================================================================
// §XXX–§XXXIV — dashboard endpoint
// ===========================================================================

test('§XXX the dashboard endpoint returns every section plus the refresh interval', async (t) => {
  const s = await server(t, '2026-10-05');
  await seedTwoOffices(s);
  const manager = await s.login(...CREDS.manager);
  const res = await s.get('/api/staff/dashboard', { token: manager.token });

  assert.equal(res.status, 200);
  assert.equal(res.body.refreshIntervalMs, 60000, '§XXXVII');
  assert.equal(res.body.kpis.totalRegistration, 3);
  assert.equal(res.body.byOffice.length, 2);
  assert.ok(res.body.byVisitorType.VISITOR);
  assert.ok(res.body.periods.day && res.body.periods.week && res.body.periods.month);
  assert.equal(res.body.funnel.stages.length, 6);
  assert.equal(res.body.byTimeSlot.length, 4);
  assert.equal(res.body.parkingTickets.length, 1, 'CII only');
});

test('§XXXIX a receptionist cannot open the dashboard endpoint', async (t) => {
  const s = await server(t, '2026-10-05');
  const cii = await s.login(...CREDS.ciiReception);
  assert.equal((await s.get('/api/staff/dashboard', { token: cii.token })).status, 403);
});

test('§XXX a receptionist gets their own desk summary instead', async (t) => {
  const s = await server(t, '2026-10-05');
  await seedTwoOffices(s);
  const cii = await s.login(...CREDS.ciiReception);
  const res = await s.get('/api/staff/office-summary', { token: cii.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.salesOfficeId, OFFICE_CII);
  assert.equal(res.body.kpis.todaysVisitors, 1, 'only the CII booking dated today');
  assert.equal(res.body.parkingTickets.length, 1);
  assert.equal(res.body.refreshIntervalMs, 60000);
});

test('§XXXI the dashboard honours the office and visitor-type filters', async (t) => {
  const s = await server(t, '2026-10-05');
  await seedTwoOffices(s);
  const manager = await s.login(...CREDS.manager);
  const cii = await s.get(`/api/staff/dashboard?salesOfficeId=${OFFICE_CII}`, { token: manager.token });
  assert.equal(cii.body.kpis.totalRegistration, 2);
  const agency = await s.get('/api/staff/dashboard?visitorType=AGENCY', { token: manager.token });
  assert.equal(agency.body.kpis.totalRegistration, 1);
});

test('§Rule 8 dashboard numbers move when a check-in happens', async (t) => {
  const s = await server(t, '2026-10-05');
  const { a } = await seedTwoOffices(s);
  const manager = await s.login(...CREDS.manager);
  const cii = await s.login(...CREDS.ciiReception);

  const before = await s.get('/api/staff/dashboard', { token: manager.token });
  assert.equal(before.body.kpis.checkedIn, 0);

  await s.post(`/api/staff/registrations/${a.registrationId}/checkin`, { method: 'QR' }, { token: cii.token });

  const after = await s.get('/api/staff/dashboard', { token: manager.token });
  assert.equal(after.body.kpis.checkedIn, 1, 'no stale or duplicated dashboard data');
  assert.equal(after.body.funnel.arrived, 1);
});

// ===========================================================================
// §XXXV–§XXXVI — calendar endpoint
// ===========================================================================

test('§XXXV the calendar endpoint returns grouped days linked to registrations', async (t) => {
  const s = await server(t, '2026-10-05');
  const { a } = await seedTwoOffices(s);
  const manager = await s.login(...CREDS.manager);

  const day = await s.get('/api/staff/calendar?view=day&date=2026-10-05', { token: manager.token });
  assert.equal(day.status, 200);
  assert.equal(day.body.refreshIntervalMs, 60000);
  assert.equal(day.body.days.length, 1);
  assert.equal(day.body.count, 2);
  const ev = day.body.events.find((e) => e.confirmationCode === a.confirmationCode);
  assert.equal(ev.registrationId, a.registrationId, '§XXXVI click-through target');
  assert.equal(ev.status, 'REGISTERED');

  const month = await s.get('/api/staff/calendar?view=month&date=2026-10-05', { token: manager.token });
  assert.equal(month.body.days.length, 31);
  assert.equal(month.body.count, 3);

  const bad = await s.get('/api/staff/calendar?view=century', { token: manager.token });
  assert.equal(bad.status, 400);
});

test('§XXV the calendar is office-scoped for a receptionist', async (t) => {
  const s = await server(t, '2026-10-05');
  await seedTwoOffices(s);
  const tg = await s.login(...CREDS.tgReception);
  const res = await s.get('/api/staff/calendar?view=month&date=2026-10-05', { token: tg.token });
  assert.equal(res.body.count, 1);
  assert.equal(res.body.events[0].salesOfficeName, 'Thuận Giao - Bình Dương');
});

// ===========================================================================
// §XXXIX — admin endpoints
// ===========================================================================

test('§XXXIX only an administrator may manage users, agencies and time slots', async (t) => {
  const s = await server(t);
  const manager = await s.login(...CREDS.manager);
  const reception = await s.login(...CREDS.ciiReception);
  for (const token of [manager.token, reception.token]) {
    assert.equal((await s.get('/api/admin/users', { token })).status, 403);
    assert.equal((await s.post('/api/admin/agencies', { id: 'X', name: 'X' }, { token })).status, 403);
    assert.equal((await s.patch(`/api/admin/time-slots/${SLOT_A}`, { capacity: 1 }, { token })).status, 403);
  }
});

test('§XXXIX an administrator can add an agency and it becomes bookable', async (t) => {
  const s = await server(t);
  const admin = await s.login(...CREDS.admin);
  const created = await s.post('/api/admin/agencies',
    { id: 'AG_NEW', name: 'Agency Mới' }, { token: admin.token });
  assert.equal(created.status, 200);

  const config = await s.get('/api/config');
  assert.ok(config.body.agencies.some((a) => a.id === 'AG_NEW'), '§XI list comes from master data');

  const reg = await s.post('/api/registrations', agencyPayload({ agencyId: 'AG_NEW' }));
  assert.equal(reg.status, 201);
  assert.equal(reg.body.summary.displayName, 'Agency Mới');
});

test('§XXXIX deactivating an agency removes it from the bookable list', async (t) => {
  const s = await server(t);
  const admin = await s.login(...CREDS.admin);
  await s.post('/api/admin/agencies', { id: 'AG_IQI', name: 'IQI', active: false }, { token: admin.token });
  const config = await s.get('/api/config');
  assert.equal(config.body.agencies.some((a) => a.id === 'AG_IQI'), false);
  const reg = await s.post('/api/registrations', agencyPayload({ agencyId: 'AG_IQI' }));
  assert.equal(reg.status, 400);
  assert.equal(reg.body.error.details[0].code, 'INVALID_AGENCY');
});

test('§XXXIX an administrator can create a receptionist who can then sign in', async (t) => {
  const s = await server(t);
  const admin = await s.login(...CREDS.admin);
  const created = await s.post('/api/admin/users', {
    username: 'cii.reception04', fullName: 'Desk Four', role: 'RECEPTIONIST',
    salesOfficeId: OFFICE_CII, password: 'Desk@1234',
  }, { token: admin.token });
  assert.equal(created.status, 201);
  const login = await s.login('cii.reception04', 'Desk@1234');
  assert.equal(login.user.salesOfficeId, OFFICE_CII);

  const bad = await s.post('/api/admin/users', {
    username: 'x', fullName: 'X', role: 'RECEPTIONIST', password: 'p',
  }, { token: admin.token });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'OFFICE_REQUIRED');
});

test('§XXXIX an administrator can adjust slot capacity, changing availability', async (t) => {
  const s = await server(t);
  const admin = await s.login(...CREDS.admin);
  const res = await s.patch(`/api/admin/time-slots/${SLOT_A}`, { capacity: 7 }, { token: admin.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.capacity, 7);
  const avail = await s.get(`/api/availability?salesOfficeId=${OFFICE_CII}&visitDate=2026-10-05`);
  assert.equal(avail.body.slots.find((x) => x.slotId === SLOT_A).capacity, 7);
  assert.equal((await s.patch('/api/admin/time-slots/NOPE', { capacity: 1 }, { token: admin.token })).status, 404);
});

// ===========================================================================
// §XXXIX Sales — creating an agency registration while authenticated
// ===========================================================================

test('§XXXIX a sales user\'s agency registration is attributed to them in the history', async (t) => {
  const s = await server(t);
  const sales = await s.login(...CREDS.ciiSales);
  const created = await s.post('/api/registrations', agencyPayload(), { token: sales.token });
  assert.equal(created.status, 201);

  const manager = await s.login(...CREDS.manager);
  const detail = await s.get(`/api/staff/registrations/${created.body.registrationId}`, { token: manager.token });
  assert.equal(detail.body.statusHistory[0].changedByName, sales.user.fullName);
});

test('an anonymous self-registration is attributed to the visitor', async (t) => {
  const s = await server(t);
  const created = await s.post('/api/registrations', visitorPayload());
  const manager = await s.login(...CREDS.manager);
  const detail = await s.get(`/api/staff/registrations/${created.body.registrationId}`, { token: manager.token });
  assert.equal(detail.body.statusHistory[0].changedBy, 'VISITOR');
});

// ===========================================================================
// static assets
// ===========================================================================

test('the registration wizard and staff pages are served', async (t) => {
  const s = await server(t);
  for (const path of ['/', '/index.html', '/staff.html', '/css/app.css', '/js/register.js', '/js/staff.js', '/js/i18n.js']) {
    const res = await s.request('GET', path, { raw: true });
    assert.equal(res.status, 200, path);
  }
});
