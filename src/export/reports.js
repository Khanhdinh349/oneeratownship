'use strict';

const { buildWorkbook, STYLE, plainDate } = require('./xlsx');
const {
  VISITOR_TYPES, VEHICLE_TYPES, REPORT_UTC_OFFSET_MINUTES, officeById, slotById,
} = require('../config/master-data');

/**
 * The two Excel reports the staff area offers.
 *
 * Both are built from the same read models the screens use, so a spreadsheet can
 * never disagree with what the user was just looking at (§Rule 8). Column order
 * follows the on-screen table, and every sheet carries a "Bộ lọc" block naming the
 * filters the file was produced under — a report with no stated scope is a report
 * nobody can check.
 */

const VI = {
  REGISTERED: 'Đã đăng ký',
  CONFIRMED: 'Đã xác nhận',
  EXPECTED: 'Dự kiến đến',
  CHECKED_IN: 'Đã check-in',
  IN_VISIT: 'Đang tham quan',
  COMPLETED: 'Hoàn thành',
  CANCELLED: 'Đã huỷ',
  NO_SHOW: 'Không đến',
};

const TYPE_VI = {
  [VISITOR_TYPES.VISITOR]: 'Khách tham quan',
  [VISITOR_TYPES.AGENCY]: 'Đại lý',
};

const ARRIVAL_VI = {
  ON_TIME: 'Đúng giờ',
  LATE: 'Đến trễ',
  EARLY: 'Đến sớm',
  AFTER_SLOT: 'Sau khung giờ',
  OTHER_DAY: 'Khác ngày đăng ký',
};
const arrivalVi = (a) => (a ? (ARRIVAL_VI[a] || a) : null);

const statusVi = (s) => VI[s] || s;
const typeVi = (t) => TYPE_VI[t] || t;
const officeName = (id) => (officeById(id) ? officeById(id).name : id);
const slotLabel = (id) => (slotById(id) ? slotById(id).label : id);
/** A visit or registration date: a calendar day, never shifted by a timezone. */
const dateCell = (iso) => plainDate(iso);
const stampCell = (iso) => (iso ? new Date(iso) : null);

/**
 * The filter block mixes dates, counts and free text in one column, and a column
 * can carry only one number format — so dates there are written as readable text
 * in the report's own timezone rather than as serials that would show up bare.
 */
const inReportZone = (iso) => new Date(new Date(iso).getTime() + REPORT_UTC_OFFSET_MINUTES * 60000);
const dateText = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—');
const stampText = (iso) => {
  if (!iso) return '—';
  const d = inReportZone(iso);
  return `${dateText(d.toISOString())} ${d.toISOString().slice(11, 16)}`;
};

/** The filter block that opens every sheet, so a saved file explains itself. */
function filterLines({ filters = {}, generatedBy, generatedAt, rowCount, truncatedAt = null }) {
  const lines = [
    ['Báo cáo', filters.reportTitle || ''],
    ['Xuất lúc', stampText(generatedAt)],
    ['Người xuất', generatedBy || '—'],
    ['Sàn giao dịch', filters.salesOfficeId ? officeName(filters.salesOfficeId) : 'Tất cả'],
    ['Loại khách', filters.visitorType ? typeVi(filters.visitorType) : 'Tất cả'],
    ['Từ ngày', filters.dateFrom ? dateText(filters.dateFrom) : 'Không giới hạn'],
    ['Đến ngày', filters.dateTo ? dateText(filters.dateTo) : 'Không giới hạn'],
    ['Trạng thái', filters.status && filters.status.length
      ? filters.status.map(statusVi).join(', ') : 'Tất cả'],
    ['Tìm kiếm', filters.search || '—'],
    ['Số dòng', rowCount],
  ];
  if (truncatedAt) {
    lines.push(['Lưu ý', `Chỉ xuất ${truncatedAt} dòng đầu tiên — hãy thu hẹp bộ lọc để xuất đủ.`]);
  }
  return lines;
}

/** A two-column key/value sheet — used for the filter block and the overview. */
function infoSheet(name, rows, { keyWidth = 30, valueWidth = 46 } = {}) {
  return {
    name,
    columns: [
      { header: 'Chỉ tiêu', width: keyWidth },
      { header: 'Giá trị', width: valueWidth },
    ],
    rows: rows.map(([k, v]) => [k, v]),
  };
}

// ============================================================ registration list

