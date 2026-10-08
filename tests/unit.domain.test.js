'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dates = require('../src/domain/dates');
const codes = require('../src/domain/codes');
const status = require('../src/domain/status');
const validation = require('../src/domain/validation');
const permissions = require('../src/domain/permissions');
const { ROLES, TIME_SLOTS, SALES_OFFICES, MAX_ADVANCE_DAYS, SLOT_CAPACITY,
  GUEST_CATEGORIES, GUEST_CATEGORY_IDS } = require('../src/config/master-data');

// ===========================================================================
// §VII / §XIV / §XLI Process 5 — the 10-day booking window
// ===========================================================================

test('§VII booking window: today through today+10 inclusive is accepted', () => {
  const today = '2026-10-01';
  assert.equal(dates.isVisitDateWithinWindow('2026-10-01', today), true, 'today');
  assert.equal(dates.isVisitDateWithinWindow('2026-10-05', today), true, 'mid-range');
  assert.equal(dates.isVisitDateWithinWindow('2026-10-11', today), true, 'today+10 (spec example 01/10 → 11/10)');
});

test('§VII booking window: today+11 and any past date are rejected', () => {
  const today = '2026-10-01';
  assert.equal(dates.isVisitDateWithinWindow('2026-10-12', today), false, 'today+11');
  assert.equal(dates.isVisitDateWithinWindow('2026-09-30', today), false, 'yesterday');
  assert.equal(dates.isVisitDateWithinWindow('2025-10-05', today), false, 'last year');
});

test('§VII selectableDates returns exactly 11 consecutive days starting today', () => {
  const list = dates.selectableDates('2026-10-01');
  assert.equal(list.length, MAX_ADVANCE_DAYS + 1);
  assert.equal(list[0], '2026-10-01');
  assert.equal(list.at(-1), '2026-10-11');
  for (let i = 1; i < list.length; i += 1) {
    assert.equal(dates.diffDays(list[i - 1], list[i]), 1);
  }
});

test('§VII window arithmetic crosses month and year boundaries correctly', () => {
  assert.equal(dates.addDays('2026-10-25', 10), '2026-11-04');
  assert.equal(dates.isVisitDateWithinWindow('2026-11-04', '2026-10-25'), true);
  assert.equal(dates.isVisitDateWithinWindow('2026-11-05', '2026-10-25'), false);
  assert.equal(dates.addDays('2026-12-28', 10), '2027-01-07');
  assert.equal(dates.isVisitDateWithinWindow('2027-01-07', '2026-12-28'), true);
  // leap year
  assert.equal(dates.addDays('2028-02-25', 10), '2028-03-06');
});

test('date validation rejects malformed and impossible dates', () => {
  for (const bad of ['2026-13-01', '2026-02-30', '2026-2-1', '01/10/2026', '', null, undefined, '2026-10-32']) {
    assert.equal(dates.isValidDateString(bad), false, `${bad} should be invalid`);
  }
  assert.equal(dates.isValidDateString('2026-02-29'), false, '2026 is not a leap year');
  assert.equal(dates.isValidDateString('2028-02-29'), true, '2028 is a leap year');
});

