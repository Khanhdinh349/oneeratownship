'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  startServer, visitorPayload, agencyPayload, CREDS, OFFICE_CII, OFFICE_TG,
  SLOT_A, SLOT_B, SLOT_1030,
} = require('./helpers');
const { buildWorkbook, excelSerial, plainDate, columnName, STYLE } = require('../src/export/xlsx');
const { buildRegistrationWorkbook, reportFilename } = require('../src/export/reports');
const { CustomerStatsService } = require('../src/services/customer-stats.service');
const { MATRIX, P, can } = require('../src/domain/permissions');
const { ROLES, REPORT_UTC_OFFSET_MINUTES } = require('../src/config/master-data');

// ---------------------------------------------------------------- zip reading
//
// The export has to be a real .xlsx, not merely bytes that we agree to call one.
// These helpers read the parts back out of the ZIP so the assertions look at what
// Excel would actually open.

function readZip(buffer) {
  const files = new Map();
  // Walk the central directory backwards from the end-of-central-directory record.
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  assert.ok(eocd >= 0, 'no end-of-central-directory record: not a ZIP file');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'bad central directory header');
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);

    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compressed);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw);

    files.set(name, { data, crc });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const part = (buffer, name) => {
  const files = readZip(buffer);
  assert.ok(files.has(name), `missing part ${name}`);
  return files.get(name).data.toString('utf8');
};

/** Cell values of one row, in document order, as raw strings. */
function rowCells(sheetXml, rowNumber) {
  const row = new RegExp(`<row r="${rowNumber}">(.*?)</row>`, 's').exec(sheetXml);
  if (!row) return null;
  return Array.from(row[1].matchAll(/<c r="[A-Z]+\d+"[^>]*?(?:\/>|>(.*?)<\/c>)/gs))
    .map((m) => {
      if (m[1] === undefined) return null;
      const inline = /<t[^>]*>(.*?)<\/t>/s.exec(m[1]);
      if (inline) return inline[1];
      const v = /<v>(.*?)<\/v>/s.exec(m[1]);
      return v ? v[1] : null;
    });
}

/**
 * openpyxl is the independent check: if it can open the file and agrees about the
 * values, the file is genuinely well-formed OOXML and not just self-consistent.
 * Skipped when it is not installed, so the suite still runs anywhere.
 */
