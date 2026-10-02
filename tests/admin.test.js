'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startServer, visitorPayload, CREDS, OFFICE_CII, OFFICE_TG, SLOT_A, SLOT_B,
} = require('./helpers');
const { MATRIX, P, can } = require('../src/domain/permissions');
const { ROLES } = require('../src/config/master-data');

const A = (t) => ({ token: t });

// ===========================================================================
// The Administrator role
// ===========================================================================

test('the administrator manages accounts and the calendar, and nothing else', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const admin = await server.login(...CREDS.admin);

  await t.test('the session advertises only those permissions', () => {
    assert.deepEqual(admin.permissions.sort(), [
      P.AUDIT_VIEW, P.CALENDAR_VIEW, P.MASTER_DATA_MANAGE, P.SCHEDULE_BLOCK, P.USER_MANAGE,
    ].sort());
  });

  await t.test('the screens an administrator should not have are refused', async () => {
    for (const path of [
      '/api/staff/registrations',
      '/api/staff/registrations/export.xlsx',
      '/api/staff/dashboard',
      '/api/staff/customer-stats',
      '/api/staff/customer-stats/export.xlsx',
      '/api/staff/office-summary',
    ]) {
      const res = await server.get(path, A(admin.token));
      assert.equal(res.status, 403, `${path} should be refused`);
    }
  });

  await t.test('check-in and status changes are refused too', async () => {
    const created = await server.post('/api/registrations', visitorPayload());
    assert.equal(created.status, 201);
    const id = created.body.registrationId;
    for (const [path, body] of [
      [`/api/staff/registrations/${id}/checkin`, { method: 'SEARCH' }],
      [`/api/staff/registrations/${id}/status`, { status: 'CANCELLED' }],
      [`/api/staff/registrations/${id}/parking-tickets`, { vehicleType: 'CAR' }],
    ]) {
      const res = await server.post(path, body, A(admin.token));
      assert.equal(res.status, 403, `${path} should be refused`);
    }
    // And the search box the desk uses is closed to the administrator as well,
    // because it returns the visitor's name, phone and ID number.
    const lookup = await server.post('/api/staff/checkin/lookup',
      { query: created.body.confirmationCode }, A(admin.token));
    assert.equal(lookup.status, 403);
  });

  await t.test('what an administrator does have, works', async () => {
    assert.equal((await server.get('/api/admin/users', A(admin.token))).status, 200);
    assert.equal((await server.get('/api/staff/calendar', A(admin.token))).status, 200);
    assert.equal((await server.get('/api/admin/blocked-periods', A(admin.token))).status, 200);
  });

  await t.test('no other role may manage accounts or close the calendar', async () => {
    for (const creds of [CREDS.ciiReception, CREDS.ciiSales, CREDS.manager]) {
      const s = await server.login(...creds);
      assert.equal((await server.get('/api/admin/users', A(s.token))).status, 403);
      assert.equal((await server.get('/api/admin/blocked-periods', A(s.token))).status, 403);
    }
    assert.deepEqual(
      Object.keys(MATRIX).filter((role) => can({ role }, P.USER_MANAGE)), [ROLES.ADMINISTRATOR]);
    assert.deepEqual(
      Object.keys(MATRIX).filter((role) => can({ role }, P.SCHEDULE_BLOCK)), [ROLES.ADMINISTRATOR]);
  });
});

// ===========================================================================
// Account management
// ===========================================================================