const REGISTRATION_COLUMNS = [
  { header: 'Mã xác nhận', width: 16 },
  { header: 'Trạng thái', width: 15 },
  { header: 'Loại khách', width: 16 },
  { header: 'Sàn giao dịch', width: 24 },
  { header: 'Ngày tham quan', width: 15, style: STYLE.DATE },
  { header: 'Khung giờ', width: 16 },
  { header: 'Số khách (đăng ký)', width: 17, style: STYLE.INTEGER },
  { header: 'Số khách (thực đến)', width: 18, style: STYLE.INTEGER },
  { header: 'Chênh lệch', width: 11, style: STYLE.INTEGER },
  { header: 'Đúng giờ?', width: 16 },
  { header: 'Lệch giờ (phút)', width: 14, style: STYLE.INTEGER },
  { header: 'Họ tên khách', width: 26 },
  { header: 'CCCD', width: 16 },
  { header: 'Điện thoại', width: 14 },
  { header: 'Email', width: 26 },
  { header: 'Đại lý', width: 24 },
  { header: 'Nhân viên đại lý', width: 22 },
  { header: 'CCCD nhân viên', width: 16 },
  { header: 'ĐT nhân viên', width: 14 },
  { header: 'Khách của đại lý', width: 20 },
  { header: '4 số cuối ĐT khách', width: 16 },
  { header: 'Vé xe ô tô', width: 11, style: STYLE.INTEGER },
  { header: 'Vé xe máy', width: 11, style: STYLE.INTEGER },
  { header: 'Vé chưa trả', width: 12, style: STYLE.INTEGER },
  { header: 'Thời điểm check-in', width: 19, style: STYLE.DATETIME },
  { header: 'Lễ tân check-in', width: 22 },
  { header: 'Ngày đăng ký', width: 15, style: STYLE.DATE },
  { header: 'Tạo lúc', width: 19, style: STYLE.DATETIME },
  { header: 'Ghi chú', width: 40 },
];

function registrationRow(reg) {
  const v = reg.visitor || {};
  const a = reg.agency || {};
  const c = reg.checkin || null;
  const p = reg.parking || {};
  const byType = p.byVehicleType || {};
  const car = byType[VEHICLE_TYPES.CAR] || {};
  const bike = byType[VEHICLE_TYPES.MOTORBIKE] || {};

  return [
    reg.confirmationCode,
    statusVi(reg.status),
    typeVi(reg.visitorType),
    officeName(reg.salesOfficeId),
    dateCell(reg.visitDate),
    slotLabel(reg.timeSlotId),
    reg.numberOfVisitors,
    c ? c.actualGuests : null,
    c ? c.actualGuests - c.expectedGuests : null,
    c ? arrivalVi(c.arrivalStatus) : null,
    c ? c.minutesFromSlotStart : null,
    v.fullName || null,
    v.cccd || null,
    v.phone || null,
    v.email || null,
    a.agencyName || null,
    a.salesStaffName || null,
    a.salesStaffCccd || null,
    a.salesStaffPhone || null,
    a.customerShortName || null,
    a.customerPhoneLast4 || null,
    car.issued ?? 0,
    bike.issued ?? 0,
    p.outstanding ?? 0,
    c ? stampCell(c.checkinTime) : null,
    c ? c.receptionistName : null,
    dateCell(reg.registrationDate),
    stampCell(reg.createdAt),
    reg.notes || null,
  ];
}

/**
 * §XXXVIII — the registration list exactly as filtered on screen, as .xlsx.
 * @param {{items: object[], total: number, truncated: boolean, limit: number}} result
 */
function buildRegistrationWorkbook(result, { filters = {}, generatedBy, generatedAt = new Date() } = {}) {
  const items = result.items || [];
  return buildWorkbook([
    {
      name: 'Danh sách đăng ký',
      columns: REGISTRATION_COLUMNS,
      rows: items.map(registrationRow),
    },
    infoSheet('Bộ lọc', filterLines({
      filters: { ...filters, reportTitle: 'Danh sách đăng ký tham quan' },
      generatedBy,
      generatedAt,
      rowCount: items.length,
      truncatedAt: result.truncated ? result.limit : null,
    })),
  ], { created: generatedAt, tzOffsetMinutes: REPORT_UTC_OFFSET_MINUTES });
}

// ========================================================= customer statistics

/**
 * The customer statistics screen as a workbook: one sheet per block, so each one
 * can be pivoted or charted on its own.
 */
