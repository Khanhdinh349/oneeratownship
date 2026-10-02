'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildApp, makeClock, visitorPayload, agencyPayload,
  OFFICE_CII, OFFICE_TG, SLOT_A, SLOT_1030,
} = require('./helpers');

/** Builds a world where "today" is the visit date, so check-in is legal. */
async function setup(visitDate = '2026-10-05') {
  const clock = makeClock(`${visitDate}T02:30:00.000Z`);
  const { services } = await buildApp({ clock });
  const users = {
    cii: (await services.auth.login('cii.reception01', 'Reception@123')).user,
    cii2: (await services.auth.login('cii.reception02', 'Reception@123')).user,
    tg: (await services.auth.login('tg.reception01', 'Reception@123')).user,
    sales: (await services.auth.login('cii.sales01', 'Sales@123')).user,
    manager: (await services.auth.login('manager01', 'Manager@123')).user,
    admin: (await services.auth.login('admin', 'Admin@123')).user,
  };
  return { ...services, clock, users, visitDate };
}

// ===========================================================================
// §XXVIII — the check-in happy path
// ===========================================================================

test('§XXVIII check-in records time, receptionist, method and sets CHECKED_IN', async () => {
  const s = await setup();
  const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: s.visitDate }));
  const result = await s.checkins.checkIn(reg.id, { user: s.users.cii, method: 'QR', notes: 'Khách đến sớm' });

  assert.equal(result.registration.status, 'CHECKED_IN', '§XXVIII.7 status updated');
  assert.ok(result.checkin.checkinTime, '§XXVIII.5 check-in time recorded');
  assert.equal(result.checkin.receptionistId, s.users.cii.id, '§XXVIII.6 receptionist recorded');
  assert.equal(result.checkin.receptionistName, s.users.cii.fullName);
  assert.equal(result.checkin.salesOfficeId, OFFICE_CII);
  assert.equal(result.checkin.checkinMethod, 'QR');
  assert.equal(result.checkin.notes, 'Khách đến sớm');
  assert.equal(result.checkin.registrationId, reg.id, '§XXVIII check-in references the Registration');
});

test('§XLVI.12 the check-in is visible on the registration and in its status history', async () => {
  const s = await setup();
  const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: s.visitDate }));
  await s.checkins.checkIn(reg.id, { user: s.users.cii, method: 'SEARCH' });

  const after = await s.registrations.getById(reg.id);
  assert.ok(after.checkin, 'the check-in record is attached');
  assert.equal(after.checkin.receptionistName, s.users.cii.fullName);
  const last = after.statusHistory.at(-1);
  assert.equal(last.toStatus, 'CHECKED_IN');
  assert.equal(last.changedByName, s.users.cii.fullName);
  assert.match(last.note, /SEARCH/);
});

test('§XXVIII check-in works from every eligible pre-arrival status', async () => {
  for (const pre of [null, 'CONFIRMED', 'EXPECTED']) {
    const s = await setup();
    const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: s.visitDate }));
    if (pre === 'CONFIRMED') await s.registrations.changeStatus(reg.id, 'CONFIRMED');
    if (pre === 'EXPECTED') {
      await s.registrations.changeStatus(reg.id, 'CONFIRMED');
      await s.registrations.changeStatus(reg.id, 'EXPECTED');
    }
    const r = await s.checkins.checkIn(reg.id, { user: s.users.cii });
    assert.equal(r.registration.status, 'CHECKED_IN', `from ${pre ?? 'REGISTERED'}`);
  }
});

// ===========================================================================
// §XXVIII — the four backend validations (§Rule 6)
// ===========================================================================

test('§XXVIII.2 a receptionist cannot check in another office\'s visitor', async () => {
  const s = await setup();
  const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: s.visitDate })); // CII
  await assert.rejects(async () => await s.checkins.checkIn(reg.id, { user: s.users.tg }), (e) => e.status === 403);
  assert.equal((await s.registrations.getById(reg.id)).status, 'REGISTERED', 'nothing changed');
});