test('an administrator has full control of staff accounts', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const admin = await server.login(...CREDS.admin);

  const created = await server.post('/api/admin/users', {
    username: 'CII.Reception99', fullName: 'Lễ tân mới', role: 'RECEPTIONIST',
    salesOfficeId: OFFICE_CII, password: 'FirstPass@1',
  }, A(admin.token));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.username, 'cii.reception99', 'usernames are normalised');
  const id = created.body.id;

  await t.test('the new account can sign in', async () => {
    const s = await server.login('cii.reception99', 'FirstPass@1');
    assert.equal(s.user.role, 'RECEPTIONIST');
  });

  await t.test('a duplicate username is refused clearly, not as a server error', async () => {
    const res = await server.post('/api/admin/users', {
      username: 'MANAGER01', fullName: 'Trùng tên', role: 'MANAGER', password: 'Another@1',
    }, A(admin.token));
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'USERNAME_TAKEN');
    assert.match(res.body.error.message, /manager01/, 'the message names the clash');
  });

  await t.test('a weak password is refused at creation', async () => {
    const res = await server.post('/api/admin/users', {
      username: 'cii.weak01', fullName: 'Mật khẩu yếu', role: 'RECEPTIONIST',
      salesOfficeId: OFFICE_CII, password: 'abc',
    }, A(admin.token));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'WEAK_PASSWORD');
    const list = await server.get('/api/admin/users', A(admin.token));
    assert.equal(list.body.items.some((u) => u.username === 'cii.weak01'), false,
      'nothing is written when the password is refused');
  });

  await t.test('editing changes name, username, role and office together', async () => {
    const res = await server.request('PATCH', `/api/admin/users/${id}`, {
      body: { fullName: 'Lễ tân đã đổi tên', username: 'cii.reception98' },
      token: admin.token,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.fullName, 'Lễ tân đã đổi tên');
    assert.equal(res.body.username, 'cii.reception98');
    // The old username is gone, the new one works.
    await assert.rejects(() => server.login('cii.reception99', 'FirstPass@1'));
    assert.equal((await server.login('cii.reception98', 'FirstPass@1')).user.id, id);
  });

  await t.test('promoting to manager clears the office it no longer needs', async () => {
    const res = await server.request('PATCH', `/api/admin/users/${id}`,
      { body: { role: 'MANAGER' }, token: admin.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.role, 'MANAGER');
    assert.equal(res.body.salesOfficeId, null, 'a manager is not pinned to a desk');
    // Put it back for the remaining checks.
    await server.request('PATCH', `/api/admin/users/${id}`,
      { body: { role: 'RECEPTIONIST', salesOfficeId: OFFICE_TG }, token: admin.token });
  });

  await t.test('a desk role cannot be left without an office', async () => {
    const res = await server.request('PATCH', `/api/admin/users/${id}`,
      { body: { role: 'RECEPTIONIST', salesOfficeId: null }, token: admin.token });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'OFFICE_REQUIRED');
  });

  await t.test('a username already in use is refused', async () => {
    const res = await server.request('PATCH', `/api/admin/users/${id}`,
      { body: { username: 'manager01' }, token: admin.token });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'USERNAME_TAKEN');
  });

  await t.test('the administrator resets a password without knowing the old one', async () => {
    const res = await server.post(`/api/admin/users/${id}/password`,
      { password: 'ResetPass@2' }, A(admin.token));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assert.rejects(() => server.login('cii.reception98', 'FirstPass@1'));
    assert.equal((await server.login('cii.reception98', 'ResetPass@2')).user.id, id);
  });

  await t.test('a weak password is refused, at creation and at reset', async () => {
    const short = await server.post(`/api/admin/users/${id}/password`,
      { password: 'abc' }, A(admin.token));
    assert.equal(short.status, 400);
    assert.equal(short.body.error.code, 'WEAK_PASSWORD');
    assert.equal((await server.login('cii.reception98', 'ResetPass@2')).user.id, id,
      'the old password still works after a refused reset');
  });

  await t.test('a user changes their own password, proving the current one', async () => {
    const session = await server.login('cii.reception98', 'ResetPass@2');
    const wrong = await server.post('/api/auth/password',
      { currentPassword: 'nope', newPassword: 'OwnPass@3' }, A(session.token));
    assert.equal(wrong.status, 401);

    const same = await server.post('/api/auth/password',
      { currentPassword: 'ResetPass@2', newPassword: 'ResetPass@2' }, A(session.token));
    assert.equal(same.status, 400);
    assert.equal(same.body.error.code, 'PASSWORD_UNCHANGED');

    const ok = await server.post('/api/auth/password',
      { currentPassword: 'ResetPass@2', newPassword: 'OwnPass@3' }, A(session.token));
    assert.equal(ok.status, 200);
    assert.equal((await server.login('cii.reception98', 'OwnPass@3')).user.id, id);
  });

  await t.test('deactivating stops the sign-in; reactivating restores it', async () => {
    const off = await server.post(`/api/admin/users/${id}/active`, { active: false }, A(admin.token));
    assert.equal(off.status, 200);
    assert.equal(off.body.active, false);
    await assert.rejects(() => server.login('cii.reception98', 'OwnPass@3'));

    const on = await server.post(`/api/admin/users/${id}/active`, { active: true }, A(admin.token));
    assert.equal(on.body.active, true);
    assert.equal((await server.login('cii.reception98', 'OwnPass@3')).user.id, id);
  });

  await t.test('an account with no history is deleted outright', async () => {
    const res = await server.request('DELETE', `/api/admin/users/${id}`, { token: admin.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.deleted, true);
    const list = await server.get('/api/admin/users', A(admin.token));
    assert.equal(list.body.items.some((u) => u.id === id), false);
    await assert.rejects(() => server.login('cii.reception98', 'OwnPass@3'));
  });
});

