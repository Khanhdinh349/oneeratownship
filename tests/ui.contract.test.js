'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const read = (p) => fs.readFileSync(path.join(PUBLIC, p), 'utf8');

const indexHtml = read('index.html');
const staffHtml = read('staff.html');
const registerJs = read('js/register.js');
const i18nJs = read('js/i18n.js');
const staffJs = read('js/staff.js');
const css = read('css/app.css');

// The i18n module is a browser IIFE; give it a window and pull the export out.
function loadI18n() {
  const sandbox = { window: {}, document: { documentElement: {} } };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', read('js/i18n.js'))(sandbox.window, sandbox.document);
  return sandbox.window.KineraI18n;
}

const { DICT, STATUS_LABELS, createI18n } = loadI18n();

// ===========================================================================
// §III / §XLVI.1 — both languages, complete and consistent
// ===========================================================================

test('§III exactly two languages are shipped', () => {
  assert.deepEqual(Object.keys(DICT).sort(), ['en', 'vi']);
});

test('§III every translation key exists in both languages', () => {
  const vi = Object.keys(DICT.vi).sort();
  const en = Object.keys(DICT.en).sort();
  const missingEn = vi.filter((k) => !(k in DICT.en));
  const missingVi = en.filter((k) => !(k in DICT.vi));
  assert.deepEqual(missingEn, [], 'keys missing from English');
  assert.deepEqual(missingVi, [], 'keys missing from Vietnamese');
});

test('§III no translation is left blank', () => {
  for (const [lang, dict] of Object.entries(DICT)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.ok(typeof value === 'string' && value.trim().length > 0, `${lang}.${key} is empty`);
    }
  }
});

test('§III placeholders match across languages', () => {
  const placeholders = (s) => (s.match(/\{[a-zA-Z]+\}/g) || []).sort();
  for (const key of Object.keys(DICT.vi)) {
    assert.deepEqual(placeholders(DICT.vi[key]), placeholders(DICT.en[key]),
      `placeholder mismatch in "${key}"`);
  }
});

test('§III / §XXIII every status has a label in both languages', () => {
  const { ALL_STATUSES } = require('../src/domain/status');
  for (const lang of ['vi', 'en']) {
    for (const s of ALL_STATUSES) {
      assert.ok(STATUS_LABELS[lang][s], `${lang} is missing a label for ${s}`);
    }
  }
});

test('§III the language switch changes rendered text and survives an unknown code', () => {
  const i18n = createI18n('vi');
  assert.equal(i18n.t('btn.confirm'), 'Xác nhận đăng ký');
  i18n.set('en');
  assert.equal(i18n.lang, 'en');
  assert.equal(i18n.t('btn.confirm'), 'Confirm registration');
  i18n.set('fr');
  assert.equal(i18n.lang, 'en', 'an unsupported language is ignored');
  assert.equal(i18n.t('no.such.key'), 'no.such.key', 'an unknown key falls back to itself');
});

test('§VII the booking-window message interpolates days and both bounds', async () => {
  const i18n = createI18n('vi');
  const msg = i18n.t('visit.window', { days: 10, from: '01/10/2026', to: '11/10/2026' });
  assert.ok(msg.includes('10'));
  assert.ok(msg.includes('01/10/2026'));
  assert.ok(msg.includes('11/10/2026'));
  assert.equal(msg.includes('{'), false, 'no placeholder is left unresolved');
});

test('§VIII a fully-booked label exists in both languages', () => {
  assert.equal(createI18n('vi').t('visit.fullyBooked'), 'Đã hết chỗ');
  assert.equal(createI18n('en').t('visit.fullyBooked'), 'Fully Booked');
});

// ===========================================================================
// §II / §XLVIII — the wizard implements the required lifecycle
// ===========================================================================

// ===========================================================================
// §II — one registration page, with review and confirmation as dialogs
// ===========================================================================