test('§XXVIII.3 check-in on the wrong day is refused but flagged as overridable', async () => {
  const s = await setup('2026-10-05');
  const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: '2026-10-08' }));
  await assert.rejects(
    async () => await s.checkins.checkIn(reg.id, { user: s.users.cii }),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'VISIT_DATE_MISMATCH');
      assert.equal(err.details.visitDate, '2026-10-08');
      assert.equal(err.details.today, '2026-10-05');
      assert.equal(err.details.overridable, true);
      return true;
    },
  );
});

test('§XXVIII.3 an explicit override lets the desk check in early, and records why', async () => {
  const s = await setup('2026-10-05');
  const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: '2026-10-08' }));
  const r = await s.checkins.checkIn(reg.id, { user: s.users.cii, allowDateOverride: true });
  assert.equal(r.registration.status, 'CHECKED_IN');
  assert.match(r.registration.statusHistory.at(-1).note, /date override/);
});

test('§XXVIII.4 a second check-in is refused', async () => {
  const s = await setup();
  const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: s.visitDate }));
  const first = await s.checkins.checkIn(reg.id, { user: s.users.cii });
  await assert.rejects(
    async () => await s.checkins.checkIn(reg.id, { user: s.users.cii2 }),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'ALREADY_CHECKED_IN');
      assert.equal(err.details.checkinTime, first.checkin.checkinTime);
      return true;
    },
  );
  const rows = await s.db.prepare('SELECT COUNT(*) n FROM checkins WHERE registration_id = ?').get(reg.id);
  assert.equal(Number(rows.n), 1, 'exactly one check-in row survives');
});

test('§XXVIII.4 a cancelled or no-show registration cannot be checked in', async () => {
  for (const [target, code] of [['CANCELLED', 'REGISTRATION_CANCELLED'], ['NO_SHOW', 'REGISTRATION_NO_SHOW']]) {
    const s = await setup();
    const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: s.visitDate }));
    await s.registrations.changeStatus(reg.id, target);
    await assert.rejects(async () => await s.checkins.checkIn(reg.id, { user: s.users.cii }),
      (e) => e.status === 409 && e.code === code, target);
  }
});

test('§XXVIII.4 a completed visit cannot be checked in again', async () => {
  const s = await setup();
  const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: s.visitDate }));
  await s.checkins.checkIn(reg.id, { user: s.users.cii });
  await s.registrations.changeStatus(reg.id, 'COMPLETED');
  await assert.rejects(async () => await s.checkins.checkIn(reg.id, { user: s.users.cii }),
    (e) => e.code === 'ALREADY_CHECKED_IN');
});

test('§XXVIII.1 checking in an unknown registration is a 404', async () => {
  const s = await setup();
  await assert.rejects(async () => await s.checkins.checkIn('no-such-id', { user: s.users.cii }),
    (e) => e.status === 404 && e.code === 'REGISTRATION_NOT_FOUND');
});

test('§XXVIII only a receptionist or administrator may check in', async () => {
  const s = await setup();
  const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: s.visitDate }));
  for (const who of ['sales', 'manager']) {
    await assert.rejects(async () => await s.checkins.checkIn(reg.id, { user: s.users[who] }),
      (e) => e.status === 403, who);
  }
  await assert.rejects(async () => await s.checkins.checkIn(reg.id, { user: null }), (e) => e.status === 403);
  const ok = await s.checkins.checkIn(reg.id, { user: s.users.admin });
  assert.equal(ok.registration.status, 'CHECKED_IN', 'administrator may check in');
});

test('§XXVIII an unknown check-in method is rejected', async () => {
  const s = await setup();
  const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: s.visitDate }));
  await assert.rejects(async () => await s.checkins.checkIn(reg.id, { user: s.users.cii, method: 'TELEPATHY' }),
    (e) => e.status === 400 && e.code === 'INVALID_CHECKIN_METHOD');
});

// ===========================================================================
// §XXVI — resolving a visitor at the desk
// ===========================================================================