test('account deletion never rewrites who received a visitor', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  // A receptionist checks a visitor in, which records them against the check-in.
  const created = await server.post('/api/registrations', visitorPayload({ visitDate: '2026-10-01' }));
  const reception = await server.login(...CREDS.ciiReception);
  const checkin = await server.post(`/api/staff/registrations/${created.body.registrationId}/checkin`,
    { method: 'SEARCH' }, A(reception.token));
  assert.equal(checkin.status, 200, JSON.stringify(checkin.body));

  const admin = await server.login(...CREDS.admin);
  const users = await server.get('/api/admin/users', A(admin.token));
  const desk = users.body.items.find((u) => u.username === 'cii.reception01');

  const res = await server.request('DELETE', `/api/admin/users/${desk.id}`, { token: admin.token });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'USER_HAS_HISTORY');
  assert.match(res.body.error.message, /Deactivate it instead/);

  // Deactivating is the supported route and leaves the record intact.
  const off = await server.post(`/api/admin/users/${desk.id}/active`, { active: false }, A(admin.token));
  assert.equal(off.status, 200);
});

test('the system can never be left without an administrator', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const admin = await server.login(...CREDS.admin);
  const me = admin.user.id;

  await t.test('the only administrator cannot deactivate themselves', async () => {
    const res = await server.post(`/api/admin/users/${me}/active`, { active: false }, A(admin.token));
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'LAST_ADMINISTRATOR');
  });

  await t.test('nor demote themselves to another role', async () => {
    const res = await server.request('PATCH', `/api/admin/users/${me}`,
      { body: { role: 'MANAGER' }, token: admin.token });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'LAST_ADMINISTRATOR');
  });

  await t.test('nor delete the account they are signed in with', async () => {
    const res = await server.request('DELETE', `/api/admin/users/${me}`, { token: admin.token });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'CANNOT_DELETE_SELF');
  });

  await t.test('with a second administrator, the first may step down', async () => {
    const second = await server.post('/api/admin/users', {
      username: 'admin2', fullName: 'Quản trị 2', role: 'ADMINISTRATOR', password: 'Admin2@Pass',
    }, A(admin.token));
    assert.equal(second.status, 201);
    const res = await server.post(`/api/admin/users/${me}/active`, { active: false }, A(admin.token));
    assert.equal(res.status, 200);
    assert.equal(res.body.active, false);
  });
});

// ===========================================================================
// Blocked periods
// ===========================================================================