test('§II registration is one page with no intermediate steps at all', async () => {
  assert.equal(/data-step=/.test(indexHtml), false, 'no step sections remain');
  assert.equal(/class="steps"/.test(indexHtml), false, 'no numbered step chips');
  assert.equal(indexHtml.includes('review-modal'), false,
    'no review step — the whole page is already visible before confirming');
  assert.ok(indexHtml.includes('id="success-modal"'), 'confirmation is a dialog');
  assert.match(indexHtml, /id="success-modal"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(css, /\.modal-overlay \{/);
  assert.match(css, /\.modal-overlay\.show \{ display: flex/);
});

test('§III–§V language, office and role sit together at the top of the page', () => {
  const row = indexHtml.slice(indexHtml.indexOf('class="select-row"'),
    indexHtml.indexOf('id="role-form"'));
  for (const id of ['sel-language', 'sel-office', 'sel-type']) {
    assert.ok(row.includes(`id="${id}"`), `${id} is not in the selection row`);
  }
  for (const field of ['language', 'salesOfficeId', 'visitorType']) {
    assert.ok(row.includes(`data-field="${field}"`), `${field} has no field wrapper`);
  }
  assert.match(css, /\.select-row \{[^}]*grid-template-columns: repeat\(3/,
    'the three selections share one row');
  assert.match(css, /\.select--strong/, 'select values are styled like the ONE ERA landing page');
});

test('§V choosing a role reveals that role\'s form on the same page', async () => {
  assert.match(indexHtml, /id="role-form" class="role-form hidden"/, 'it starts hidden');
  assert.match(registerJs, /async function revealRoleForm/);
  assert.match(registerJs, /\$\('#sel-type'\)\.addEventListener\('change'/);
  assert.match(registerJs, /await revealRoleForm\(\)/);
  const fn = registerJs.slice(registerJs.indexOf('async function revealRoleForm'),
    registerJs.indexOf('function field('));
  assert.match(fn, /if \(!state\.draft\.visitorType\) \{[\s\S]*?form\.classList\.add\('hidden'\)/,
    'clearing the role hides the form again');
  assert.match(fn, /renderRoleFields\(\)/);
  assert.match(fn, /loadAvailability\(\)/, 'live availability loads with the form');
  assert.match(css, /\.role-form \{/);
});

test('§V the form title and confirm button change with the role', async () => {
  assert.match(registerJs, /form\.visitor\.title/);
  assert.match(registerJs, /form\.agency\.title/);
  assert.match(registerJs, /btn\.submitAgency/);
  for (const key of ['form.visitor.title', 'form.agency.title', 'btn.submit', 'btn.submitAgency']) {
    for (const lang of ['vi', 'en']) {
      assert.ok(DICT[lang][key], `${lang} is missing ${key}`);
    }
  }
  assert.equal(DICT.vi['form.agency.title'], 'Đăng ký tiếp đón đại lý');
  assert.match(css, /\.form-title \{[\s\S]*?color: var\(--color-sunset\)/,
    'the title uses the sunset accent, as on the existing pages');
});

// ===========================================================================
// field layout — two-column grid plus one grouped visit panel
// ===========================================================================

test('the role fields are laid out two to a row', async () => {
  assert.match(registerJs, /box\.innerHTML = `<div class="form-grid">/);
  assert.match(css, /\.form-grid \{[^}]*grid-template-columns: 1fr 1fr/);
  assert.match(css, /\.form-grid \.span-2 \{ grid-column: span 2/);
  assert.match(registerJs, /span: true/, 'a full-width field is available');
});

test('guests, date and time slot are grouped into one panel', async () => {
  const panel = indexHtml.slice(indexHtml.indexOf('class="visit-panel"'),
    indexHtml.indexOf('id="visit-window"'));
  for (const id of ['f-numberOfVisitors', 'f-visitDate', 'f-timeSlot']) {
    assert.ok(panel.includes(`id="${id}"`), `${id} is not inside the visit panel`);
  }
  assert.match(css, /\.visit-panel \{[\s\S]*?grid-template-columns: \.8fr 1\.1fr 1\.4fr/,
    'three columns, as on the existing pages');
  assert.match(css, /\.visit-panel \{[\s\S]*?background: rgba\(255, 255, 255, \.05\)/,
    'the panel is recessed');
});

test('the confirm button is a full-width sunset action', async () => {
  assert.match(indexHtml, /class="btn btn--accent btn--block btn--lg" id="submit-btn"/);
  assert.match(css, /\.btn--accent \{[\s\S]*?var\(--color-sunset\)/);
});

test('§VI the visitor form carries exactly the specified fields', () => {
  const fn = registerJs.slice(registerJs.indexOf('function renderRoleFields'),
    registerJs.indexOf('function renderAgencyOptions'));
  const visitor = fn.slice(0, fn.indexOf('} else {'));
  for (const f of ['fullName', 'cccd', 'phone', 'email']) {
    assert.ok(visitor.includes(`'${f}'`), `visitor form is missing ${f}`);
  }
  assert.equal(visitor.includes('salesStaffName'), false, 'no agency fields leak in');
});

test('§XII / §XIII the agency form carries agency, staff and masked customer fields', () => {
  const fn = registerJs.slice(registerJs.indexOf('function renderRoleFields'),
    registerJs.indexOf('function renderAgencyOptions'));
  const agency = fn.slice(fn.indexOf('} else {'));
  // agencyId is hand-written markup (a searchable select); the rest go through field().
  assert.match(agency, /data-field="agencyId"/, 'agency form is missing agencyId');
  assert.match(agency, /name="agencyId"/);
  for (const f of ['salesStaffName', 'salesStaffCccd', 'salesStaffPhone',
    'customerShortName', 'customerPhoneLast4']) {
    assert.ok(agency.includes(`'${f}'`), `agency form is missing ${f}`);
  }
  assert.ok(agency.includes('f.section.staff') && agency.includes('f.section.customer'),
    'the two sub-sections are labelled');
  assert.equal(agency.includes("'fullName'"), false, 'no visitor fields leak in');
});

test('§XI the agency selector is searchable and comes from master data', () => {
  assert.ok(registerJs.includes('id="agency-search"'), 'a search box exists');
  assert.match(registerJs, /state\.config\.agencies/, 'options come from /api/config');
  assert.match(registerJs, /function renderAgencyOptions/);
  assert.equal(/IQI|KIM OANH REALTY|VISTALAND/.test(registerJs), false,
    'no agency name is hard-coded into the UI');
});

test('§XXII "Khác" reveals a field for the agency name', () => {
  assert.match(registerJs, /function toggleAgencyOther/);
  assert.match(registerJs, /id="f-agencyName"/, 'the typed name has its own input');
  assert.match(registerJs, /allowsCustomName/,
    'whether an option asks for a name comes from master data, not a hard-coded id');
  assert.match(registerJs, /required\.push\('agencyName'\)/,
    'the typed name is required when "Khác" is chosen');
  for (const key of ['f.agencyOther', 'f.agencyOther.ph', 'f.agencyOther.help', 'field.agencyName']) {
    assert.ok(i18nJs.includes(`'${key}'`), `missing translation key ${key}`);
  }
});

// ===========================================================================
// §VII / §VIII — booking window and slot availability
// ===========================================================================

test('§VII the date input is clamped to the server-declared booking window', () => {
  const fn = registerJs.slice(registerJs.indexOf('function renderDateField'),
    registerJs.indexOf('async function loadAvailability'));
  assert.match(fn, /state\.config\.selectableDates/, 'the range comes from the backend');
  assert.match(fn, /input\.min = dates\[0\]/);
  assert.match(fn, /input\.max = dates\[dates\.length - 1\]/);
  assert.match(fn, /visit\.window/, 'the allowed range is stated in words too');
});

test('§VIII each slot option shows the places left, and a full one cannot be picked', () => {
  const fn = registerJs.slice(registerJs.indexOf('function renderSlotOptions'),
    registerJs.indexOf('function bindVisitPanel'));
  assert.match(fn, /visit\.remaining/, 'remaining places are shown');
  assert.match(fn, /s\.remaining/);
  assert.match(fn, /unavailable \? 'disabled' : ''/, 'an unavailable slot is disabled, not merely styled');
  assert.match(fn, /s\.blocked \|\| s\.fullyBooked \|\| s\.remaining < need/,
    'closed, full and too-small-for-this-party are all unavailable');
  assert.equal(fn.includes('s.booked'), false, 'the registered-guest count is never shown');

  // "Closed" and "fully booked" are different answers and must not be conflated:
  // one sends the visitor to another date, the other to another time that day.
  assert.match(fn, /s\.blockReason/, 'a closed slot says why');
  assert.match(fn, /visit\.dayClosed/, 'a wholly closed day is called out under the field');
});

test('§VIII a slot that fills up is dropped from the selection', () => {
  const fn = registerJs.slice(registerJs.indexOf('function renderSlotOptions'),
    registerJs.indexOf('function bindVisitPanel'));
  assert.match(fn, /if \(state\.draft\.timeSlotId && sel\.value !== state\.draft\.timeSlotId\)/);
  assert.match(fn, /state\.draft\.timeSlotId = ''/);
});

test('§VIII changing the party size re-checks which slots still fit', () => {
  const fn = registerJs.slice(registerJs.indexOf('function bindVisitPanel'),
    registerJs.indexOf('function validatePage'));
  assert.match(fn, /#f-numberOfVisitors'\)\.addEventListener/);
  assert.match(fn, /renderSlotOptions\(\)/);
  assert.match(fn, /#f-visitDate'\)\.addEventListener[\s\S]*?loadAvailability\(\)/,
    'changing the date reloads availability');
});

// ===========================================================================
// §Step 7 — UI states
// ===========================================================================

test('§Step 7 the whole page is validated in one pass', () => {
  const fn = registerJs.slice(registerJs.indexOf('function validatePage'),
    registerJs.indexOf('function openModal'));
  assert.match(fn, /clearAllFieldErrors\(\)/);
  assert.match(fn, /salesOfficeId/);
  assert.match(fn, /visitorType/);
  assert.match(fn, /required\.forEach/, 'the role fields are checked');
  assert.match(fn, /visitDate/);
  assert.match(fn, /timeSlotId/);
  assert.match(fn, /scrollIntoView/, 'the first problem is scrolled into view');
});

test('§Step 7 loading, validation, system error and success states all exist', () => {
  assert.match(registerJs, /visit\.loadingSlots/, 'loading');
  assert.match(registerJs, /function setFieldError/, 'per-field validation error');
  assert.match(registerJs, /function applyServerErrors/, 'server-driven validation error');
  assert.match(registerJs, /err\.network/, 'system error');
  assert.match(registerJs, /function renderSuccess/, 'success');
  assert.match(registerJs, /if \(state\.submitting\) return/, 'double submission is prevented');
  assert.match(registerJs, /btn\.disabled = true/);
  assert.match(css, /\.field\[data-invalid="true"\]/);
  assert.match(css, /\.spinner/);
});

test('§Step 7 a server-side slot conflict clears the slot and reloads availability', async () => {
  const fn = registerJs.slice(registerJs.indexOf('async function submit'),
    registerJs.indexOf('function renderSuccess'));
  assert.match(fn, /TIME_SLOT_FULLY_BOOKED/);
  assert.match(fn, /state\.draft\.timeSlotId = ''/);
  assert.match(fn, /await loadAvailability\(\)/);
  assert.match(fn, /setFieldError\('timeSlotId'/);
});

test('§Step 7 a correction clears the page-level notice', () => {
  assert.match(registerJs, /function dismissNoticeWhenClean/);
  assert.ok(registerJs.split('dismissNoticeWhenClean()').length - 1 >= 5,
    'every editable control clears the notice');
});

// ===========================================================================
// §X / §XVII / §XIX — review and confirmation dialogs
// ===========================================================================

test('§X the confirm button registers directly, with no review step in between', () => {
  const fn = registerJs.slice(registerJs.indexOf("$('#registration-form').addEventListener"),
    registerJs.indexOf("$('#qr-print')"));
  assert.match(fn, /e\.preventDefault\(\)/);
  assert.match(fn, /if \(!validatePage\(\)\) return/, 'nothing is sent until the page is valid');
  assert.match(fn, /submit\(\)/);
  assert.equal(registerJs.includes('renderReview'), false, 'the review renderer is gone');
  assert.equal(registerJs.includes('review-modal'), false);
});

test('§XIX the success dialog is the only thing that opens over the page', () => {
  const opens = [...registerJs.matchAll(/openModal\('#([\w-]+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(opens)], ['success-modal']);
});

test('§XIX the success dialog shows the code, the QR, the summary and the instruction', () => {
  const modal = indexHtml.slice(indexHtml.indexOf('id="success-modal"'));
  assert.ok(modal.includes('id="success-code"'), 'confirmation code');
  assert.ok(modal.includes('id="success-qr"'), 'QR code');
  assert.ok(modal.includes('id="success-summary"'), 'summary');
  assert.ok(modal.includes('success.instruction'), 'the keep-your-QR instruction');
  for (const id of ['qr-download', 'qr-print', 'go-home']) {
    assert.ok(modal.includes(`id="${id}"`), `§XIX action ${id} is missing`);
  }
});

test('§Rule 2 one draft object holds the page, so switching role loses nothing', () => {
  assert.match(registerJs, /draft: \{/);
  assert.match(registerJs, /state\.draft\[el\.name\] = el\.value/,
    'every keystroke is persisted into the draft');
  const reveal = registerJs.slice(registerJs.indexOf('async function revealRoleForm'),
    registerJs.indexOf('function field('));
  assert.equal(/state\.draft\s*=\s*\{/.test(reveal), false, 'the draft is never re-initialised');
});

test('§Rule 3 the page never shows technical identifiers to the visitor', () => {
  assert.match(registerJs, /\$\('#success-code'\)\.textContent = r\.confirmationCode/);
  assert.equal(registerJs.includes('qrToken'), false,
    'the raw QR token is never touched; the server-issued image URL is used');
  assert.match(registerJs, /\$\('#success-qr'\)\.src = r\.qrImageUrl/);
});

test('§XLV the registration UI is mobile-first', () => {
  assert.match(indexHtml, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(css, /\.form-grid \{ grid-template-columns: 1fr; gap: 0; \}/,
    'the field grid collapses on a phone');
  assert.match(css, /\.visit-panel \{ grid-template-columns: 1fr; padding: 1rem; \}/);
  assert.match(css, /\.select-row \{ grid-template-columns: 1fr; \}/);
});

test('§XXV the staff area gates everything behind a login view', () => {
  assert.ok(staffHtml.includes('id="login-view"'));
  assert.ok(staffHtml.includes('id="staff-view"'));
  assert.match(staffJs, /function showLogin/);
  assert.match(staffJs, /Authorization = `Bearer \$\{state\.token\}`/);
  assert.match(staffJs, /if \(res\.status === 401 && state\.token\) \{ signOut\(\); \}/,
    'an expired session returns the user to the login screen');
});

test('§XXXIX staff tabs are rendered from the permissions the server returned', () => {
  // Every tab is gated by a permission the server returned — none is ungated,
  // so a role that lacks a permission never sees the tab at all.
  assert.match(staffJs, /TABS\.filter\(\(t\) => has\(t\.permission\)\)/);
  assert.match(staffJs, /const has = \(permission\) => Boolean\(state\.session && state\.session\.permissions\.includes/);
  const tabs = staffJs.slice(staffJs.indexOf('const TABS = ['), staffJs.indexOf('const state = {'));
  for (const p of ['checkin:perform', 'registration:view', 'dashboard:view', 'calendar:view',
    'customer-stats:view', 'guide:view', 'user:manage', 'schedule:block']) {
    assert.ok(tabs.includes(p), `tab permission ${p} is missing`);
  }
  assert.equal(/permission: null/.test(tabs), false, 'no tab may be ungated');

  // The administrator's screen is account management and the opening calendar.
  const adminTabs = ['user:manage', 'schedule:block', 'calendar:view'];
  for (const p of adminTabs) assert.ok(tabs.includes(p));
});

test('§XXVI the reception screen offers both QR scan and free-text search', () => {
  assert.ok(staffHtml.includes('id="scan-input"'), 'manual entry / QR paste');
  assert.ok(staffHtml.includes('id="camera-btn"'), 'camera scan');
  assert.match(staffJs, /\/api\/staff\/checkin\/lookup/, 'one endpoint handles every query kind');
});

test('§XXVI Option 2 the desk search accepts every identifier the spec lists', () => {
  // The query goes to the backend verbatim; the backend decides what it is.
  const fn = staffJs.slice(staffJs.indexOf('async function resolve'),
    staffJs.indexOf('function renderMatches'));
  assert.match(fn, /body: JSON\.stringify\(\{ query \}\)/);
  assert.match(fn, /res\.mode === 'single'/);
  assert.match(fn, /res\.mode === 'multiple'/);
  assert.match(fn, /Không tìm thấy đăng ký/, 'a miss says so plainly');
  assert.equal(fn.includes('confirmationCode: '), false,
    'the box no longer assumes the text is a confirmation code');
});

test('§XXVI several matches produce a pick-list rather than an error', () => {
  assert.match(staffJs, /function renderMatches/);
  const fn = staffJs.slice(staffJs.indexOf('function renderMatches'),
    staffJs.indexOf('function renderCheckinDetail'));
  assert.match(fn, /data-pick="/, 'each match is selectable');
  assert.match(fn, /confirmationCode/, 'matches are identified by their code');
  assert.match(fn, /statusBadge\(r\.status\)/, 'each match shows its status');
});

test('§XXVII the check-in panel shows registration plus visitor-or-agency details', () => {
  assert.match(staffJs, /Registration Found/, '§XLIII');
  for (const label of ['Mã xác nhận', 'Văn phòng', 'Ngày tham quan', 'Khung giờ']) {
    assert.ok(staffJs.includes(label), `check-in detail is missing ${label}`);
  }
  assert.match(staffJs, /r\.agency\.customerPhoneLast4/, '§XXVII agency view shows only the last 4 digits');
  assert.equal(staffJs.includes('r.agency.customerPhone)'), false, 'no full customer phone is ever rendered');
});

test('§XLIII a one-click CHECK IN action exists and reports success', () => {
  assert.match(staffJs, /id="do-checkin"/);
  assert.match(staffJs, />CHECK IN</);
  assert.match(staffJs, /✓ Check-in Successful/);
  assert.match(staffJs, /\/checkin`/);
});

test('§Step 7 the reception screen renders each blocking readiness reason', () => {
  for (const code of ['ALREADY_CHECKED_IN', 'CANCELLED', 'NO_SHOW', 'WRONG_OFFICE',
    'FUTURE_VISIT_DATE', 'PAST_VISIT_DATE']) {
    assert.ok(staffJs.includes(code), `the UI does not handle readiness reason ${code}`);
  }
  assert.match(staffJs, /Không thể check-in ngay/);
  assert.match(staffJs, /overridable/, 'a wrong-day check-in offers an explicit override');
});

test('§XXIX parking-ticket controls appear only when the office supports them', () => {
  assert.match(staffJs, /r\.parkingTicketApplicable \? renderParkingControls\(r\) : ''/);
  const fn = staffJs.slice(staffJs.indexOf('function renderParkingControls'),
    staffJs.indexOf('function bindParkingControls'));
  assert.match(fn, /\['CHECKED_IN', 'IN_VISIT', 'COMPLETED'\]\.includes\(r\.status\)/,
    'tickets are only editable after check-in');
  assert.match(fn, /has\('parking:update'\)/);
});

test('§XXIX cars and motorbikes are counted and issued separately', () => {
  assert.match(staffJs, /const VEHICLES = \[/);
  for (const t of ['CAR', 'MOTORBIKE']) {
    assert.ok(staffJs.includes(`'${t}'`), `${t} is missing from the desk UI`);
  }
  const fn = staffJs.slice(staffJs.indexOf('function renderParkingControls'),
    staffJs.indexOf('function bindParkingControls'));
  assert.match(fn, /VEHICLES\.map/, 'one counter per vehicle type');
  assert.match(fn, /data-issue="\$\{v\.type\}"/, 'each type has its own issue button');
  assert.match(fn, /pt-num-\$\{v\.type\}/, 'each type has its own ticket-number box');
  assert.match(fn, /byVehicleType\[v\.type\]/, 'counts come from the per-type breakdown');
  assert.match(css, /\.vehicle-grid \{/);
  assert.match(css, /\.vehicle-card \{/);
});

test('§XXIX every issued ticket can be returned or removed individually', () => {
  const fn = staffJs.slice(staffJs.indexOf('function renderParkingControls'),
    staffJs.indexOf('// §XXIII'));
  assert.match(fn, /data-return="/, 'an outstanding ticket can be taken back');
  assert.match(fn, /data-del="/, 'a ticket issued in error can be removed');
  assert.match(fn, /parking-tickets\/\$\{encodeURIComponent\(b\.dataset\.return\)\}\/return/);
  assert.match(fn, /t\.returnedAt/, 'the list shows which tickets are still out');
});

// ===========================================================================
// §XXVIII — confirming the arrival count at the desk
// ===========================================================================

test('§XXVIII the desk confirms how many guests arrived before checking in', () => {
  assert.match(staffJs, /function renderGuestCheck/);
  assert.match(staffJs, /function bindGuestCheck/);
  const fn = staffJs.slice(staffJs.indexOf('function renderGuestCheck'),
    staffJs.indexOf('function bindGuestCheck'));
  assert.match(fn, /id="guest-count"/, 'the count is an input the receptionist can change');
  assert.match(fn, /const start = Math\.min\(booked, max\)/,
    'it is pre-filled with the booked number, or with the most the slot can still take');
  assert.match(fn, /value="\$\{start\}"/);
  assert.match(fn, /ready\.capacity\.maxGuests/, 'the stepper stops at the slot\'s real limit');
  assert.match(fn, /id="guest-minus"/);
  assert.match(fn, /id="guest-plus"/);
  assert.match(fn, /Đã đăng ký/, 'the booked number is shown for comparison');
  assert.match(css, /\.guest-check \{/);
});

test('§XXVIII the confirmation panel appears only when check-in is possible', () => {
  assert.match(staffJs, /\$\{\(ready\.canCheckIn \|\| overridable\) \? renderGuestCheck\(r, ready\) : ''\}/,
    'an already-checked-in or cancelled visitor is not asked for a count');
});

test('the desk is shown arrival timing and the slot limit before check-in', () => {
  assert.match(staffJs, /function renderTiming/);
  for (const code of ['ARRIVED_EARLY', 'ARRIVED_AFTER_SLOT', 'SLOT_FULL']) {
    assert.ok(staffJs.includes(`case '${code}'`), `${code} has Vietnamese wording`);
  }
  // Early / after-slot arrivals can be confirmed; a full slot never can.
  const overridable = /const OVERRIDABLE = \[([^\]]+)\]/.exec(staffJs)[1];
  assert.ok(overridable.includes('ARRIVED_EARLY') && overridable.includes('ARRIVED_AFTER_SLOT'));
  assert.equal(overridable.includes('SLOT_FULL'), false, 'the 30-guest limit has no override');
  assert.match(staffJs, /allowTimeOverride: allowDateOverride/);
  assert.match(staffJs, /Vượt sức chứa/, 'going over the limit is called out before the server refuses');
});

test('a slot that has ended is greyed out on the booking form', () => {
  const fn = registerJs.slice(registerJs.indexOf('function renderSlotOptions'),
    registerJs.indexOf('function bindVisitPanel'));
  assert.match(fn, /s\.passed \|\| s\.blocked \|\| s\.fullyBooked/, 'a passed slot cannot be selected');
  assert.match(fn, /visit\.passed/, 'and says why');
});

test('a first sign-in is taken to the password change before the app opens', () => {
  assert.ok(staffHtml.includes('id="pwchange-form"'));
  assert.match(staffJs, /if \(res\.mustChangePassword\) \{/);
  assert.match(staffJs, /PASSWORD_CHANGE_REQUIRED/, 'a refused call sends the user back to sign-in');
  assert.equal(/sessionStorage\.setItem\([^)]*assignedPassword/.test(staffJs), false,
    'the assigned password is held in memory only');
  assert.ok(staffJs.includes('Chờ đổi mật khẩu'), 'the administrator sees who still owes a change');
  for (const a of ['ONLINE', 'TODAY', 'RECENT', 'DORMANT', 'NEVER']) {
    assert.ok(staffJs.includes(`${a}: [`), `activity ${a} has a label`);
  }
});

test('§XXVIII a mismatch is called out rather than silently accepted', () => {
  const fn = staffJs.slice(staffJs.indexOf('function bindGuestCheck'),
    staffJs.indexOf('// §XXIX'));
  assert.match(fn, /const diff = n - booked/);
  assert.match(fn, /Khớp với đăng ký/, 'a match is confirmed');
  assert.match(fn, /Lệch/, 'a difference is flagged');
  assert.match(fn, /n < 1/, 'zero or negative is rejected in the UI too');
});

test('§XXVIII the confirmed count is sent with the check-in', () => {
  const fn = staffJs.slice(staffJs.indexOf('async function doCheckin'),
    staffJs.indexOf('// §XXIX'));
  assert.match(fn, /actualGuests: Number\(\$\('#guest-count'\)/);
  assert.match(fn, /res\.guests && !res\.guests\.matches/,
    'the receptionist is told when the arrival differed from the booking');
});

test('§XXIII status buttons offer only the transitions the backend allows', () => {
  const src = staffJs.slice(staffJs.indexOf('const NEXT_STATUSES'), staffJs.indexOf('function renderStatusControls'));
  // eslint-disable-next-line no-new-func
  const uiMap = new Function(`${src}; return NEXT_STATUSES;`)();
  const { TRANSITIONS } = require('../src/domain/status');
  for (const [from, allowed] of Object.entries(uiMap)) {
    for (const to of allowed) {
      assert.ok(TRANSITIONS[from].includes(to),
        `the UI offers ${from} → ${to} but the backend forbids it`);
    }
  }
});

test('§XXXVIII the registration table has every specified column', () => {
  for (const header of ['Mã xác nhận', 'Đối tượng', 'Khách / Đại lý', 'Nhân viên Sales',
    'Văn phòng', 'Ngày', 'Khung giờ', 'SL', 'Trạng thái', 'Check-in', 'Phiếu xe', 'Lễ tân', 'Thao tác']) {
    assert.ok(staffHtml.includes(`>${header}<`), `column "${header}" is missing`);
  }
});

test('§XXXVIII the list offers search, every filter, sorting and pagination', () => {
  for (const id of ['flt-search', 'flt-from', 'flt-to', 'flt-office', 'flt-type',
    'flt-status', 'flt-parking', 'reg-prev', 'reg-next']) {
    assert.ok(staffHtml.includes(`id="${id}"`), `control ${id} is missing`);
  }
  assert.match(staffHtml, /data-sort="visit_date"/, 'sortable column headers');
  assert.match(staffJs, /state\.regQuery\.sortDir = /, 'sort direction toggles');
  assert.match(staffJs, /function debounce/, 'search is debounced');
});

test('§XXX the dashboard renders every specified KPI', () => {
  for (const kpi of ['Total Registration', "Today's Visitors", 'Expected', 'Checked-in',
    'Completed', 'No Show', 'Cancelled']) {
    assert.ok(staffJs.includes(kpi), `KPI "${kpi}" is missing`);
  }
});

test('§XXXI–§XXXIV the dashboard renders all four analysis sections', () => {
  for (const id of ['dash-funnel', 'dash-office-table', 'dash-type-table', 'dash-slot-table', 'dash-parking']) {
    assert.ok(staffHtml.includes(`id="${id}"`), `dashboard section ${id} is missing`);
  }
  assert.match(staffJs, /classList\.toggle\('hidden', d\.parkingTickets\.length === 0\)/,
    '§XXXIV the parking card hides when the office does not track tickets');
});

test('§XXXV the calendar offers day, week and month views through a switch', () => {
  for (const view of ['day', 'week', 'month']) {
    assert.match(staffHtml, new RegExp(`data-view="${view}"`), `${view} view button`);
  }
  assert.match(staffHtml, /data-view="month" aria-pressed="true"/, 'month is the default view');
  assert.match(staffJs, /if \(data\.view === 'month'\)/, 'a month grid is rendered');
  assert.match(css, /\.cal-grid/);
  assert.match(css, /\.viewswitch/);
});

test('§XXXV the calendar has prev / next / today navigation wired to the period', () => {
  for (const id of ['cal-prev', 'cal-next', 'cal-today', 'cal-label']) {
    assert.ok(staffHtml.includes(`id="${id}"`), `navigation control ${id} is missing`);
  }
  assert.match(staffJs, /function shiftCalendar/);
  assert.match(staffJs, /\$\('#cal-prev'\)\.addEventListener\('click', \(\) => shiftCalendar\(-1\)\)/);
  assert.match(staffJs, /\$\('#cal-next'\)\.addEventListener\('click', \(\) => shiftCalendar\(1\)\)/);
  assert.match(staffJs, /state\.calendar\.date = state\.config\.today/, 'Today returns to the current period');
});

test('§XXXV each view steps by its own period length', () => {
  const src = staffJs.slice(staffJs.indexOf('const DAY_MS'), staffJs.indexOf('function bindCalendar'));
  // eslint-disable-next-line no-new-func
  const api = new Function(`${src}
    const state = { calendar: { view: 'day', date: '2026-10-15' } };
    const closePopover = () => {}; const loadCalendar = () => {};
    return { addDays, addMonths, step(view, date, dir) {
      state.calendar = { view, date };
      shiftCalendar(dir);
      return state.calendar.date;
    } };`)();

  assert.equal(api.step('day', '2026-10-15', 1), '2026-10-16', 'day + 1');
  assert.equal(api.step('day', '2026-10-01', -1), '2026-09-30', 'day - 1 crosses the month');
  assert.equal(api.step('week', '2026-10-15', 1), '2026-10-22', 'week + 1');
  assert.equal(api.step('week', '2026-10-15', -1), '2026-10-08', 'week - 1');
  assert.equal(api.step('month', '2026-10-15', 1).slice(0, 7), '2026-11', 'month + 1');
  assert.equal(api.step('month', '2026-01-15', -1).slice(0, 7), '2025-12', 'month - 1 crosses the year');
});

test('§XXXVI a calendar event shows the specified fields', () => {
  assert.match(staffJs, /data-ev="\$\{esc\(ev\.registrationId\)\}"/, 'the event carries its registration id');
  const row = staffJs.slice(staffJs.indexOf('function evRow'), staffJs.indexOf('function closePopover'));
  for (const field of ['timeLabel', 'title', 'subtitle', 'numberOfVisitors',
    'salesOfficeName', 'confirmationCode', 'status']) {
    assert.ok(row.includes(field), `calendar event is missing ${field}`);
  }
});

test('§XXXVI clicking an event opens an information window in place', () => {
  assert.match(staffJs, /openEventPopover\(b, b\.dataset\.ev\)/, 'the click opens a popover, not another tab');
  assert.match(staffJs, /e\.stopPropagation\(\)/, 'the click does not bubble to the dismiss handler');
  const pop = staffJs.slice(staffJs.indexOf('async function openEventPopover'));
  for (const field of ['confirmationCode', 'timeLabel', 'numberOfVisitors', 'salesOfficeName', 'status']) {
    assert.ok(pop.includes(field), `the popover is missing ${field}`);
  }
  assert.match(pop, /pop\.style\.left/, 'the popover is positioned at the event');
  assert.match(pop, /pop\.style\.top/);
  assert.match(pop, /host\.clientWidth/, 'it is kept inside the calendar body');
  assert.match(pop, /data-open-full/, 'it offers a route to the full registration');
  assert.match(css, /\.popover \{/);
});

test('§XXXVI the popover can be dismissed by close button, backdrop or Escape', () => {
  assert.match(staffJs, /function closePopover/);
  assert.match(staffJs, /backdrop\.addEventListener\('click', closePopover\)/, 'click-away closes it');
  assert.match(staffJs, /popover__close'\)\.addEventListener\('click', closePopover\)/, 'the × closes it');
  assert.match(staffJs, /if \(e\.key === 'Escape'\) closePopover\(\)/, 'Escape closes it');
  assert.match(staffJs, /\$\$\('\.popover, \.popover__backdrop'\)\.forEach\(\(el\) => el\.remove\(\)\)/,
    'closing removes both the popover and its backdrop');
});

test('§XXXVII every live view refreshes on the server-declared one-minute cadence', () => {
  assert.match(staffJs, /setInterval\(refresh, state\.config\.rules\.autoRefreshMs\)/);
  const refresh = staffJs.slice(staffJs.indexOf('async function refresh'), staffJs.indexOf('// ====', staffJs.indexOf('async function refresh')));
  for (const view of ['loadOfficeSummary', 'loadRegistrations', 'loadDashboard', 'loadCalendar']) {
    assert.ok(refresh.includes(view), `${view} is not part of the refresh cycle`);
  }
  assert.equal(/location\.reload\(\)/.test(refresh), false, '§XXXVII no full page reload is used');
});

test('§XXXVII the refresh interval is a minute, not a hard-coded guess', () => {
  const { AUTO_REFRESH_MS } = require('../src/config/master-data');
  assert.equal(AUTO_REFRESH_MS, 60000);
});

// ===========================================================================
// output safety
// ===========================================================================

test('every dynamic value rendered into HTML is escaped', () => {
  for (const [name, src] of [['register.js', registerJs], ['staff.js', staffJs]]) {
    assert.match(src, /const esc = /, `${name} defines an escaper`);
    assert.match(src, /replace\(\/\[&<>"'\]\/g/, `${name} escapes the five HTML metacharacters`);
  }
});

test('user-supplied fields are escaped where they reach innerHTML', () => {
  // Any template interpolation that READS a name/note off a data object (r.x, d.x,
  // ev.x, s.x, o.x, a.x) must pass through esc(). Calls into the field builders,
  // which escape internally, are not property reads and are excluded by the pattern.
  const risky = ['fullName', 'agencyName', 'salesStaffName', 'customerShortName',
    'customerPhoneLast4', 'notes', 'title', 'subtitle', 'name', 'label'];
  let checked = 0;
  for (const [file, src] of [['register.js', registerJs], ['staff.js', staffJs]]) {
    for (const field of risky) {
      const re = new RegExp(`\\$\\{[^{}]*\\b[a-zA-Z_$][\\w$]*\\.${field}\\b[^{}]*\\}`, 'g');
      for (const [use] of src.matchAll(re)) {
        checked += 1;
        assert.ok(use.includes('esc(') || use.includes('statusBadge('),
          `unescaped interpolation in ${file}: ${use}`);
      }
    }
  }
  assert.ok(checked > 20, `the scan should find many interpolations, found ${checked}`);
});

test('§XXVI QR scanning works on a laptop, in every browser', () => {
  // A reception desk is a laptop with a built-in or USB webcam, not a phone.
  assert.equal(/facingMode: 'environment'/.test(staffJs), false,
    'a bare environment constraint has no rear camera to match on a laptop');
  assert.match(staffJs, /facingMode: \{ ideal: 'environment' \}/,
    'a rear camera is preferred but never required');
  assert.match(staffJs, /\{ video: true \}/, 'and there is a fallback to any camera at all');

  // Safari and Firefox have no BarcodeDetector, so a decoder ships with the app.
  assert.match(staffJs, /'BarcodeDetector' in window/);
  assert.match(staffJs, /window\.jsQR/, 'jsQR is the fallback decoder');
  assert.ok(staffHtml.includes('/js/vendor/jsQR.js'), 'the decoder is served from this origin');
  assert.equal(/https?:\/\/[^"']*jsqr/i.test(staffHtml), false,
    'never from a CDN: script-src is self, and the desk must work without third parties');

  // Several cameras, and hot-plugging one.
  assert.match(staffJs, /enumerateDevices/);
  assert.match(staffJs, /deviceId: \{ exact: deviceId \}/);
  assert.match(staffJs, /addEventListener\('devicechange'/);
  assert.ok(staffHtml.includes('id="camera-device"'), 'the page offers a camera picker');

  // Every failure mode gets its own instruction rather than a raw DOMException.
  for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError']) {
    assert.ok(staffJs.includes(name), `${name} is handled explicitly`);
  }
  assert.match(staffJs, /isSecureContext/, 'an http:// page is explained, not just broken');

  // The tracks must be stopped, or the camera light stays on after a check-in.
  assert.match(staffJs, /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
});

test('the deployment sends the same security headers as the app', () => {
  // The HTML and JS are served by Vercel's CDN, which never runs the Express
  // middleware — so the headers have to be declared for the static side too, or
  // the pages arrive with no CSP and no Permissions-Policy at all.
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const all = (vercel.headers || []).find((h) => h.source === '/(.*)');
  assert.ok(all, 'a catch-all header rule covers every static response');
  const byKey = Object.fromEntries(all.headers.map((h) => [h.key, h.value]));

  assert.match(byKey['Content-Security-Policy'], /script-src 'self'/);
  assert.match(byKey['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.equal(byKey['X-Content-Type-Options'], 'nosniff');
  assert.equal(byKey['X-Frame-Options'], 'DENY');
  // The desk scans QR codes with the webcam, so the camera must be allowed —
  // for this origin and nothing else.
  assert.match(byKey['Permissions-Policy'], /camera=\(self\)/);
  assert.match(byKey['Permissions-Policy'], /microphone=\(\)/);
});

test('the staff page never stores credentials, only the session token', () => {
  assert.equal(/sessionStorage\.setItem\('kinera\.(password|user)/.test(staffJs), false);
  assert.match(staffJs, /sessionStorage\.setItem\('kinera\.token'/);
  assert.match(staffJs, /sessionStorage\.removeItem\('kinera\.token'\)/, 'sign-out clears it');
});


// ===========================================================================
// staff sign-in regressions
// ===========================================================================

test('a failed sign-in shows its error instead of reloading the page', () => {
  // A 401 from the sign-in call itself must not trigger signOut(), because
  // signOut() reloads and would wipe the message before it could be read.
  assert.match(staffJs, /res\.status === 401 && state\.token/,
    'the 401 handler is guarded by an existing session');
  assert.match(staffJs, /Sai tài khoản hoặc mật khẩu/, 'the message is localized');
  assert.match(staffJs, /el\.classList\.remove\('hidden'\)/, 'the error region is revealed');
  assert.match(staffJs, /\$\('#login-password'\)\.value = ''/, 'the password field is cleared');
});

test('inputs are styled by element so a type-less input is not browser-default', () => {
  // #login-username and #scan-input carry no type attribute; an [type="text"]
  // selector would skip them and leave a white browser-chrome box.
  assert.match(css, /input:not\(\[type="checkbox"\]\)/,
    'the field rule matches inputs regardless of the type attribute');
  for (const html of [staffHtml, indexHtml]) {
    const typeless = [...html.matchAll(/<input(?![^>]*\stype=)[^>]*id="([\w-]+)"/g)].map((m) => m[1]);
    typeless.forEach((id) => assert.ok(id, `type-less input #${id} relies on the element rule`));
  }
  assert.match(css, /input:-webkit-autofill/, 'autofill keeps the dark field styling');
});

test('disabled fields are styled rather than left looking broken', () => {
  assert.match(css, /input:disabled, select:disabled, textarea:disabled/);
});