test('§XXVI.1 scanning a QR resolves the registration without mutating it', async () => {
  const s = await setup();
  const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: s.visitDate }));
  const { registration, readiness } = await s.checkins.resolveByQr(reg.qrToken, s.users.cii);
  assert.equal(registration.confirmationCode, reg.confirmationCode);
  assert.equal(readiness.canCheckIn, true);
  assert.deepEqual(readiness.reasons, []);
  assert.equal((await s.registrations.getById(reg.id)).status, 'REGISTERED', 'a scan alone changes nothing');
});

test('§XXVI.1 scanning another office\'s QR is refused', async () => {
  const s = await setup();
  const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: s.visitDate }));
  await assert.rejects(async () => s.checkins.resolveByQr(reg.qrToken, s.users.tg), (e) => e.status === 403);
});

test('§XXVI.2 resolving by confirmation code returns the same registration', async () => {
  const s = await setup();
  const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: s.visitDate }));
  const { registration } = await s.checkins.resolveByConfirmationCode(reg.confirmationCode.toLowerCase(), s.users.cii);
  assert.equal(registration.id, reg.id);
  await assert.rejects(async () => s.checkins.resolveByConfirmationCode('OE-ZZZZZ', s.users.cii),
    (e) => e.status === 404);
});

test('§Step 7 readiness reports each blocking reason for the receptionist screen', async () => {
  const s = await setup('2026-10-05');
  // already checked in
  const a = await s.registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05', cccd: '111111111111' }));
  await s.checkins.checkIn(a.id, { user: s.users.cii });
  const rA = await s.checkins.evaluateReadiness(await s.registrations.getById(a.id), s.users.cii);
  assert.equal(rA.canCheckIn, false);
  assert.ok(rA.reasons.some((x) => x.code === 'ALREADY_CHECKED_IN'));
  assert.ok(rA.reasons.find((x) => x.code === 'ALREADY_CHECKED_IN').checkinTime);

  // cancelled
  const b = await s.registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05', cccd: '222222222222' }));
  await s.registrations.changeStatus(b.id, 'CANCELLED');
  const rB = await s.checkins.evaluateReadiness(await s.registrations.getById(b.id), s.users.cii);
  assert.ok(rB.reasons.some((x) => x.code === 'CANCELLED'));

  // no show
  const c = await s.registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05', cccd: '333333333333' }));
  await s.registrations.changeStatus(c.id, 'NO_SHOW');
  assert.ok((await s.checkins.evaluateReadiness(await s.registrations.getById(c.id), s.users.cii))
    .reasons.some((x) => x.code === 'NO_SHOW'));

  // future date
  const d = await s.registrations.createRegistration(visitorPayload({ visitDate: '2026-10-09', cccd: '444444444444' }));
  assert.ok((await s.checkins.evaluateReadiness(await s.registrations.getById(d.id), s.users.cii))
    .reasons.some((x) => x.code === 'FUTURE_VISIT_DATE'));

  // wrong office
  assert.ok((await s.checkins.evaluateReadiness(await s.registrations.getById(d.id), s.users.tg))
    .reasons.some((x) => x.code === 'WRONG_OFFICE'));
});

test('§Step 7 readiness reports a past visit date distinctly from a future one', async () => {
  const clock = makeClock('2026-10-05T02:30:00.000Z');
  const { services } = await buildApp({ clock });
  const user = (await services.auth.login('cii.reception01', 'Reception@123')).user;
  const reg = await services.registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05' }));
  clock.setDate('2026-10-07');
  const readiness = await services.checkins.evaluateReadiness(await services.registrations.getById(reg.id), user);
  assert.equal(readiness.canCheckIn, false);
  assert.ok(readiness.reasons.some((x) => x.code === 'PAST_VISIT_DATE'));
});

// ===========================================================================
// §XLIII — the full arrival-to-completion lifecycle
// ===========================================================================