test('an administrator closes the calendar and visitors cannot book it', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const admin = await server.login(...CREDS.admin);

  const block = await server.post('/api/admin/blocked-periods',
    { startDate: '2026-10-05', reason: 'Bảo trì nhà mẫu' }, A(admin.token));
  assert.equal(block.status, 201, JSON.stringify(block.body));
  assert.equal(block.body.endDate, '2026-10-05', 'one day is a range that starts and ends the same day');
  assert.equal(block.body.salesOfficeId, null, 'no office means every office');
  assert.equal(block.body.timeSlotId, null, 'no slot means the whole day');

  await t.test('the booking is refused by the backend, not merely hidden', async () => {
    const res = await server.post('/api/registrations',
      visitorPayload({ visitDate: '2026-10-05', timeSlotId: SLOT_A }));
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'PERIOD_BLOCKED');
    assert.match(res.body.error.message, /Bảo trì nhà mẫu/, 'the reason reaches the visitor');
  });

  await t.test('availability reports every slot closed, with no places left', async () => {
    const res = await server.get(`/api/availability?salesOfficeId=${OFFICE_CII}&visitDate=2026-10-05`);
    assert.equal(res.status, 200);
    for (const slot of res.body.slots) {
      assert.equal(slot.blocked, true, slot.slotId);
      assert.equal(slot.remaining, 0, 'a closed slot offers no places');
      assert.equal(slot.fullyBooked, true);
      assert.equal(slot.blockReason, 'Bảo trì nhà mẫu');
    }
  });

  await t.test('other days are untouched', async () => {
    const res = await server.post('/api/registrations',
      visitorPayload({ visitDate: '2026-10-06', timeSlotId: SLOT_A }));
    assert.equal(res.status, 201);
  });

  await t.test('the calendar marks the day and says why', async () => {
    const cal = await server.get('/api/staff/calendar?view=month&date=2026-10-05', A(admin.token));
    assert.equal(cal.status, 200);
    const day = cal.body.days.find((d) => d.date === '2026-10-05');
    assert.equal(day.fullyBlocked, true);
    assert.equal(day.blocks[0].reason, 'Bảo trì nhà mẫu');
    const open = cal.body.days.find((d) => d.date === '2026-10-06');
    assert.equal(open.fullyBlocked, false);
    assert.deepEqual(open.blocks, []);
  });

  await t.test('removing the block reopens the day', async () => {
    const res = await server.request('DELETE', `/api/admin/blocked-periods/${block.body.id}`,
      { token: admin.token });
    assert.equal(res.status, 200);
    const booked = await server.post('/api/registrations',
      visitorPayload({ visitDate: '2026-10-05', timeSlotId: SLOT_A }));
    assert.equal(booked.status, 201);
  });
});

test('a block can be narrowed to one office, one slot or a range of days', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const admin = await server.login(...CREDS.admin);

  await t.test('one slot at one office closes only that slot there', async () => {
    const res = await server.post('/api/admin/blocked-periods', {
      startDate: '2026-10-07', salesOfficeId: OFFICE_CII, timeSlotId: SLOT_A, reason: 'Sự kiện riêng',
    }, A(admin.token));
    assert.equal(res.status, 201);

    const blocked = await server.post('/api/registrations',
      visitorPayload({ visitDate: '2026-10-07', timeSlotId: SLOT_A }));
    assert.equal(blocked.status, 409, 'that slot at that office is closed');

    const otherSlot = await server.post('/api/registrations',
      visitorPayload({ visitDate: '2026-10-07', timeSlotId: SLOT_B }));
    assert.equal(otherSlot.status, 201, 'the rest of the day is open');

    const otherOffice = await server.post('/api/registrations', visitorPayload({
      salesOfficeId: OFFICE_TG, visitDate: '2026-10-07', timeSlotId: SLOT_A,
      cccd: '111122223333', phone: '0912000111',
    }));
    assert.equal(otherOffice.status, 201, 'the other office is open');
  });

  await t.test('a range closes every day between the ends, inclusive', async () => {
    const res = await server.post('/api/admin/blocked-periods',
      { startDate: '2026-10-08', endDate: '2026-10-10', reason: 'Nghỉ lễ' }, A(admin.token));
    assert.equal(res.status, 201);
    for (const date of ['2026-10-08', '2026-10-09', '2026-10-10']) {
      const booked = await server.post('/api/registrations',
        visitorPayload({ visitDate: date, timeSlotId: SLOT_A }));
      assert.equal(booked.status, 409, `${date} should be closed`);
    }
    const after = await server.post('/api/registrations',
      visitorPayload({ visitDate: '2026-10-11', timeSlotId: SLOT_A }));
    assert.equal(after.status, 201, 'the day after the range is open');
  });

  await t.test('an end date before the start is refused', async () => {
    const res = await server.post('/api/admin/blocked-periods',
      { startDate: '2026-10-09', endDate: '2026-10-08' }, A(admin.token));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_RANGE');
  });

  await t.test('an unknown office or slot is refused', async () => {
    assert.equal((await server.post('/api/admin/blocked-periods',
      { startDate: '2026-10-09', salesOfficeId: 'NOWHERE' }, A(admin.token))).status, 404);
    assert.equal((await server.post('/api/admin/blocked-periods',
      { startDate: '2026-10-09', timeSlotId: 'SLOT_NEVER' }, A(admin.token))).status, 404);
  });
});