function buildCustomerStatsWorkbook(stats, { generatedBy, generatedAt = new Date() } = {}) {
  const o = stats.overview;
  const att = stats.attendance;

  // The overview is a key/value block, and a column style would have to apply to
  // counts and rates alike — so the two rates are written as readable text.
  const pct = (v) => `${(v * 100).toFixed(1).replace('.', ',')}%`;

  const overview = infoSheet('Tổng quan', [
    ['Số lượt đăng ký', o.registrations],
    ['Số khách hàng (không trùng)', o.customers],
    ['Tổng số người đăng ký', o.people],
    ['Khách hàng mới', o.newCustomers],
    ['Khách hàng quay lại', o.returningCustomers],
    ['Tỷ lệ quay lại', pct(o.repeatRate)],
    ['Số lượt / khách hàng', o.visitsPerCustomer],
    ['Quy mô đoàn trung bình', o.averagePartySize],
    ['Đăng ký trước (ngày, trung bình)', o.averageLeadDays],
    ['Lượt đã đến', o.arrivedRegistrations],
    ['Khách hàng đã đến', o.arrivedCustomers],
    ['Số người thực đến', o.arrivedPeople],
    ['Không đến', o.noShow],
    ['Đã huỷ', o.cancelled],
    ['Tỷ lệ đến', pct(o.showUpRate)],
    // From the receptionists' check-in records, not from what was booked.
    ['— THỰC TẾ TẠI QUẦY LỄ TÂN —', ''],
    ['Số lượt check-in', att.checkins],
    ['Số người đăng ký (các lượt đã đến)', att.bookedPeople],
    ['Số người thực đến (lễ tân đếm)', att.actualPeople],
    ['Chênh lệch thực đến so với đăng ký', att.variance],
    ['Lượt đến đủ số đăng ký', att.matched],
    ['Lượt đến nhiều hơn đăng ký', att.arrivedWithMore],
    ['Lượt đến ít hơn đăng ký', att.arrivedWithFewer],
    ['Lượt đến đúng giờ', att.punctuality.onTime],
    ['Lượt đến trễ (trong khung giờ)', att.punctuality.late],
    ['Lượt đến sớm (trước khung giờ)', att.punctuality.early],
    ['Lượt đến sau khi khung giờ kết thúc', att.punctuality.afterSlot],
    ['Lượt đến khác ngày đăng ký', att.punctuality.otherDay],
    ['Tỷ lệ đúng giờ', pct(att.onTimeRate)],
    ['Trễ trung bình (phút)', att.averageLateMinutes],
  ]);

  const sheets = [
    overview,
    {
      name: 'Theo nguồn khách',
      columns: [
        { header: 'Loại khách', width: 18 },
        { header: 'Lượt đăng ký', width: 14, style: STYLE.INTEGER },
        { header: 'Khách hàng', width: 13, style: STYLE.INTEGER },
        { header: 'Số người', width: 12, style: STYLE.INTEGER },
        { header: 'Khách mới', width: 12, style: STYLE.INTEGER },
        { header: 'Khách quay lại', width: 14, style: STYLE.INTEGER },
        { header: 'Lượt đã đến', width: 13, style: STYLE.INTEGER },
        { header: 'Người thực đến', width: 15, style: STYLE.INTEGER },
        { header: 'Không đến', width: 12, style: STYLE.INTEGER },
        { header: 'Đã huỷ', width: 10, style: STYLE.INTEGER },
        { header: 'Quy mô đoàn TB', width: 15 },
        { header: 'Tỷ lệ đến', width: 11, style: STYLE.PERCENT },
      ],
      rows: stats.bySource.map((r) => [
        typeVi(r.visitorType), r.registrations, r.customers, r.people, r.newCustomers,
        r.returningCustomers, r.arrivedRegistrations, r.arrivedPeople, r.noShow, r.cancelled,
        r.averagePartySize, r.showUpRate,
      ]),
    },
    {
      name: 'Theo sàn giao dịch',
      columns: [
        { header: 'Sàn giao dịch', width: 26 },
        { header: 'Lượt đăng ký', width: 14, style: STYLE.INTEGER },
        { header: 'Khách hàng', width: 13, style: STYLE.INTEGER },
        { header: 'Số người', width: 12, style: STYLE.INTEGER },
        { header: 'Khách mới', width: 12, style: STYLE.INTEGER },
        { header: 'Khách quay lại', width: 14, style: STYLE.INTEGER },
        { header: 'Lượt đã đến', width: 13, style: STYLE.INTEGER },
        { header: 'Người thực đến', width: 15, style: STYLE.INTEGER },
        { header: 'Không đến', width: 12, style: STYLE.INTEGER },
        { header: 'Tỷ lệ đến', width: 11, style: STYLE.PERCENT },
        { header: 'Quy mô đoàn TB', width: 15 },
      ],
      rows: stats.byOffice.map((r) => [
        r.salesOfficeName, r.registrations, r.customers, r.people, r.newCustomers,
        r.returningCustomers, r.arrivedRegistrations, r.arrivedPeople, r.noShow,
        r.showUpRate, r.averagePartySize,
      ]),
    },
    {
      name: 'Theo đại lý',
      columns: [
        { header: 'Đại lý', width: 28 },
        { header: 'Lượt đăng ký', width: 14, style: STYLE.INTEGER },
        { header: 'Khách hàng', width: 13, style: STYLE.INTEGER },
        { header: 'Số người', width: 12, style: STYLE.INTEGER },
        { header: 'Nhân viên', width: 11, style: STYLE.INTEGER },
        { header: 'Lượt đã đến', width: 12, style: STYLE.INTEGER },
        { header: 'Người thực đến', width: 15, style: STYLE.INTEGER },
        { header: 'Không đến', width: 12, style: STYLE.INTEGER },
        { header: 'Đã huỷ', width: 10, style: STYLE.INTEGER },
        { header: 'Tỷ lệ đến', width: 11, style: STYLE.PERCENT },
      ],
      rows: stats.byAgency.map((r) => [
        r.agencyName, r.registrations, r.customers, r.people, r.salesStaff,
        r.arrived, r.arrivedPeople, r.noShow, r.cancelled, r.showUpRate,
      ]),
    },
    {
      name: 'Nhân viên đại lý',
      columns: [
        { header: 'Nhân viên', width: 26 },
        { header: 'Đại lý', width: 26 },
        { header: 'Lượt đăng ký', width: 14, style: STYLE.INTEGER },
        { header: 'Khách hàng', width: 13, style: STYLE.INTEGER },
        { header: 'Số người', width: 12, style: STYLE.INTEGER },
        { header: 'Lượt đã đến', width: 12, style: STYLE.INTEGER },
        { header: 'Người thực đến', width: 15, style: STYLE.INTEGER },
      ],
      rows: stats.topSalesStaff.map((r) => [
        r.salesStaffName, r.agencyName, r.registrations, r.customers, r.people, r.arrived,
        r.arrivedPeople,
      ]),
    },
    {
      name: 'Khách theo số lượt',
      columns: [
        { header: 'Khách hàng', width: 28 },
        { header: 'Loại khách', width: 16 },
        { header: 'Đại lý', width: 24 },
        { header: 'Số lượt', width: 10, style: STYLE.INTEGER },
        { header: 'Số người', width: 11, style: STYLE.INTEGER },
        { header: 'Đã đến', width: 10, style: STYLE.INTEGER },
        { header: 'Lần đầu', width: 13, style: STYLE.DATE },
        { header: 'Gần nhất', width: 13, style: STYLE.DATE },
      ],
      rows: stats.topCustomers.map((r) => [
        r.name, typeVi(r.visitorType), r.agencyName || null, r.visits, r.people, r.arrived,
        dateCell(r.firstVisit), dateCell(r.lastVisit),
      ]),
    },
    {
      name: 'Theo khung giờ',
      columns: [
        { header: 'Khung giờ', width: 18 },
        { header: 'Sức chứa', width: 11, style: STYLE.INTEGER },
        { header: 'Lượt đăng ký', width: 14, style: STYLE.INTEGER },
        { header: 'Khách hàng', width: 13, style: STYLE.INTEGER },
        { header: 'Số người', width: 12, style: STYLE.INTEGER },
        { header: 'Lượt đã đến', width: 12, style: STYLE.INTEGER },
        { header: 'Người thực đến', width: 15, style: STYLE.INTEGER },
        { header: 'Không đến', width: 12, style: STYLE.INTEGER },
        { header: 'Tỷ lệ đến', width: 11, style: STYLE.PERCENT },
      ],
      rows: stats.byTimeSlot.map((r) => [
        r.label, r.capacity, r.registrations, r.customers, r.people, r.arrived,
        r.arrivedPeople, r.noShow, r.showUpRate,
      ]),
    },
    {
      name: 'Theo ngày trong tuần',
      columns: [
        { header: 'Ngày', width: 14 },
        { header: 'Lượt đăng ký', width: 14, style: STYLE.INTEGER },
        { header: 'Khách hàng', width: 13, style: STYLE.INTEGER },
        { header: 'Số người', width: 12, style: STYLE.INTEGER },
        { header: 'Lượt đã đến', width: 12, style: STYLE.INTEGER },
        { header: 'Người thực đến', width: 15, style: STYLE.INTEGER },
      ],
      rows: stats.byWeekday.map((r) => [
        r.label, r.registrations, r.customers, r.people, r.arrived, r.arrivedPeople,
      ]),
    },
    {
      name: 'Quy mô đoàn',
      columns: [
        { header: 'Số khách / đăng ký', width: 18, style: STYLE.INTEGER },
        { header: 'Lượt đăng ký', width: 14, style: STYLE.INTEGER },
        { header: 'Tổng số người', width: 14, style: STYLE.INTEGER },
        { header: 'Tỷ trọng', width: 11, style: STYLE.PERCENT },
      ],
      rows: stats.partySizes.map((r) => [r.size, r.registrations, r.people, r.share]),
    },
    {
      name: 'Theo ngày',
      columns: [
        { header: 'Ngày tham quan', width: 15, style: STYLE.DATE },
        { header: 'Lượt đăng ký', width: 14, style: STYLE.INTEGER },
        { header: 'Khách hàng', width: 13, style: STYLE.INTEGER },
        { header: 'Số người', width: 12, style: STYLE.INTEGER },
        { header: 'Lượt đã đến', width: 12, style: STYLE.INTEGER },
        { header: 'Người thực đến', width: 15, style: STYLE.INTEGER },
        { header: 'Không đến', width: 12, style: STYLE.INTEGER },
        { header: 'Đã huỷ', width: 10, style: STYLE.INTEGER },
      ],
      rows: stats.dailyTrend.map((r) => [
        dateCell(r.date), r.registrations, r.customers, r.people, r.arrived, r.arrivedPeople,
        r.noShow, r.cancelled,
      ]),
    },
    {
      // The receptionists' own record, one line per check-in — where every
      // "thực đến" figure in this workbook comes from.
      name: 'Check-in thực tế',
      columns: [
        { header: 'Thời điểm check-in', width: 19, style: STYLE.DATETIME },
        { header: 'Mã xác nhận', width: 14 },
        { header: 'Sàn giao dịch', width: 24 },
        { header: 'Ngày đăng ký tham quan', width: 20, style: STYLE.DATE },
        { header: 'Khung giờ đăng ký', width: 17 },
        { header: 'Khung giờ thực vào', width: 17 },
        { header: 'Loại khách', width: 16 },
        { header: 'Đại lý', width: 24 },
        { header: 'Số người đăng ký', width: 16, style: STYLE.INTEGER },
        { header: 'Số người thực đến', width: 17, style: STYLE.INTEGER },
        { header: 'Chênh lệch', width: 11, style: STYLE.INTEGER },
        { header: 'Đúng giờ?', width: 18 },
        { header: 'Lệch giờ (phút)', width: 14, style: STYLE.INTEGER },
        { header: 'Lễ tân xác nhận ngoài khung', width: 24 },
        { header: 'Lễ tân', width: 26 },
      ],
      rows: (stats.checkinRecords || []).map((r) => [
        stampCell(r.checkinTime), r.confirmationCode, officeName(r.salesOfficeId),
        dateCell(r.visitDate), slotLabel(r.timeSlotId),
        r.admittedSlotId ? slotLabel(r.admittedSlotId) : null,
        typeVi(r.visitorType), r.agencyName, r.expectedGuests, r.actualGuests, r.variance,
        arrivalVi(r.arrivalStatus), r.minutesFromSlotStart, r.timeOverride ? 'Có' : null,
        r.receptionistName,
      ]),
    },
    infoSheet('Bộ lọc', filterLines({
      filters: { ...stats.filters, reportTitle: 'Thống kê khách hàng' },
      generatedBy,
      generatedAt,
      rowCount: o.registrations,
    })),
  ];

  return buildWorkbook(sheets, {
    created: generatedAt,
    tzOffsetMinutes: REPORT_UTC_OFFSET_MINUTES,
  });
}

/** A filename a person can tell apart in a downloads folder. */
function reportFilename(prefix, { generatedAt = new Date(), filters = {} } = {}) {
  const stamp = new Date(generatedAt.getTime() + REPORT_UTC_OFFSET_MINUTES * 60000)
    .toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const scope = filters.salesOfficeId ? `-${filters.salesOfficeId.toLowerCase()}` : '';
  return `${prefix}${scope}-${stamp}.xlsx`;
}

module.exports = {
  buildRegistrationWorkbook,
  buildCustomerStatsWorkbook,
  reportFilename,
  REGISTRATION_COLUMNS,
};