test('§XLVIII a visitor traverses the whole lifecycle end to end', async () => {
  const s = await setup('2026-10-05');
  const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05' }));
  assert.equal(reg.status, 'REGISTERED');

  await s.registrations.changeStatus(reg.id, 'CONFIRMED');
  await s.registrations.changeStatus(reg.id, 'EXPECTED');
  await s.checkins.checkIn(reg.id, { user: s.users.cii, method: 'QR' });
  await s.parking.issue(reg.id, { vehicleType: 'CAR', ticketNumber: 'PX-77' },
    { actor: { id: s.users.cii.id, name: s.users.cii.fullName } });
  await s.registrations.changeStatus(reg.id, 'IN_VISIT');
  const done = await s.registrations.changeStatus(reg.id, 'COMPLETED');

  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.parking.byVehicleType.CAR.issued, 1);
  assert.equal(done.parking.tickets[0].ticketNumber, 'PX-77');
  assert.deepEqual(
    done.statusHistory.map((h) => h.toStatus),
    ['REGISTERED', 'CONFIRMED', 'EXPECTED', 'CHECKED_IN', 'IN_VISIT', 'COMPLETED'],
    'issuing a parking ticket does not touch the status lifecycle',
  );
});

test('§XXIV both offices keep independent check-in streams', async () => {
  const s = await setup('2026-10-05');
  const cii = await s.registrations.createRegistration(visitorPayload({ visitDate: '2026-10-05' }));
  const tg = await s.registrations.createRegistration(agencyPayload({
    salesOfficeId: OFFICE_TG, visitDate: '2026-10-05', timeSlotId: SLOT_1030,
  }));
  await s.checkins.checkIn(cii.id, { user: s.users.cii });
  // Booked for 10:30 and arriving at 09:30: early, so the desk confirms it.
  await s.checkins.checkIn(tg.id, { user: s.users.tg, allowTimeOverride: true });

  const ciiList = await s.checkins.listCheckins({ salesOfficeId: OFFICE_CII });
  const tgList = await s.checkins.listCheckins({ salesOfficeId: OFFICE_TG });
  assert.equal(ciiList.length, 1);
  assert.equal(tgList.length, 1);
  assert.equal(ciiList[0].registrationId, cii.id);
  assert.equal(tgList[0].receptionistName, s.users.tg.fullName);
  assert.equal((await s.checkins.listCheckins({ date: '2026-10-05' })).length, 2);
});

// ===========================================================================
// §XXV — authentication
// ===========================================================================

test('§XXV login succeeds with correct credentials and carries role plus office', async () => {
  const s = await setup();
  const res = await s.auth.login('cii.reception01', 'Reception@123');
  assert.ok(res.token);
  assert.equal(res.user.role, 'RECEPTIONIST');
  assert.equal(res.user.salesOfficeId, OFFICE_CII);
  assert.equal((await s.auth.verifyToken(res.token)).id, res.user.id);
});

test('§XXV login fails identically for a wrong password and an unknown user', async () => {
  const s = await setup();
  const a = await (async () => { try { await s.auth.login('cii.reception01', 'wrong'); } catch (e) { return e; } })();
  const b = await (async () => { try { await s.auth.login('ghost', 'whatever'); } catch (e) { return e; } })();
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.message, b.message, 'no user enumeration');
  await assert.rejects(async () => await s.auth.login('', ''), (e) => e.code === 'CREDENTIALS_REQUIRED');
});

test('§XXV a tampered, malformed or foreign token is rejected', async () => {
  const s = await setup();
  const { token } = await s.auth.login('cii.reception01', 'Reception@123');
  const [body, sig] = token.split('.');
  for (const bad of ['', 'nonsense', `${body}.${'x'.repeat(sig.length)}`, body,
    `${Buffer.from('{"sub":"x","exp":9999999999999}').toString('base64url')}.${sig}`]) {
    await assert.rejects(async () => await s.auth.verifyToken(bad), (e) => e.status === 401, JSON.stringify(bad));
  }
});

test('§XXV an expired token is rejected', async () => {
  const clock = makeClock('2026-10-05T02:30:00.000Z');
  const { services } = await buildApp({ clock });
  const { token } = await services.auth.login('cii.reception01', 'Reception@123');
  clock.set('2026-10-06T02:30:00.000Z'); // 24h later, past the 8h shift TTL
  await assert.rejects(async () => await services.auth.verifyToken(token), (e) => e.status === 401 && /expired/i.test(e.message));
});