test('closing a period reports the bookings already inside it rather than cancelling them', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  // Two visitors book before the day is closed.
  for (const cccd of ['079000000001', '079000000002']) {
    const res = await server.post('/api/registrations',
      visitorPayload({ visitDate: '2026-10-09', timeSlotId: SLOT_A, cccd, phone: `090000${cccd.slice(-4)}` }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  const admin = await server.login(...CREDS.admin);
  const block = await server.post('/api/admin/blocked-periods',
    { startDate: '2026-10-09', reason: 'Đóng đột xuất' }, A(admin.token));
  assert.equal(block.status, 201);
  assert.equal(block.body.affectedRegistrations, 2,
    'the administrator is told how many visitors are affected');

  // Those registrations are untouched: cancelling someone's visit is a decision
  // about a real person, not a side effect of closing a day.
  const manager = await server.login(...CREDS.manager);
  const list = await server.get('/api/staff/registrations?dateFrom=2026-10-09&dateTo=2026-10-09',
    A(manager.token));
  assert.equal(list.body.total, 2);
  for (const reg of list.body.items) assert.equal(reg.status, 'REGISTERED');
});

// ===========================================================================
// Slot capacity
// ===========================================================================

test('an administrator sets the capacity of each time slot', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const admin = await server.login(...CREDS.admin);

  await t.test('every slot is listed, including ones taken out of service', async () => {
    const res = await server.get('/api/admin/time-slots', A(admin.token));
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 4);
  });

  await t.test('a new capacity takes effect for visitors immediately', async () => {
    const res = await server.request('PATCH', `/api/admin/time-slots/${SLOT_A}`,
      { body: { capacity: 12 }, token: admin.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.capacity, 12);
    assert.equal(res.body.previousCapacity, 30);

    const av = await server.get(`/api/availability?salesOfficeId=${OFFICE_CII}&visitDate=2026-10-06`);
    const slot = av.body.slots.find((x) => x.slotId === SLOT_A);
    assert.equal(slot.capacity, 12);
    assert.equal(slot.remaining, 12);
  });

  await t.test('a party larger than the new capacity is turned away', async () => {
    const res = await server.post('/api/registrations',
      visitorPayload({ visitDate: '2026-10-06', timeSlotId: SLOT_A, numberOfVisitors: 13 }));
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'TIME_SLOT_INSUFFICIENT_CAPACITY');
  });

  await t.test('nonsense capacity is refused', async () => {
    for (const capacity of [0, -5, 2.5, 500, 'many']) {
      const res = await server.request('PATCH', `/api/admin/time-slots/${SLOT_A}`,
        { body: { capacity }, token: admin.token });
      assert.equal(res.status, 400, `capacity ${capacity} should be refused`);
      assert.equal(res.body.error.code, 'INVALID_CAPACITY');
    }
    // And the slot still holds the last good value.
    const slots = await server.get('/api/admin/time-slots', A(admin.token));
    assert.equal(slots.body.items.find((x) => x.id === SLOT_A).capacity, 12);
  });

  await t.test('lowering capacity below what is booked reports the dates, and cancels nobody', async () => {
    const booked = await server.post('/api/registrations',
      visitorPayload({ visitDate: '2026-10-07', timeSlotId: SLOT_A, numberOfVisitors: 10 }));
    assert.equal(booked.status, 201, JSON.stringify(booked.body));

    const res = await server.request('PATCH', `/api/admin/time-slots/${SLOT_A}`,
      { body: { capacity: 4 }, token: admin.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.overbookedDates.length, 1);
    assert.deepEqual(res.body.overbookedDates[0],
      { date: '2026-10-07', salesOfficeId: OFFICE_CII, booked: 10, capacity: 4 });

    // The visitors who were already told to come are still coming.
    const manager = await server.login(...CREDS.manager);
    const list = await server.get('/api/staff/registrations?dateFrom=2026-10-07&dateTo=2026-10-07',
      A(manager.token));
    assert.equal(list.body.total, 1);
    assert.equal(list.body.items[0].status, 'REGISTERED');
  });

  await t.test('a slot taken out of service disappears for visitors but not for the administrator', async () => {
    const off = await server.request('PATCH', `/api/admin/time-slots/${SLOT_B}`,
      { body: { active: false }, token: admin.token });
    assert.equal(off.status, 200);
    assert.equal(off.body.active, false);

    const cfg = await server.get('/api/config');
    assert.equal(cfg.body.timeSlots.some((x) => x.id === SLOT_B), false, 'hidden from the booking form');

    const admins = await server.get('/api/admin/time-slots', A(admin.token));
    assert.equal(admins.body.items.some((x) => x.id === SLOT_B), true,
      'still listed for the administrator, or it could never be switched back on');

    const back = await server.request('PATCH', `/api/admin/time-slots/${SLOT_B}`,
      { body: { active: true }, token: admin.token });
    assert.equal(back.body.active, true);
  });

  await t.test('no other role may change capacity', async () => {
    for (const creds of [CREDS.ciiReception, CREDS.manager, CREDS.ciiSales]) {
      const s = await server.login(...creds);
      const res = await server.request('PATCH', `/api/admin/time-slots/${SLOT_A}`,
        { body: { capacity: 99 }, token: s.token });
      assert.equal(res.status, 403);
    }
  });
});

// ===========================================================================
// The audit log
// ===========================================================================

test('every administrative change is written to the audit log', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const admin = await server.login(...CREDS.admin);

  const made = await server.post('/api/admin/users', {
    username: 'log.target', fullName: 'Mục tiêu', role: 'MANAGER', password: 'Logged@123',
  }, A(admin.token));
  assert.equal(made.status, 201);
  const id = made.body.id;

  await server.request('PATCH', `/api/admin/users/${id}`,
    { body: { fullName: 'Đã đổi tên' }, token: admin.token });
  await server.post(`/api/admin/users/${id}/password`, { password: 'Logged@456' }, A(admin.token));
  await server.post(`/api/admin/users/${id}/active`, { active: false }, A(admin.token));
  await server.post(`/api/admin/users/${id}/active`, { active: true }, A(admin.token));
  await server.request('PATCH', `/api/admin/time-slots/${SLOT_A}`,
    { body: { capacity: 20 }, token: admin.token });
  const block = await server.post('/api/admin/blocked-periods',
    { startDate: '2026-10-05', reason: 'Nghỉ lễ' }, A(admin.token));
  await server.request('DELETE', `/api/admin/blocked-periods/${block.body.id}`, { token: admin.token });
  await server.request('DELETE', `/api/admin/users/${id}`, { token: admin.token });

  const log = await server.get('/api/admin/audit-log', A(admin.token));
  assert.equal(log.status, 200);
  const actions = log.body.items.map((e) => e.action);

  await t.test('each kind of change is recorded', () => {
    for (const expected of ['USER_CREATED', 'USER_UPDATED', 'USER_PASSWORD_RESET',
      'USER_DEACTIVATED', 'USER_ACTIVATED', 'SLOT_CAPACITY_CHANGED',
      'PERIOD_BLOCKED', 'PERIOD_UNBLOCKED', 'USER_DELETED']) {
      assert.ok(actions.includes(expected), `${expected} is missing from the log`);
    }
  });

  await t.test('newest first, and in the order the changes actually happened', () => {
    // The suite pins the clock, so several entries share a timestamp — the order
    // has to come from the sequence, not from the time.
    assert.equal(actions[0], 'USER_DELETED', 'the last change is at the top');
    assert.equal(actions[actions.length - 1], 'USER_CREATED', 'the first is at the bottom');
    const seqs = log.body.items.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => b - a), 'strictly descending');
  });

  await t.test('every entry names a person, a time and what changed', () => {
    for (const e of log.body.items) {
      assert.ok(e.actorName && e.actorRole && e.at && e.summary, JSON.stringify(e));
      assert.equal(e.actorName, 'System Administrator');
      assert.equal(e.actorRole, 'ADMINISTRATOR');
    }
  });

  await t.test('a password never reaches the log', () => {
    const dump = JSON.stringify(log.body);
    assert.equal(dump.includes('Logged@123'), false);
    assert.equal(dump.includes('Logged@456'), false);
    assert.equal(/password_hash|passwordHash|password_salt/.test(dump), false);
    const reset = log.body.items.find((e) => e.action === 'USER_PASSWORD_RESET');
    assert.match(reset.summary, /Đặt lại mật khẩu cho log\.target/);
  });

  await t.test('an edit records what moved, and nothing else', () => {
    const edit = log.body.items.find((e) => e.action === 'USER_UPDATED');
    assert.deepEqual(Object.keys(edit.details), ['fullName']);
    assert.deepEqual(edit.details.fullName, { from: 'Mục tiêu', to: 'Đã đổi tên' });
  });

  await t.test('a capacity change records both figures', () => {
    const cap = log.body.items.find((e) => e.action === 'SLOT_CAPACITY_CHANGED');
    assert.deepEqual(cap.details.capacity, { from: 30, to: 20 });
    assert.match(cap.summary, /30 → 20/);
  });

  await t.test('the log can be filtered, and says which actions exist', async () => {
    assert.ok(log.body.availableActions.includes('USER_CREATED'));
    const only = await server.get('/api/admin/audit-log?action=USER_CREATED', A(admin.token));
    assert.equal(only.body.total, 1);
    assert.equal(only.body.items[0].action, 'USER_CREATED');

    const none = await server.get('/api/admin/audit-log?from=2020-01-01&to=2020-01-02', A(admin.token));
    assert.equal(none.body.total, 0);
  });

  await t.test('a user changing their own password is recorded too', async () => {
    const mgr = await server.login(...CREDS.manager);
    await server.post('/api/auth/password',
      { currentPassword: 'Manager@123', newPassword: 'Manager@456' }, A(mgr.token));
    const after = await server.get('/api/admin/audit-log?action=PASSWORD_CHANGED_SELF', A(admin.token));
    assert.equal(after.body.total, 1);
    assert.equal(after.body.items[0].actorRole, 'MANAGER');
    assert.equal(JSON.stringify(after.body).includes('Manager@456'), false);
  });

  await t.test('only the administrator can read the log', async () => {
    for (const creds of [CREDS.ciiReception, CREDS.ciiSales]) {
      const s = await server.login(...creds);
      assert.equal((await server.get('/api/admin/audit-log', A(s.token))).status, 403);
    }
    const mgr = await server.login('manager01', 'Manager@456');
    assert.equal((await server.get('/api/admin/audit-log', A(mgr.token))).status, 403);
    assert.deepEqual(
      Object.keys(MATRIX).filter((role) => can({ role }, P.AUDIT_VIEW)), [ROLES.ADMINISTRATOR]);
  });
});