function openpyxlAvailable() {
  try {
    execFileSync('python3', ['-c', 'import openpyxl'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function inspectWithOpenpyxl(buffer) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kinera-xlsx-')), 'book.xlsx');
  fs.writeFileSync(file, buffer);
  const script = `
import json, openpyxl, sys
wb = openpyxl.load_workbook(sys.argv[1])
out = {"sheets": wb.sheetnames, "data": {}}
for name in wb.sheetnames:
    ws = wb[name]
    out["data"][name] = {
        "freeze": ws.freeze_panes,
        "filter": ws.auto_filter.ref,
        "rows": [[(v.isoformat() if hasattr(v, "isoformat") else v) for v in row]
                 for row in ws.iter_rows(values_only=True)],
        "formats": [c.number_format for c in next(ws.iter_rows(min_row=2), [])],
    }
print(json.dumps(out))
`;
  const out = execFileSync('python3', ['-c', script, file], { encoding: 'utf8', maxBuffer: 64e6 });
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  return JSON.parse(out);
}

// ============================================================ the xlsx writer

test('xlsx writer: produces a workbook Excel can open', async (t) => {
  const created = new Date('2026-10-01T03:00:00Z');
  const buffer = buildWorkbook([{
    name: 'Dữ liệu',
    columns: [
      { header: 'Chuỗi', width: 20 },
      { header: 'Ngày', style: STYLE.DATE },
      { header: 'Thời điểm', style: STYLE.DATETIME },
      { header: 'Số nguyên', style: STYLE.INTEGER },
      { header: 'Tỷ lệ', style: STYLE.PERCENT },
    ],
    rows: [
      ['Nguyễn Văn A <&> "ký tự"', plainDate('2026-10-05'), new Date('2026-10-01T03:30:00Z'), 7, 0.5],
      [null, null, null, 0, 0],
    ],
  }], { created, tzOffsetMinutes: REPORT_UTC_OFFSET_MINUTES });

  const files = readZip(buffer);
  for (const required of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(files.has(required), `missing ${required}`);
  }

  const sheet = part(buffer, 'xl/worksheets/sheet1.xml');
  assert.match(sheet, /state="frozen"/, 'the header row must stay in view');
  assert.match(sheet, /<autoFilter ref="A1:E3"\/>/);

  // Markup characters survive as text rather than breaking the XML.
  assert.equal(rowCells(sheet, 2)[0], 'Nguyễn Văn A &lt;&amp;&gt; &quot;ký tự&quot;');
  // A null is a blank cell, not the string "null" and not a zero.
  assert.deepEqual(rowCells(sheet, 3).slice(0, 3), [null, null, null]);

  await t.test('timestamps are written in the report timezone, not the server one', async () => {
    // 03:30 UTC is 10:30 in Vietnam, so the fraction of the day must be 10.5/24.
    const serial = Number(rowCells(sheet, 2)[2]);
    const fraction = serial - Math.floor(serial);
    assert.ok(Math.abs(fraction - 10.5 / 24) < 1e-9, `got fraction ${fraction}`);
    // A calendar day, by contrast, is written exactly as given: a whole serial,
    // with no drift onto the day before or after whatever zone reads it back.
    assert.equal(Number(rowCells(sheet, 2)[1]) % 1, 0);
  });

  await t.test('an invalid Date is a blank cell, never NaN', async () => {
    const bad = buildWorkbook([{ name: 'S', columns: [{ header: 'D', style: STYLE.DATE }], rows: [[new Date('nope')]] }]);
    assert.equal(rowCells(part(bad, 'xl/worksheets/sheet1.xml'), 2)[0], null);
  });

  await t.test('sheet names are made legal and unique', async () => {
    const book = buildWorkbook([
      { name: 'Thống kê/khách [2026]:*?', columns: [{ header: 'A' }], rows: [] },
      { name: 'Trùng tên', columns: [{ header: 'A' }], rows: [] },
      { name: 'Trùng tên', columns: [{ header: 'A' }], rows: [] },
    ]);
    const names = Array.from(part(book, 'xl/workbook.xml').matchAll(/<sheet name="([^"]+)"/g))
      .map((m) => m[1]);
    assert.equal(names.length, 3);
    assert.ok(!names.some((n) => /[\\/?*[\]:]/.test(n)), `illegal characters in ${names}`);
    assert.ok(!names.some((n) => n.length > 31));
    assert.equal(new Set(names).size, 3, 'duplicate sheet names would make Excel refuse the file');
  });

  await t.test('an empty workbook is refused rather than written corrupt', async () => {
    assert.throws(() => buildWorkbook([]), /at least one sheet/);
  });

  await t.test('column references keep going past Z', async () => {
    assert.equal(columnName(0), 'A');
    assert.equal(columnName(25), 'Z');
    assert.equal(columnName(26), 'AA');
    assert.equal(columnName(51), 'AZ');
    assert.equal(columnName(702), 'AAA');
  });

  await t.test('serial dates match the epoch Excel uses', async () => {
    // 1900-01-01 is serial 1 in Excel's (deliberately off-by-one) calendar.
    assert.equal(excelSerial(new Date('1900-01-01T00:00:00Z')), 2);
    assert.equal(excelSerial(new Date('1970-01-01T00:00:00Z')), 25569);
  });
});

test('xlsx writer: openpyxl reads back exactly what was written', { skip: !openpyxlAvailable() }, () => {
  const buffer = buildWorkbook([{
    name: 'Kiểm thử',
    columns: [
      { header: 'Tên', width: 24 },
      { header: 'Ngày', style: STYLE.DATE },
      { header: 'Số', style: STYLE.INTEGER },
      { header: 'Tỷ lệ', style: STYLE.PERCENT },
    ],
    rows: [['Trần Thị Bích', plainDate('2026-10-05'), 12, 0.875]],
  }], { tzOffsetMinutes: REPORT_UTC_OFFSET_MINUTES });

  const wb = inspectWithOpenpyxl(buffer);
  assert.deepEqual(wb.sheets, ['Kiểm thử']);
  const sheet = wb.data['Kiểm thử'];
  assert.deepEqual(sheet.rows[0], ['Tên', 'Ngày', 'Số', 'Tỷ lệ']);
  assert.equal(sheet.rows[1][0], 'Trần Thị Bích');
  assert.match(sheet.rows[1][1], /^2026-10-05T00:00:00$/, 'the date must not drift a day');
  assert.equal(sheet.rows[1][2], 12);
  assert.equal(sheet.rows[1][3], 0.875);
  assert.equal(sheet.freeze, 'A2');
  assert.deepEqual(sheet.formats.slice(1), ['dd/mm/yyyy', '0', '0.0%']);
});

// ====================================================== the two export reports

/**
 * A small but realistic dataset: a repeat customer, two agencies, a check-in that
 * arrived short, a no-show and a cancellation — enough for every statistic to have
 * a value that can be checked by hand.
 */
async function seedScenario() {
  const server = await startServer();
  try {
    const ids = {};

    const create = async (payload, key) => {
      const res = await server.post('/api/registrations', payload);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      ids[key] = res.body.registrationId;
      return res.body;
    };

    // Khách A comes twice — the same CCCD, so one customer with two visits.
    await create(visitorPayload({ visitDate: '2026-10-02', timeSlotId: SLOT_A, numberOfVisitors: 3 }), 'a1');
    await create(visitorPayload({ visitDate: '2026-10-06', timeSlotId: SLOT_B, numberOfVisitors: 2 }), 'a2');
    // Khách B, once.
    await create(visitorPayload({
      fullName: 'Lê Thị B', cccd: '111122223333', phone: '0987654321',
      visitDate: '2026-10-02', timeSlotId: SLOT_A, numberOfVisitors: 4,
    }), 'b1');
    // Two agency bookings for the same end customer of AG_IQI, plus one from AG_KZZEN.
    await create(agencyPayload({ visitDate: '2026-10-03', numberOfVisitors: 5 }), 'ag1');
    await create(agencyPayload({ visitDate: '2026-10-07', numberOfVisitors: 5 }), 'ag2');
    await create(agencyPayload({
      agencyId: 'AG_KZZEN', salesStaffName: 'Phạm Văn D', salesStaffCccd: '555566667777',
      customerShortName: 'T.T.E', customerPhoneLast4: '9999',
      visitDate: '2026-10-03', timeSlotId: SLOT_1030, numberOfVisitors: 2,
    }), 'ag3');

    // The desk work happens on the day of the first visit. Sessions last eight
    // hours, so the clock moves before anyone signs in.
    server.clock.setDate('2026-10-02');
    const reception = await server.login(...CREDS.ciiReception);
    const tgReception = await server.login(...CREDS.tgReception);
    const manager = await server.login(...CREDS.manager);

    // Khách A arrives, and two of the three expected guests turn up (§XXVIII).
    const checkedIn = await server.post(`/api/staff/registrations/${ids.a1}/checkin`,
      { method: 'SEARCH', actualGuests: 2 }, { token: reception.token });
    assert.equal(checkedIn.status, 200, JSON.stringify(checkedIn.body));
    const ticket = await server.post(`/api/staff/registrations/${ids.a1}/parking-tickets`,
      { vehicleType: 'CAR', ticketNumber: 'A-01' }, { token: reception.token });
    assert.equal(ticket.status, 201, JSON.stringify(ticket.body));

    // Khách B never turns up; AG_KZZEN's booking is cancelled.
    const noShow = await server.post(`/api/staff/registrations/${ids.b1}/status`,
      { status: 'NO_SHOW' }, { token: reception.token });
    assert.equal(noShow.status, 200, JSON.stringify(noShow.body));
    // Cancelled by the desk that owns it: an administrator no longer touches
    // registrations at all, and the booking is at the other office.
    const cancelled = await server.post(`/api/staff/registrations/${ids.ag3}/status`,
      { status: 'CANCELLED' }, { token: tgReception.token });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

    return { server, ids, manager, reception, tgReception };
  } catch (err) {
    // Otherwise a broken fixture leaves the port open and the runner never exits.
    await server.close();
    throw err;
  }
}

test('customer statistics: the numbers describe the data', async (t) => {
  const { server, manager } = await seedScenario();
  t.after(() => server.close());

  const res = await server.get('/api/staff/customer-stats', { token: manager.token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const stats = res.body;
  const o = stats.overview;

  assert.equal(o.registrations, 6);
  // Khách A (twice), Khách B, agency AG_IQI's customer (twice), AG_KZZEN's customer.
  assert.equal(o.customers, 4);
  assert.equal(o.people, 3 + 2 + 4 + 5 + 5 + 2);
  assert.equal(o.newCustomers + o.returningCustomers, o.customers);
  // The two customers with two visits each are the returning ones.
  assert.equal(o.returningCustomers, 2);
  assert.equal(o.newCustomers, 2);
  assert.equal(o.visitsPerCustomer, 1.5);
  assert.equal(o.noShow, 1);
  assert.equal(o.cancelled, 1);
  assert.equal(o.arrivedRegistrations, 1);
  // The arrival count is what the desk actually counted, not what was booked.
  assert.equal(o.arrivedPeople, 2);
  // One arrival out of five registrations that were not cancelled.
  assert.equal(o.showUpRate, 0.2);

  await t.test('a cancelled booking never counts as a visit', async () => {
    const totals = stats.dailyTrend.reduce((a, d) => a + d.registrations, 0);
    assert.equal(totals, 6);
    const oct3 = stats.dailyTrend.find((d) => d.date === '2026-10-03');
    assert.equal(oct3.registrations, 2);
    assert.equal(oct3.cancelled, 1);
    assert.equal(oct3.arrived, 0);
  });

  await t.test('split by source adds back up to the whole', async () => {
    const sum = (key) => stats.bySource.reduce((a, r) => a + r[key], 0);
    assert.equal(sum('registrations'), o.registrations);
    assert.equal(sum('people'), o.people);
    assert.equal(sum('noShow'), o.noShow);
    assert.equal(sum('cancelled'), o.cancelled);
    const agency = stats.bySource.find((r) => r.visitorType === 'AGENCY');
    assert.equal(agency.registrations, 3);
    assert.equal(agency.customers, 2);
  });

  await t.test('agencies are ranked by what they actually bring', async () => {
    const byId = Object.fromEntries(stats.byAgency.map((a) => [a.agencyId, a]));
    assert.equal(byId.AG_IQI.registrations, 2);
    assert.equal(byId.AG_IQI.customers, 1);
    assert.equal(byId.AG_IQI.salesStaff, 1);
    assert.equal(byId.AG_KZZEN.registrations, 1);
    assert.equal(byId.AG_KZZEN.cancelled, 1);
    // Every registration cancelled means there is nothing to show up for.
    assert.equal(byId.AG_KZZEN.showUpRate, 0);
  });

  await t.test('repeat visitors are listed with their first and last visit', async () => {
    const top = stats.topCustomers[0];
    assert.equal(top.visits, 2);
    assert.ok(top.firstVisit < top.lastVisit);
  });

  await t.test('party sizes add up to one whole', async () => {
    const share = stats.partySizes.reduce((a, r) => a + r.share, 0);
    assert.ok(Math.abs(share - 1) < 0.005, `shares summed to ${share}`);
    assert.equal(stats.partySizes.reduce((a, r) => a + r.registrations, 0), o.registrations);
  });

  await t.test('slot and weekday views cover every registration', async () => {
    assert.equal(stats.byTimeSlot.reduce((a, r) => a + r.registrations, 0), o.registrations);
    assert.equal(stats.byWeekday.reduce((a, r) => a + r.registrations, 0), o.registrations);
    assert.equal(stats.byWeekday.length, 7);
  });

  await t.test('a date filter narrows every block consistently', async () => {
    const narrow = await server.get(
      '/api/staff/customer-stats?dateFrom=2026-10-06&dateTo=2026-10-07',
      { token: manager.token },
    );
    assert.equal(narrow.status, 200);
    assert.equal(narrow.body.overview.registrations, 2);
    assert.equal(narrow.body.filters.dateFrom, '2026-10-06');
    // Both are second visits by customers first seen before the window, so both
    // read as returning even though the window holds one visit each.
    assert.equal(narrow.body.overview.returningCustomers, 2);
    assert.equal(narrow.body.overview.newCustomers, 0);
  });

  await t.test('an office filter narrows to that office', async () => {
    const cii = await server.get(`/api/staff/customer-stats?salesOfficeId=${OFFICE_CII}`,
      { token: manager.token });
    assert.equal(cii.body.overview.registrations, 3);
    assert.deepEqual(cii.body.byOffice.map((r) => r.salesOfficeId), [OFFICE_CII, OFFICE_TG]);
    assert.equal(cii.body.byOffice.find((r) => r.salesOfficeId === OFFICE_TG).registrations, 3);
  });
});

test('customer statistics: an empty database answers with zeroes, not errors', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const manager = await server.login(...CREDS.manager);

  const res = await server.get('/api/staff/customer-stats', { token: manager.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.overview.registrations, 0);
  assert.equal(res.body.overview.repeatRate, 0);
  assert.equal(res.body.overview.showUpRate, 0);
  assert.equal(res.body.overview.averageLeadDays, 0);
  assert.deepEqual(res.body.byAgency, []);
  assert.deepEqual(res.body.partySizes, []);
  assert.equal(res.body.byWeekday.length, 7);

  // The export of nothing is still a valid workbook.
  const file = await server.request('GET', '/api/staff/customer-stats/export.xlsx',
    { token: manager.token, raw: true });
  assert.equal(file.status, 200);
  const buffer = Buffer.from(await file.arrayBuffer());
  assert.ok(readZip(buffer).has('xl/worksheets/sheet1.xml'));
});

test('registration export: covers every matching row, not just the page', async (t) => {
  const { server, manager } = await seedScenario();
  t.after(() => server.close());

  const page = await server.get('/api/staff/registrations?pageSize=2', { token: manager.token });
  assert.equal(page.body.items.length, 2);
  assert.equal(page.body.total, 6);

  const res = await server.request('GET', '/api/staff/registrations/export.xlsx?pageSize=2',
    { token: manager.token, raw: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="kinera-dang-ky-.*\.xlsx"$/);
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const buffer = Buffer.from(await res.arrayBuffer());
  const sheet = part(buffer, 'xl/worksheets/sheet1.xml');
  const rows = (sheet.match(/<row r="/g) || []).length;
  assert.equal(rows, 7, 'one header row plus all six registrations');

  await t.test('the filters are recorded alongside the data', async () => {
    const info = part(buffer, 'xl/worksheets/sheet2.xml');
    assert.match(info, /Danh sách đăng ký tham quan/);
    assert.match(info, /Kinera Manager \(MANAGER\)/);
    assert.match(info, /Số dòng/);
  });

  await t.test('a filter in the query applies to the file', async () => {
    const filtered = await server.request('GET',
      '/api/staff/registrations/export.xlsx?visitorType=AGENCY', { token: manager.token, raw: true });
    const only = part(Buffer.from(await filtered.arrayBuffer()), 'xl/worksheets/sheet1.xml');
    assert.equal((only.match(/<row r="/g) || []).length, 4, 'three agency rows plus the header');
  });

  await t.test('the arrival count and parking tickets reach the sheet', async () => {
    const header = rowCells(sheet, 1);
    const col = (name) => header.indexOf(name);
    assert.ok(col('Số khách (thực đến)') > 0 && col('Vé xe ô tô') > 0 && col('Vé xe máy') > 0);
    const bodyRows = [];
    for (let r = 2; r <= 7; r += 1) bodyRows.push(rowCells(sheet, r));
    const arrived = bodyRows.find((row) => row[col('Thời điểm check-in')] !== null);
    assert.ok(arrived, 'the checked-in registration should be in the file');
    assert.equal(arrived[col('Số khách (đăng ký)')], '3');
    assert.equal(arrived[col('Số khách (thực đến)')], '2');
    assert.equal(arrived[col('Chênh lệch')], '-1');
    assert.equal(arrived[col('Vé xe ô tô')], '1');
    assert.equal(arrived[col('Vé xe máy')], '0');
  });

  await t.test('statuses and types are written in Vietnamese, not as enum names', async () => {
    assert.match(sheet, /Đã đăng ký|Đã check-in|Không đến|Đã huỷ/);
    assert.ok(!/REGISTERED|NO_SHOW|CANCELLED/.test(sheet), 'raw enum values leaked into the file');
  });
});

test('registration export: a receptionist only ever exports their own office', async (t) => {
  const { server } = await seedScenario();
  t.after(() => server.close());
  const reception = await server.login(...CREDS.ciiReception);

  // Three of the six registrations are at the other office.
  const own = await server.request('GET', '/api/staff/registrations/export.xlsx',
    { token: reception.token, raw: true });
  const sheet = part(Buffer.from(await own.arrayBuffer()), 'xl/worksheets/sheet1.xml');
  assert.equal((sheet.match(/<row r="/g) || []).length, 4, 'three CII rows plus the header');

  // §XXV — asking for the other office cannot widen the scope; it narrows to nothing.
  const other = await server.request('GET',
    `/api/staff/registrations/export.xlsx?salesOfficeId=${OFFICE_TG}`,
    { token: reception.token, raw: true });
  const empty = part(Buffer.from(await other.arrayBuffer()), 'xl/worksheets/sheet1.xml');
  assert.equal((empty.match(/<row r="/g) || []).length, 1, 'the header alone');
});

test('customer statistics are restricted to management', async (t) => {
  const { server } = await seedScenario();
  t.after(() => server.close());

  for (const [role, creds] of [['RECEPTIONIST', CREDS.ciiReception], ['SALES', CREDS.ciiSales]]) {
    const session = await server.login(...creds);
    assert.ok(!session.permissions.includes(P.CUSTOMER_STATS_VIEW),
      `${role} must not be offered the statistics tab`);
    for (const path of ['/api/staff/customer-stats', '/api/staff/customer-stats/export.xlsx']) {
      const res = await server.get(path, { token: session.token });
      assert.equal(res.status, 403, `${role} reached ${path}`);
      assert.equal(res.body.error.code, 'FORBIDDEN');
    }
  }

  await t.test('and are open to the Manager — but not to the Administrator', async () => {
    const manager = await server.login(...CREDS.manager);
    assert.ok(manager.permissions.includes(P.CUSTOMER_STATS_VIEW));
    assert.equal((await server.get('/api/staff/customer-stats', { token: manager.token })).status, 200);

    // The administrator manages accounts, not customers: the statistics hold
    // names, ID numbers and phone numbers that the role has no need to read.
    const admin = await server.login(...CREDS.admin);
    assert.equal(admin.permissions.includes(P.CUSTOMER_STATS_VIEW), false);
    assert.equal((await server.get('/api/staff/customer-stats', { token: admin.token })).status, 403);
  });

  await t.test('an unauthenticated request gets nothing', async () => {
    const res = await server.get('/api/staff/customer-stats');
    assert.equal(res.status, 401);
    const file = await server.get('/api/staff/customer-stats/export.xlsx');
    assert.equal(file.status, 401);
  });

  await t.test('the permission matrix itself says so', async () => {
    assert.deepEqual(
      Object.keys(MATRIX).filter((role) => can({ role }, P.CUSTOMER_STATS_VIEW)),
      [ROLES.MANAGER],
    );
    // Everyone who can read the list can export it: the file holds nothing extra.
    for (const role of Object.keys(MATRIX)) {
      assert.equal(can({ role }, P.REGISTRATION_EXPORT), can({ role }, P.REGISTRATION_VIEW),
        `${role} disagrees between viewing and exporting`);
    }
  });
});

test('the statistics workbook has a sheet per block and openpyxl can read it',
  { skip: !openpyxlAvailable() }, async (t) => {
    const { server, manager } = await seedScenario();
    t.after(() => server.close());

    const res = await server.request('GET', '/api/staff/customer-stats/export.xlsx',
      { token: manager.token, raw: true });
    assert.equal(res.status, 200);
    const wb = inspectWithOpenpyxl(Buffer.from(await res.arrayBuffer()));

    assert.deepEqual(wb.sheets, [
      'Tổng quan', 'Theo nguồn khách', 'Theo sàn giao dịch', 'Theo đại lý',
      'Nhân viên đại lý', 'Khách theo số lượt', 'Theo khung giờ',
      'Theo ngày trong tuần', 'Quy mô đoàn', 'Theo ngày', 'Check-in thực tế', 'Bộ lọc',
    ]);

    const overview = new Map(wb.data['Tổng quan'].rows.slice(1));
    assert.equal(overview.get('Số lượt đăng ký'), 6);
    assert.equal(overview.get('Số khách hàng (không trùng)'), 4);
    assert.equal(overview.get('Số người thực đến'), 2);
    assert.equal(overview.get('Tỷ lệ đến'), '20,0%');

    const source = wb.data['Theo nguồn khách'].rows;
    assert.equal(source[0][0], 'Loại khách');
    assert.deepEqual(source.slice(1).map((r) => r[0]), ['Khách tham quan', 'Đại lý']);
    assert.equal(source[2][1], 3, 'three agency registrations');

    await t.test('dates in the trend sheet are real dates on the right day', async () => {
      const trend = wb.data['Theo ngày'].rows.slice(1);
      assert.ok(trend.length > 0);
      assert.match(trend[0][0], /^2026-10-02T00:00:00$/);
      assert.equal(wb.data['Theo ngày'].formats[0], 'dd/mm/yyyy');
    });

    await t.test('the filter sheet names who produced the file and when', async () => {
      const info = new Map(wb.data['Bộ lọc'].rows.slice(1));
      assert.equal(info.get('Báo cáo'), 'Thống kê khách hàng');
      assert.equal(info.get('Người xuất'), 'Kinera Manager (MANAGER)');
      assert.equal(info.get('Sàn giao dịch'), 'Tất cả');
      // 02:30 UTC is 09:30 in Vietnam: the stamp is in the report's own timezone.
      assert.equal(info.get('Xuất lúc'), '02/10/2026 09:30');
    });
  });

test('the export is capped so one request cannot build an unbounded file', async (t) => {
  const { server, manager } = await seedScenario();
  t.after(() => server.close());

  const { registrations } = server.services;
  const capped = await registrations.listAll({}, { limit: 2 });
  assert.equal(capped.items.length, 2);
  assert.equal(capped.total, 6);
  assert.equal(capped.truncated, true);

  const workbook = buildRegistrationWorkbook(capped, {
    filters: {}, generatedBy: 'Test', generatedAt: new Date('2026-10-01T02:30:00Z'),
  });
  // A truncated file says so, rather than quietly looking complete.
  assert.match(part(workbook, 'xl/worksheets/sheet2.xml'), /Chỉ xuất 2 dòng đầu tiên/);

  await t.test('and the whole set is not truncated', async () => {
    const all = await registrations.listAll({});
    assert.equal(all.truncated, false);
    assert.equal(all.items.length, 6);
  });

  await t.test('the filename is distinct per report and carries the timestamp', async () => {
    const at = new Date('2026-10-01T02:30:00Z');
    assert.equal(reportFilename('kinera-dang-ky', { generatedAt: at }), 'kinera-dang-ky-20261001-0930.xlsx');
    assert.equal(
      reportFilename('kinera-dang-ky', { generatedAt: at, filters: { salesOfficeId: OFFICE_CII } }),
      'kinera-dang-ky-cii_binh_thanh-20261001-0930.xlsx',
    );
  });
});

test('the customer identity is derived the way the service documents', async (t) => {
  const { server } = await seedScenario();
  t.after(() => server.close());
  const { db, masterData } = server.services;
  const stats = new CustomerStatsService({ db, masterData, clock: server.clock });

  await t.test('two bookings with one CCCD are one customer', async () => {
    const o = await stats.overview({ visitorType: 'VISITOR' });
    assert.equal(o.registrations, 3);
    assert.equal(o.customers, 2);
  });

  await t.test('a registration with no identifying field counts once, never merged', async () => {
    // Sales books on the phone for two different walk-ins, giving no CCCD for
    // either. They must not collapse into a single "unknown" customer.
    const sales = await server.login(...CREDS.ciiSales);
    for (const name of ['Khách lạ 1', 'Khách lạ 2']) {
      const res = await server.post('/api/registrations',
        visitorPayload({ fullName: name, cccd: null, phone: null, visitDate: '2026-10-08' }),
        { token: sales.token });
      // The form requires them, so this is only reachable by writing the row
      // directly — which is what a data import would do.
      if (res.status !== 201) {
        await db.prepare(`
          INSERT INTO registrations (id, confirmation_code, qr_token, language, sales_office_id,
            visitor_type, registration_date, visit_date, time_slot_id, number_of_visitors,
            status, full_name, created_at, updated_at)
          VALUES (?,?,?,'vi',?, 'VISITOR','2026-10-01','2026-10-08',?,1,'REGISTERED',?, ?, ?)`)
          .run(`id-${name}`, `OE-X${name.slice(-1)}0001`, `tok-${name}`, OFFICE_CII, SLOT_A,
            name, '2026-10-01T02:30:00.000Z', '2026-10-01T02:30:00.000Z');
      }
    }
    const o = await stats.overview({ dateFrom: '2026-10-08', dateTo: '2026-10-08' });
    assert.equal(o.registrations, 2);
    assert.equal(o.customers, 2, 'two anonymous bookings are two customers, not one');
  });
});