test('§XXV a deactivated account can no longer use an issued token', async () => {
  const s = await setup();
  const { token, user } = await s.auth.login('cii.reception01', 'Reception@123');
  await s.auth.setUserActive(user.id, false);
  await assert.rejects(async () => await s.auth.verifyToken(token), (e) => e.status === 401);
  await assert.rejects(async () => await s.auth.login('cii.reception01', 'Reception@123'), (e) => e.status === 401);
});

test('§XXIV each office is seeded with its own three receptionists', async () => {
  const s = await setup();
  const cii = await s.auth.listUsers({ role: 'RECEPTIONIST', salesOfficeId: OFFICE_CII });
  const tg = await s.auth.listUsers({ role: 'RECEPTIONIST', salesOfficeId: OFFICE_TG });
  assert.equal(cii.length, 3);
  assert.equal(tg.length, 3);
  assert.ok(cii.every((u) => u.salesOfficeId === OFFICE_CII));
});

test('§XXXIX administrator user management enforces role and office rules', async () => {
  const s = await setup();
  await assert.rejects(async () => await s.auth.createUser({ username: 'x', fullName: 'X', role: 'WIZARD', password: 'p' }),
    (e) => e.code === 'INVALID_ROLE');
  await assert.rejects(async () => await s.auth.createUser({ username: 'x', fullName: 'X', role: 'RECEPTIONIST', password: 'p' }),
    (e) => e.code === 'OFFICE_REQUIRED');
  const created = await s.auth.createUser({
    username: 'CII.Reception99', fullName: 'New Desk', role: 'RECEPTIONIST',
    salesOfficeId: OFFICE_CII, password: 'Secret@123',
  });
  assert.equal(created.username, 'cii.reception99', 'usernames are normalized to lower case');
  assert.equal((await s.auth.login('cii.reception99', 'Secret@123')).user.id, created.id);
});

test('passwords are stored salted and never in clear text', async () => {
  const s = await setup();
  const row = await s.db.prepare('SELECT * FROM users WHERE username = ?').get('cii.reception01');
  assert.ok(row.password_hash && row.password_salt);
  assert.equal(row.password_hash.includes('Reception@123'), false);
  const other = await s.db.prepare('SELECT * FROM users WHERE username = ?').get('cii.reception02');
  assert.notEqual(row.password_salt, other.password_salt, 'each account has its own salt');
  assert.notEqual(row.password_hash, other.password_hash, 'identical passwords hash differently');
});

// ===========================================================================
// §XXVI Option 2 — the desk's one search box
// ===========================================================================

async function seedSearchable(s) {
  const visitor = await s.registrations.createRegistration(visitorPayload({
    visitDate: s.visitDate, fullName: 'Nguyễn Văn An', cccd: '079123456789',
    phone: '0908887766', timeSlotId: SLOT_A,
  }));
  const agency = await s.registrations.createRegistration(agencyPayload({
    salesOfficeId: OFFICE_CII, visitDate: s.visitDate, timeSlotId: SLOT_1030,
    salesStaffName: 'Trần Thị Bích', salesStaffCccd: '098765432109',
    salesStaffPhone: '0912345678', customerShortName: 'N.V.C', customerPhoneLast4: '4321',
  }));
  return { visitor, agency };
}

test('§XXVI.2 lookup finds a registration by every identifier the spec names', async () => {
  const s = await setup();
  const { visitor, agency } = await seedSearchable(s);
  const find = (q) => s.checkins.lookup(q, s.users.cii, { scopeOfficeId: OFFICE_CII });

  for (const [query, expected, label] of [
    [visitor.confirmationCode, visitor.id, 'confirmation code'],
    [visitor.confirmationCode.toLowerCase(), visitor.id, 'code, lower case'],
    ['Nguyễn Văn An', visitor.id, 'visitor name'],
    ['nguyễn', visitor.id, 'partial name, lower case'],
    ['0908887766', visitor.id, 'visitor phone'],
    ['079123456789', visitor.id, 'visitor CCCD'],
    ['IQI', agency.id, 'agency name'],
    ['Trần Thị Bích', agency.id, 'sales staff name'],
    ['0912345678', agency.id, 'sales staff phone'],
    ['098765432109', agency.id, 'sales staff CCCD'],
    ['N.V.C', agency.id, 'customer short name'],
    ['4321', agency.id, 'customer phone last 4'],
  ]) {
    const res = await find(query);
    assert.equal(res.mode, 'single', `${label} should resolve to one registration`);
    assert.equal(res.registration.id, expected, label);
    assert.ok(res.readiness, `${label} carries readiness`);
  }
});