test('week and month helpers align to Monday and full months', () => {
  assert.equal(dates.startOfWeek('2026-10-01'), '2026-09-28', 'Thursday → Monday');
  assert.equal(dates.startOfWeek('2026-09-28'), '2026-09-28', 'Monday → itself');
  assert.equal(dates.startOfWeek('2026-10-04'), '2026-09-28', 'Sunday → previous Monday');
  assert.deepEqual(dates.monthRange('2026-10-15'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(dates.monthRange('2026-02-10'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(dates.monthRange('2028-02-10'), { from: '2028-02-01', to: '2028-02-29' });
});

// ===========================================================================
// §XVIII.2 / §XLI Process 8 — Confirmation Code  OE-XXXXX
// ===========================================================================

test('§XVIII.2 confirmation code always matches OE-XXXXX', () => {
  for (let i = 0; i < 500; i += 1) {
    const code = codes.generateConfirmationCodeCandidate();
    assert.match(code, /^OE-[0-9A-Z]{5}$/);
    assert.ok(code.startsWith('OE-'));
    assert.equal(code.length, 8);
  }
});

test('§XVIII.2 confirmation code alphabet excludes ambiguous characters', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) {
    codes.generateConfirmationCodeCandidate().slice(3).split('').forEach((c) => seen.add(c));
  }
  for (const banned of ['0', 'O', '1', 'I', 'L']) {
    assert.equal(seen.has(banned), false, `"${banned}" must not appear in generated codes`);
  }
});

test('§XVIII.2 generateUniqueConfirmationCode never returns an existing code', () => {
  const used = new Set();
  for (let i = 0; i < 300; i += 1) {
    const code = codes.generateUniqueConfirmationCode((c) => used.has(c));
    assert.equal(used.has(code), false);
    used.add(code);
  }
  assert.equal(used.size, 300);
});

test('§XVIII.2 exhausted code space throws rather than emitting a duplicate', async () => {
  await assert.rejects(
    () => codes.generateUniqueConfirmationCode(() => true, 5),
    (err) => err.code === 'CONFIRMATION_CODE_EXHAUSTED',
  );
});

test('confirmation code validation and normalization', () => {
  assert.equal(codes.isValidConfirmationCode('OE-7K29P'), true);
  assert.equal(codes.isValidConfirmationCode(' oe-7k29p '), true, 'trimmed + upcased');
  assert.equal(codes.normalizeConfirmationCode(' oe-7k29p '), 'OE-7K29P');
  for (const bad of ['OE-7K29', 'OE-7K29PP', 'XX-7K29P', '7K29P', 'OE_7K29P', '', null]) {
    assert.equal(codes.isValidConfirmationCode(bad), false, `${bad} should be invalid`);
  }
});

// ===========================================================================
// §XVIII.3 / §XLI Process 9 — QR token carries no personal data
// ===========================================================================

test('§XVIII.3 QR token is opaque, unique and signature-verified', () => {
  const secret = 's3cret';
  const tokens = new Set();
  for (let i = 0; i < 300; i += 1) {
    const t = codes.generateQrToken(secret);
    assert.match(t, /^[0-9a-f]{32}\.[0-9a-f]{16}$/);
    assert.equal(codes.isWellFormedQrToken(t, secret), true);
    tokens.add(t);
  }
  assert.equal(tokens.size, 300, 'no collisions');
});

test('§XVIII.3 a tampered or foreign QR token fails verification', () => {
  const token = codes.generateQrToken('secret-a');
  assert.equal(codes.isWellFormedQrToken(token, 'secret-b'), false, 'different secret');
  const [nonce, sig] = token.split('.');
  // Flip the first hex digit to a guaranteed-different one.
  const flipped = (nonce[0] === '0' ? '1' : '0') + nonce.slice(1);
  assert.notEqual(flipped, nonce);
  assert.equal(codes.isWellFormedQrToken(`${flipped}.${sig}`, 'secret-a'), false, 'nonce tampered');

  const flippedSig = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
  assert.equal(codes.isWellFormedQrToken(`${nonce}.${flippedSig}`, 'secret-a'), false, 'signature tampered');
  for (const bad of ['', 'abc', 'abc.def', null, undefined, 42, `${nonce}.${sig}.extra`]) {
    assert.equal(codes.isWellFormedQrToken(bad, 'secret-a'), false);
  }
});

test('§XVIII.3 QR payload contains only a reference — no personal data', () => {
  const token = codes.generateQrToken('s');
  const payload = codes.qrPayload('https://register.kinera.local/', token);
  assert.equal(payload, `https://register.kinera.local/checkin?t=${token}`);
  for (const personal of ['Nguyễn', '012345678901', '0901234567', '@example.com']) {
    assert.equal(payload.includes(personal), false);
  }
});

// ===========================================================================
// §XXIII — status lifecycle
// ===========================================================================

test('§XXIII the happy-path lifecycle is fully traversable', () => {
  const chain = ['REGISTERED', 'CONFIRMED', 'EXPECTED', 'CHECKED_IN', 'IN_VISIT', 'COMPLETED'];
  for (let i = 0; i < chain.length - 1; i += 1) {
    assert.equal(status.canTransition(chain[i], chain[i + 1]), true, `${chain[i]} → ${chain[i + 1]}`);
  }
});

test('§XXIII backwards and skip-back transitions are refused', () => {
  assert.equal(status.canTransition('CHECKED_IN', 'EXPECTED'), false);
  assert.equal(status.canTransition('COMPLETED', 'CHECKED_IN'), false);
  assert.equal(status.canTransition('EXPECTED', 'REGISTERED'), false);
  assert.equal(status.canTransition('IN_VISIT', 'CHECKED_IN'), false);
});

test('§XXIII terminal statuses accept no further transition', () => {
  for (const terminal of ['COMPLETED', 'CANCELLED', 'NO_SHOW']) {
    for (const target of status.ALL_STATUSES) {
      assert.equal(status.canTransition(terminal, target), false, `${terminal} → ${target}`);
    }
  }
});

test('§XXIII cancel / no-show are reachable only before arrival', () => {
  for (const from of ['REGISTERED', 'CONFIRMED', 'EXPECTED']) {
    assert.equal(status.canTransition(from, 'CANCELLED'), true);
    assert.equal(status.canTransition(from, 'NO_SHOW'), true);
  }
  for (const from of ['CHECKED_IN', 'IN_VISIT']) {
    assert.equal(status.canTransition(from, 'CANCELLED'), false);
    assert.equal(status.canTransition(from, 'NO_SHOW'), false);
  }
});

test('§XXIII assertTransition throws typed errors', () => {
  assert.throws(() => status.assertTransition('COMPLETED', 'CHECKED_IN'),
    (e) => e.code === 'INVALID_STATUS_TRANSITION' && e.status === 409);
  assert.throws(() => status.assertTransition('REGISTERED', 'BANANA'),
    (e) => e.code === 'UNKNOWN_STATUS');
});

test('§XXIII arrival predicate and check-in eligibility', () => {
  assert.deepEqual(status.CHECKIN_ELIGIBLE, ['REGISTERED', 'CONFIRMED', 'EXPECTED']);
  for (const s of ['CHECKED_IN', 'IN_VISIT', 'COMPLETED']) {
    assert.equal(status.isCheckedInOrBeyond(s), true);
  }
  for (const s of ['REGISTERED', 'CONFIRMED', 'EXPECTED', 'CANCELLED', 'NO_SHOW']) {
    assert.equal(status.isCheckedInOrBeyond(s), false);
  }
});

// ===========================================================================
// §VI / §XII / §XIII / §XLI Process 4 — field validation
// ===========================================================================

const CTX = {
  offices: SALES_OFFICES,
  slots: TIME_SLOTS.map((s) => ({ ...s, active: 1 })),
  agencies: [{ id: 'AG_IQI', name: 'IQI', active: 1 }],
  today: '2026-10-01',
};

const codesOf = (errors, field) => errors.filter((e) => e.field === field).map((e) => e.code);

test('§VI a fully valid visitor payload produces no errors', () => {
  const { value, errors } = validation.validateRegistrationInput({
    language: 'vi', salesOfficeId: 'CII_BINH_THANH', visitorType: 'VISITOR',
    fullName: 'Nguyễn Văn A', cccd: '012345678901', phone: '0901234567',
    email: 'A@Example.COM', numberOfVisitors: 3, guestCategory: 'CUSTOMER',
    visitDate: '2026-10-05', timeSlotId: 'SLOT_0900_1030', notes: 'ok',
  }, CTX);
  assert.deepEqual(errors, []);
  assert.equal(value.email, 'a@example.com', 'email is lower-cased');
  assert.equal(value.numberOfVisitors, 3);
});

test('§VI.5 number of visitors must be a positive whole number and never 0', () => {
  for (const [input, expected] of [
    [0, 'NUMBER_OF_VISITORS_TOO_LOW'],
    [-2, 'NUMBER_OF_VISITORS_TOO_LOW'],
    [2.5, 'INVALID_NUMBER_OF_VISITORS'],
    ['abc', 'INVALID_NUMBER_OF_VISITORS'],
    ['', 'NUMBER_OF_VISITORS_REQUIRED'],
    [null, 'NUMBER_OF_VISITORS_REQUIRED'],
    [21, 'NUMBER_OF_VISITORS_TOO_HIGH'],
  ]) {
    const errors = [];
    validation.validateNumberOfVisitors(input, errors);
    assert.deepEqual(codesOf(errors, 'numberOfVisitors'), [expected], `input ${JSON.stringify(input)}`);
  }
  const ok = [];
  assert.equal(validation.validateNumberOfVisitors('4', ok), 4, 'numeric strings accepted');
  assert.deepEqual(ok, []);
  assert.equal(validation.validateNumberOfVisitors(20, []), 20, 'upper bound inclusive');
});

test('§VI.2 CCCD accepts 12 or 9 digits and rejects anything else', () => {
  assert.equal(validation.validateCccd('012345678901', 'cccd', 'CCCD', []), '012345678901');
  assert.equal(validation.validateCccd('012345678', 'cccd', 'CCCD', []), '012345678');
  assert.equal(validation.validateCccd(' 0123 4567 8901 ', 'cccd', 'CCCD', []), '012345678901', 'spaces stripped');
  for (const bad of ['1234567', '0123456789012', 'abcdefghijkl', '01234567890a', '', '   ']) {
    const errors = [];
    validation.validateCccd(bad, 'cccd', 'CCCD', errors);
    assert.equal(errors.length, 1, `${bad} should be rejected`);
  }
});

test('§VI.3 phone accepts Vietnamese formats and normalizes them', () => {
  for (const input of ['0901234567', '090 123 4567', '090-123-4567', '+84901234567', '84901234567']) {
    assert.equal(validation.validatePhone(input, 'phone', 'Phone', []), '0901234567', input);
  }
  for (const bad of ['123', '0901234', '09012345678', 'abcdefghij', '', '1901234567']) {
    const errors = [];
    validation.validatePhone(bad, 'phone', 'Phone', errors);
    assert.equal(errors.length, 1, `${bad} should be rejected`);
  }
});

test('§VI.4 email is optional (assumption A1) but validated when supplied', () => {
  assert.equal(validation.validateOptionalEmail('', []), null);
  assert.equal(validation.validateOptionalEmail(null, []), null);
  assert.equal(validation.validateOptionalEmail('a@b.co', []), 'a@b.co');
  for (const bad of ['not-an-email', 'a@b', 'a@@b.com', 'a b@c.com', '@b.com']) {
    const errors = [];
    validation.validateOptionalEmail(bad, errors);
    assert.deepEqual(codesOf(errors, 'email'), ['INVALID_EMAIL'], bad);
  }
});

test('§VI missing required visitor fields are all reported at once', () => {
  const { errors } = validation.validateRegistrationInput({
    language: 'vi', salesOfficeId: 'CII_BINH_THANH', visitorType: 'VISITOR',
    visitDate: '2026-10-05', timeSlotId: 'SLOT_0900_1030',
  }, CTX);
  const fields = errors.map((e) => e.field).sort();
  assert.deepEqual(fields, ['cccd', 'fullName', 'guestCategory', 'numberOfVisitors', 'phone']);
});

test('§XIII.2 customer phone accepts exactly 4 digits and nothing else', () => {
  assert.equal(validation.validateLast4('4321', []), '4321');
  for (const bad of ['432', '43210', 'abcd', '43a1', '', '  ']) {
    const errors = [];
    validation.validateLast4(bad, errors);
    assert.equal(errors.length, 1, `${bad} should be rejected`);
  }
});

test('§XI–§XIII a fully valid agency payload produces no errors and resolves the agency name', () => {
  const { value, errors } = validation.validateRegistrationInput({
    language: 'en', salesOfficeId: 'THUAN_GIAO_BINH_DUONG', visitorType: 'AGENCY',
    agencyId: 'AG_IQI', salesStaffName: 'Nguyễn Văn B', salesStaffCccd: '098765432109',
    salesStaffPhone: '0912345678', customerShortName: 'N.V.C', customerPhoneLast4: '4321',
    numberOfVisitors: 5, guestCategory: 'SALES_PARTNER',
    visitDate: '2026-10-06', timeSlotId: 'SLOT_1030_1200',
  }, CTX);
  assert.deepEqual(errors, []);
  assert.equal(value.agencyName, 'IQI', 'agency name resolved from master data');
  assert.equal(value.fullName, undefined, 'visitor-only fields are not set for an agency');
});

test('§XI–§XIII missing required agency fields are all reported', () => {
  const { errors } = validation.validateRegistrationInput({
    language: 'en', salesOfficeId: 'THUAN_GIAO_BINH_DUONG', visitorType: 'AGENCY',
    numberOfVisitors: 2, visitDate: '2026-10-06', timeSlotId: 'SLOT_1030_1200',
  }, CTX);
  assert.deepEqual(errors.map((e) => e.field).sort(), [
    'agencyId', 'customerPhoneLast4', 'customerShortName', 'guestCategory',
    'salesStaffCccd', 'salesStaffName', 'salesStaffPhone',
  ]);
});

test('§XI an unknown or inactive agency is rejected', () => {
  const errors = [];
  validation.validateAgency('NOPE', CTX.agencies, errors);
  assert.deepEqual(codesOf(errors, 'agencyId'), ['INVALID_AGENCY']);
  const inactive = [];
  validation.validateAgency('AG_X', [{ id: 'AG_X', name: 'X', active: 0 }], inactive);
  assert.deepEqual(codesOf(inactive, 'agencyId'), ['INVALID_AGENCY']);
});

test('§IV sales office is mandatory and must be one of the two offices', () => {
  const missing = [];
  validation.validateSalesOffice('', SALES_OFFICES, missing);
  assert.deepEqual(codesOf(missing, 'salesOfficeId'), ['SALES_OFFICE_REQUIRED']);
  const unknown = [];
  validation.validateSalesOffice('HANOI', SALES_OFFICES, unknown);
  assert.deepEqual(codesOf(unknown, 'salesOfficeId'), ['INVALID_SALES_OFFICE']);
  assert.equal(validation.validateSalesOffice('CII_BINH_THANH', SALES_OFFICES, []).name, 'CII - Bình Thạnh');
});

test('§XLVI.1 only vi and en are accepted as languages', () => {
  assert.equal(validation.validateLanguage('vi', []), 'vi');
  assert.equal(validation.validateLanguage('en', []), 'en');
  for (const bad of ['fr', 'VI', '', null, 'vietnamese']) {
    const errors = [];
    validation.validateLanguage(bad, errors);
    assert.deepEqual(codesOf(errors, 'language'), ['INVALID_LANGUAGE'], String(bad));
  }
});

test('§XLVI.3 only VISITOR and AGENCY are accepted as visitor types', () => {
  for (const bad of ['visitor', 'STAFF', '', null]) {
    const errors = [];
    validation.validateVisitorType(bad, errors);
    assert.deepEqual(codesOf(errors, 'visitorType'), ['INVALID_VISITOR_TYPE'], String(bad));
  }
});

test('§IX notes are optional and length-capped', () => {
  assert.equal(validation.validateNotes('', []), null);
  assert.equal(validation.validateNotes('  ', []), null);
  assert.equal(validation.validateNotes('hello', []), 'hello');
  const errors = [];
  validation.validateNotes('x'.repeat(501), errors);
  assert.deepEqual(codesOf(errors, 'notes'), ['NOTES_TOO_LONG']);
});

test('§XLI Process 4 a non-object payload is rejected without throwing', () => {
  for (const bad of [null, undefined, 'string', 42]) {
    const { errors } = validation.validateRegistrationInput(bad, CTX);
    assert.ok(errors.length >= 4, 'reports the missing core fields');
  }
});

test('assertNoErrors raises a 400 VALIDATION_FAILED carrying field details', () => {
  const details = [{ field: 'phone', code: 'INVALID_PHONE', message: 'bad' }];
  assert.throws(() => validation.assertNoErrors(details), (e) => e.status === 400
    && e.code === 'VALIDATION_FAILED' && e.details === details);
  assert.doesNotThrow(() => validation.assertNoErrors([]));
});

// ===========================================================================
// §VIII — time slots: four windows, 30 guests each
// ===========================================================================

test('§VIII the slot list is the four agreed booking windows, in order', () => {
  assert.deepEqual(TIME_SLOTS.map((s) => s.label), [
    '09:00 – 10:30', '10:30 – 12:00', '13:00 – 14:30', '14:30 – 16:00',
  ]);
});

test('§VIII every slot holds at most 30 guests and has a unique id', () => {
  const ids = new Set();
  TIME_SLOTS.forEach((s) => {
    assert.equal(s.capacity, 30, `${s.id} capacity`);
    assert.equal(s.capacity, SLOT_CAPACITY);
    assert.ok(s.id && s.startTime && s.endTime, 'Slot ID, Start and End are present');
    assert.equal(ids.has(s.id), false, 'slot ids are unique');
    ids.add(s.id);
  });
  assert.equal(ids.size, 4);
});

test('§VIII there is exactly one 09:00 – 10:30 slot', () => {
  const nine = TIME_SLOTS.filter((s) => s.startTime === '09:00' && s.endTime === '10:30');
  assert.equal(nine.length, 1, 'the duplicate from the original input is resolved');
  assert.equal(nine[0].id, 'SLOT_0900_1030');
});

test('§VIII no slot carries a business-confirmation flag any more', () => {
  TIME_SLOTS.forEach((s) => {
    assert.equal('needsBusinessConfirmation' in s, false, `${s.id}`);
    assert.equal('confirmationNote' in s, false, `${s.id}`);
  });
});

test('§VIII slots do not overlap and run in chronological order', () => {
  const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  for (let i = 1; i < TIME_SLOTS.length; i += 1) {
    assert.ok(mins(TIME_SLOTS[i].startTime) >= mins(TIME_SLOTS[i - 1].endTime),
      `${TIME_SLOTS[i].label} starts after ${TIME_SLOTS[i - 1].label} ends`);
  }
});

test('§XLVI.2 exactly two sales offices exist, and only CII tracks parking tickets', () => {
  assert.equal(SALES_OFFICES.length, 2);
  assert.deepEqual(SALES_OFFICES.map((o) => o.name), ['CII - Bình Thạnh', 'Thuận Giao - Bình Dương']);
  assert.equal(SALES_OFFICES.find((o) => o.id === 'CII_BINH_THANH').parkingTicketEnabled, true);
  assert.equal(SALES_OFFICES.find((o) => o.id === 'THUAN_GIAO_BINH_DUONG').parkingTicketEnabled, false);
});

// ===========================================================================
// §XXXIX — permission matrix
// ===========================================================================

test('§XXXIX receptionist can check in but cannot see the dashboard or manage users', () => {
  const u = { role: ROLES.RECEPTIONIST, salesOfficeId: 'CII_BINH_THANH' };
  // Reception now also registers walk-ins at the desk and corrects a check-in it
  // got wrong, so both are theirs as well.
  for (const p of ['registration:view', 'registration:search', 'qr:scan', 'checkin:perform',
    'checkin:amend', 'registration:create', 'status:update', 'parking:update', 'calendar:view']) {
    assert.equal(permissions.can(u, p), true, p);
  }
  for (const p of ['dashboard:view', 'reports:view', 'user:manage', 'masterdata:manage']) {
    assert.equal(permissions.can(u, p), false, p);
  }
});

test('§XXXIX sales can create registrations but cannot check in', () => {
  const u = { role: ROLES.SALES, salesOfficeId: 'CII_BINH_THANH' };
  assert.equal(permissions.can(u, 'registration:create'), true);
  assert.equal(permissions.can(u, 'checkin:perform'), false);
  assert.equal(permissions.can(u, 'checkin:amend'), false,
    'correcting a check-in belongs to the desk that made it');
  assert.equal(permissions.can(u, 'parking:update'), false);
  assert.equal(permissions.can(u, 'dashboard:view'), false);
});

test('§XXXIX manager sees dashboard/calendar/reports but performs no check-in', () => {
  const u = { role: ROLES.MANAGER, salesOfficeId: null };
  for (const p of ['dashboard:view', 'calendar:view', 'registration:view', 'reports:view']) {
    assert.equal(permissions.can(u, p), true, p);
  }
  for (const p of ['checkin:perform', 'status:update', 'parking:update', 'user:manage']) {
    assert.equal(permissions.can(u, p), false, p);
  }
});

test('§XXXIX the administrator manages the system, not the floor', () => {
  const admin = { role: ROLES.ADMINISTRATOR, salesOfficeId: null };
  // Accounts, master data, the opening calendar.
  for (const p of [permissions.P.USER_MANAGE, permissions.P.MASTER_DATA_MANAGE,
    permissions.P.SCHEDULE_BLOCK, permissions.P.CALENDAR_VIEW, permissions.P.AUDIT_VIEW]) {
    assert.equal(permissions.can(admin, p), true, p);
  }
  // And nothing that would show a visitor's name, ID number or phone number.
  for (const p of [permissions.P.REGISTRATION_VIEW, permissions.P.REGISTRATION_SEARCH,
    permissions.P.REGISTRATION_EXPORT, permissions.P.REGISTRATION_CREATE, permissions.P.CHECKIN,
    permissions.P.QR_SCAN, permissions.P.STATUS_UPDATE, permissions.P.PARKING_TICKET_UPDATE,
    permissions.P.DASHBOARD_VIEW, permissions.P.REPORTS_VIEW, permissions.P.CUSTOMER_STATS_VIEW,
    permissions.P.GUIDE_VIEW]) {
    assert.equal(permissions.can(admin, p), false, p);
  }
});

test('§XXXIX only the administrator may close a period, and only desk roles see the guide', () => {
  const roles = Object.values(ROLES).map((role) => ({ role, salesOfficeId: null }));
  assert.deepEqual(
    roles.filter((u) => permissions.can(u, permissions.P.SCHEDULE_BLOCK)).map((u) => u.role),
    [ROLES.ADMINISTRATOR],
  );
  assert.deepEqual(
    roles.filter((u) => permissions.can(u, permissions.P.GUIDE_VIEW)).map((u) => u.role).sort(),
    [ROLES.MANAGER, ROLES.RECEPTIONIST, ROLES.SALES].sort(),
  );
});

test('§XXXIX an anonymous or unknown-role user holds no permission', () => {
  for (const u of [null, undefined, {}, { role: 'GHOST' }]) {
    for (const p of Object.values(permissions.P)) assert.equal(permissions.can(u, p), false);
  }
  assert.throws(() => permissions.assertCan(null, 'checkin:perform'), (e) => e.status === 403);
});

test('§XXV scopeOfficeFor pins reception and sales, frees manager and admin', () => {
  assert.equal(permissions.scopeOfficeFor({ role: ROLES.RECEPTIONIST, salesOfficeId: 'CII_BINH_THANH' }), 'CII_BINH_THANH');
  assert.equal(permissions.scopeOfficeFor({ role: ROLES.SALES, salesOfficeId: 'THUAN_GIAO_BINH_DUONG' }), 'THUAN_GIAO_BINH_DUONG');
  assert.equal(permissions.scopeOfficeFor({ role: ROLES.MANAGER, salesOfficeId: null }), null);
  assert.equal(permissions.scopeOfficeFor({ role: ROLES.ADMINISTRATOR, salesOfficeId: null }), null);
  assert.equal(permissions.scopeOfficeFor(null), null);
});

// ----------------------------------------------- guest category (§A15)

test('§A15 the guest category list is the four the business supplied, and is stable', () => {
  assert.deepEqual(GUEST_CATEGORY_IDS,
    ['BOARD_GUEST', 'SALES_PARTNER', 'CUSTOMER', 'OTHER_PARTNER']);
  // Every value carries both languages, so no screen can fall back to a raw id.
  for (const c of GUEST_CATEGORIES) {
    assert.ok(c.vi && c.en, `${c.id} needs both labels`);
  }
  assert.equal(GUEST_CATEGORIES.find((c) => c.id === 'BOARD_GUEST').vi, 'Khách của HĐQT');
});

test('§A15 guest category is required and must be one of the four', () => {
  const base = {
    language: 'vi', salesOfficeId: 'CII_BINH_THANH', visitorType: 'VISITOR',
    fullName: 'Nguyễn Văn A', cccd: '012345678901', phone: '0901234567',
    numberOfVisitors: 2, visitDate: '2026-10-05', timeSlotId: 'SLOT_0900_1030',
  };

  for (const missing of [undefined, null, '', '   ']) {
    const { errors } = validation.validateRegistrationInput(
      { ...base, guestCategory: missing }, CTX);
    assert.ok(errors.some((e) => e.code === 'GUEST_CATEGORY_REQUIRED'),
      `blank category (${JSON.stringify(missing)}) must be refused`);
  }

  const bad = validation.validateRegistrationInput({ ...base, guestCategory: 'VIP' }, CTX);
  assert.ok(bad.errors.some((e) => e.code === 'INVALID_GUEST_CATEGORY'),
    'a category outside the four is refused rather than stored');

  for (const id of GUEST_CATEGORY_IDS) {
    const ok = validation.validateRegistrationInput({ ...base, guestCategory: id }, CTX);
    assert.deepEqual(ok.errors, [], `${id} is accepted`);
    assert.equal(ok.value.guestCategory, id);
  }
});