test('§XXVI.2 lookup resolves a scanned QR payload and a bare token', async () => {
  const s = await setup();
  const reg = await s.registrations.createRegistration(visitorPayload({ visitDate: s.visitDate }));
  const full = await s.registrations.getById(reg.id, { includeQrToken: true });

  for (const query of [full.qrToken, `https://x.test/checkin?t=${full.qrToken}`]) {
    const res = await s.checkins.lookup(query, s.users.cii, { scopeOfficeId: OFFICE_CII });
    assert.equal(res.mode, 'single');
    assert.equal(res.method, 'QR', 'a token is recorded as a QR check-in, not a search');
    assert.equal(res.registration.id, reg.id);
  }
});

test('§XXVI.2 an ambiguous query returns every match for the desk to choose from', async () => {
  const s = await setup();
  // Three visitors sharing a surname.
  const surnames = ['Nguyễn Văn A', 'Nguyễn Thị B', 'Nguyễn Văn C'];
  for (const [i, fullName] of surnames.entries()) {
    // eslint-disable-next-line no-await-in-loop
    await s.registrations.createRegistration(visitorPayload({
      visitDate: s.visitDate, fullName, cccd: String(300000000000 + i),
      phone: `090111${2000 + i}`, timeSlotId: [SLOT_A, SLOT_1030, 'SLOT_1300_1430'][i],
    }));
  }

  const res = await s.checkins.lookup('Nguyễn', s.users.cii, { scopeOfficeId: OFFICE_CII });
  assert.equal(res.mode, 'multiple');
  assert.equal(res.matches.length, 3);
  assert.equal(res.total, 3);
  res.matches.forEach((m) => {
    assert.ok(m.registration.confirmationCode, 'each match is identifiable');
    assert.ok(m.readiness, 'each match carries its own readiness');
    assert.equal(m.registration.qrToken, undefined, 'no token leaks into a match');
  });
});

test('§XXVI.2 a query that matches nothing reports none rather than throwing', async () => {
  const s = await setup();
  await seedSearchable(s);
  const res = await s.checkins.lookup('Không Có Ai', s.users.cii, { scopeOfficeId: OFFICE_CII });
  assert.equal(res.mode, 'none');
  assert.deepEqual(res.matches, []);
  assert.equal(res.query, 'Không Có Ai');

  // An unknown but well-formed code also falls through to "none", not a 404.
  assert.equal((await s.checkins.lookup('OE-ZZZZZ', s.users.cii, { scopeOfficeId: OFFICE_CII })).mode, 'none');
});

test('§XXVI.2 an empty query is rejected with guidance', async () => {
  const s = await setup();
  for (const bad of ['', '   ', null, undefined]) {
    await assert.rejects(async () => await s.checkins.lookup(bad, s.users.cii, {}),
      (e) => e.status === 400 && e.code === 'SEARCH_QUERY_REQUIRED', JSON.stringify(bad));
  }
});

test('§XXV lookup never reaches across the office boundary', async () => {
  const s = await setup();
  const { visitor } = await seedSearchable(s);   // both at CII

  // A Thuận Giao receptionist searching the same name finds nothing.
  const scoped = await s.checkins.lookup('Nguyễn Văn An', s.users.tg, { scopeOfficeId: OFFICE_TG });
  assert.equal(scoped.mode, 'none');

  // And the CII confirmation code is refused outright rather than revealed.
  await assert.rejects(
    async () => await s.checkins.lookup(visitor.confirmationCode, s.users.tg, { scopeOfficeId: OFFICE_TG }),
    (e) => e.status === 403,
  );

  // A manager, who has no office scope, sees it.
  const wide = await s.checkins.lookup('Nguyễn Văn An', s.users.manager, { scopeOfficeId: null });
  assert.equal(wide.mode, 'single');
});
