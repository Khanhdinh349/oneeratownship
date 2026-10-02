'use strict';

const { VISITOR_TYPES, OTHER_AGENCY_ID } = require('../config/master-data');
const { STATUS } = require('../domain/status');
const { toDateString } = require('../domain/dates');

/**
 * Customer statistics (§XXX–§XXXIV, extended).
 *
 * The operational Dashboard answers "what is happening at the office today".
 * This answers a different question: "who are the customers coming to us, and
 * how are they behaving". Everything is a live aggregate over `registrations`
 * and `checkins` (§Rule 8) — nothing is precomputed or stored separately.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ASSUMPTION — how a "customer" is identified
 *
 * The system has no Customer table (§Rule 11 avoids creating one), so a customer
 * identity is derived from the identifying fields each registration type does
 * capture:
 *
 *   • Khách tham quan (§XXI): the CCCD, which is unique per person. If a record
 *     has no CCCD, the phone number stands in; if it has neither, the
 *     registration counts as its own one-off customer.
 *   • Đại lý (§XXII): the end customer is only ever recorded as a short name plus
 *     the last four digits of the phone, so the identity is the agency plus those
 *     two values. Two different customers of one agency who share both a short
 *     name and the same last four digits would be counted as one — rare, and the
 *     narrowest reading of the data actually collected.
 *
 * `unique customers` therefore means "distinct identities as recorded", not
 * "distinct human beings". Change this derivation only together with the fields
 * on the registration form.
 * ──────────────────────────────────────────────────────────────────────────────
 */

const ARRIVED = [STATUS.CHECKED_IN, STATUS.IN_VISIT, STATUS.COMPLETED];
const DAY_NAMES = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];

/** SQL expression for the derived customer identity described above. */
const customerKey = (t = 'r') => `
  CASE WHEN ${t}.visitor_type = 'VISITOR'
    THEN 'V:' || COALESCE(NULLIF(${t}.cccd, ''), NULLIF(${t}.phone, ''), 'ONEOFF:' || ${t}.id)
    ELSE 'A:' || COALESCE(${t}.agency_id, '?')
         -- Every "Khác" registration shares one agency id, so there the typed
         -- name is what tells two agencies apart.
         || CASE WHEN ${t}.agency_id = '${OTHER_AGENCY_ID}'
                 THEN '/' || lower(COALESCE(${t}.agency_name, '')) ELSE '' END
         || ':' || lower(COALESCE(NULLIF(${t}.customer_short_name, ''), 'ONEOFF:' || ${t}.id))
         || ':' || COALESCE(${t}.customer_phone_last4, '')
  END`;

const CUSTOMER_KEY = customerKey('r');

/** One sales person, identified by CCCD where there is one and by name otherwise. */
const STAFF_NAME = "COALESCE(NULLIF(r.sales_staff_name, ''), '—')";

const num = (v) => Number(v || 0);
const rate = (part, whole) => (whole === 0 ? 0 : Number((part / whole).toFixed(4)));

class CustomerStatsService {
  constructor({ db, masterData, clock = () => new Date() }) {
    this.db = db;
    this.masterData = masterData;
    this.clock = clock;
  }

  today() { return toDateString(this.clock()); }

  /**
   * Shared WHERE clause. `scopeOfficeId` enforces §XXV; it is applied in addition
   * to any office filter the caller passes, never instead of it, so a filter can
   * never widen a scoped user's view.
   */
  #where({
    scopeOfficeId = null, salesOfficeId = null, visitorType = null,
    dateFrom = null, dateTo = null, agencyId = null, excludeCancelled = false,
  } = {}) {
    const where = [];
    const params = [];
    if (scopeOfficeId) { where.push('r.sales_office_id = ?'); params.push(scopeOfficeId); }
    if (salesOfficeId) { where.push('r.sales_office_id = ?'); params.push(salesOfficeId); }
    if (visitorType) { where.push('r.visitor_type = ?'); params.push(visitorType); }
    if (agencyId) { where.push('r.agency_id = ?'); params.push(agencyId); }
    if (dateFrom) { where.push('r.visit_date >= ?'); params.push(dateFrom); }
    if (dateTo) { where.push('r.visit_date <= ?'); params.push(dateTo); }
    if (excludeCancelled) { where.push('r.status <> ?'); params.push(STATUS.CANCELLED); }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  #arrivedSql(sql) {
    return `${sql ? `${sql} AND` : 'WHERE'} r.status IN (${ARRIVED.map(() => '?').join(',')})`;
  }

  /**
   * Headline numbers.
   *
   * "Returning" is judged against the customer's whole history, not just the
   * filtered window: someone who came in May and again in June is a returning
   * customer in a June-only report, which is the question a manager is asking.
   */
  async overview(options = {}) {
    const { sql, params } = this.#where(options);

    const totals = await this.db.prepare(`
      SELECT COUNT(*) AS registrations,
             COALESCE(SUM(r.number_of_visitors), 0) AS people,
             COUNT(DISTINCT ${CUSTOMER_KEY}) AS customers
      FROM registrations r ${sql}`).get(...params);

    const arrivedSql = this.#arrivedSql(sql);
    const arrived = await this.db.prepare(`
      SELECT COUNT(*) AS registrations,
             COUNT(DISTINCT ${CUSTOMER_KEY}) AS customers
      FROM registrations r ${arrivedSql}`).get(...params, ...ARRIVED);

    const actual = await this.db.prepare(`
      SELECT COALESCE(SUM(c.actual_guests), 0) AS people
      FROM checkins c
      WHERE c.registration_id IN (SELECT r.id FROM registrations r ${arrivedSql})`)
      .get(...params, ...ARRIVED);

    const noShow = num((await this.db.prepare(`
      SELECT COUNT(*) AS n FROM registrations r
      ${sql ? `${sql} AND` : 'WHERE'} r.status = ?`).get(...params, STATUS.NO_SHOW)).n);
    const cancelled = num((await this.db.prepare(`
      SELECT COUNT(*) AS n FROM registrations r
      ${sql ? `${sql} AND` : 'WHERE'} r.status = ?`).get(...params, STATUS.CANCELLED)).n);

    // New versus returning, in one pass. An identity is returning if it appears
    // more than once inside the window, or if it has any earlier non-cancelled
    // visit outside it — someone who came in May and again in June is a returning
    // customer in a June report, which is the question being asked.
    const split = await this.db.prepare(`
      WITH win AS (
        SELECT ${CUSTOMER_KEY} AS k, COUNT(*) AS visits, MIN(r.visit_date) AS first_in
        FROM registrations r ${sql}
        GROUP BY k
      )
      SELECT COUNT(*) AS customers,
             COALESCE(SUM(CASE WHEN w.visits > 1 OR EXISTS (
               SELECT 1 FROM registrations e
               WHERE ${customerKey('e')} = w.k
                 AND e.visit_date < w.first_in
                 AND e.status <> '${STATUS.CANCELLED}'
             ) THEN 1 ELSE 0 END), 0) AS repeat_customers
      FROM win w`).get(...params);

    const returning = num(split.repeat_customers);
    const newCustomers = num(split.customers) - returning;

    // How far ahead people book (§XII's 10-day window). Both columns hold plain
    // YYYY-MM-DD text, so a date subtraction gives whole days.
    const lead = await this.db.prepare(`
      SELECT AVG(r.visit_date::date - r.registration_date::date) AS days
      FROM registrations r ${sql}`).get(...params);

    const registrations = num(totals.registrations);
    const customers = num(totals.customers);

    return {
      asOf: this.clock().toISOString(),
      registrations,
      customers,
      people: num(totals.people),
      newCustomers,
      returningCustomers: returning,
      repeatRate: rate(returning, customers),
      visitsPerCustomer: customers === 0 ? 0 : Number((registrations / customers).toFixed(2)),
      averagePartySize: registrations === 0 ? 0
        : Number((num(totals.people) / registrations).toFixed(2)),
      averageLeadDays: lead.days == null ? 0 : Number(Number(lead.days).toFixed(1)),
      arrivedRegistrations: num(arrived.registrations),
      arrivedCustomers: num(arrived.customers),
      arrivedPeople: num(actual.people),
      noShow,
      cancelled,
      showUpRate: rate(num(arrived.registrations), registrations - cancelled),
    };
  }

  /** Direct visitors versus agency-introduced customers (§XXXII). */
  async bySource(options = {}) {
    return Promise.all(Object.values(VISITOR_TYPES).map(async (type) => {
      const o = await this.overview({ ...options, visitorType: type });
      return {
        visitorType: type,
        registrations: o.registrations,
        customers: o.customers,
        people: o.people,
        newCustomers: o.newCustomers,
        returningCustomers: o.returningCustomers,
        arrivedRegistrations: o.arrivedRegistrations,
        arrivedPeople: o.arrivedPeople,
        noShow: o.noShow,
        cancelled: o.cancelled,
        averagePartySize: o.averagePartySize,
        showUpRate: o.showUpRate,
      };
    }));
  }

  /** Customers per Sales Office (§XXXI), respecting a scoped user's single office. */
  async byOffice(options = {}) {
    return Promise.all((await this.masterData.listOffices())
      .filter((o) => !options.scopeOfficeId || o.id === options.scopeOfficeId)
      .map(async (office) => {
        const o = await this.overview({ ...options, scopeOfficeId: null, salesOfficeId: office.id });
        return {
          salesOfficeId: office.id,
          salesOfficeName: office.name,
          registrations: o.registrations,
          customers: o.customers,
          people: o.people,
          newCustomers: o.newCustomers,
          returningCustomers: o.returningCustomers,
          arrivedRegistrations: o.arrivedRegistrations,
          arrivedPeople: o.arrivedPeople,
          noShow: o.noShow,
          showUpRate: o.showUpRate,
          averagePartySize: o.averagePartySize,
        };
      }));
  }

  /** Which agencies actually bring customers through the door (§XXII). */
  async byAgency(options = {}) {
    const { sql, params } = this.#where({ ...options, visitorType: VISITOR_TYPES.AGENCY });
    const rows = await this.db.prepare(`
      SELECT COALESCE(r.agency_id, '?') AS "agencyId",
             COALESCE(r.agency_name, '—') AS "agencyName",
             COUNT(*) AS registrations,
             COUNT(DISTINCT ${CUSTOMER_KEY}) AS customers,
             COALESCE(SUM(r.number_of_visitors), 0) AS people,
             COALESCE(SUM(c.actual_guests), 0) AS "arrivedPeople",
             COUNT(DISTINCT COALESCE(NULLIF(r.sales_staff_cccd, ''), r.sales_staff_name)) AS "salesStaff",
             COALESCE(SUM(CASE WHEN r.status IN ('CHECKED_IN','IN_VISIT','COMPLETED') THEN 1 ELSE 0 END), 0) AS arrived,
             COALESCE(SUM(CASE WHEN r.status = 'NO_SHOW' THEN 1 ELSE 0 END), 0) AS "noShow",
             COALESCE(SUM(CASE WHEN r.status = 'CANCELLED' THEN 1 ELSE 0 END), 0) AS cancelled
      FROM registrations r LEFT JOIN checkins c ON c.registration_id = r.id ${sql}
      GROUP BY "agencyId", "agencyName"
      ORDER BY registrations DESC, "agencyName" ASC`).all(...params);

    return rows.map((r) => ({
      agencyId: r.agencyId,
      agencyName: r.agencyName,
      registrations: num(r.registrations),
      customers: num(r.customers),
      people: num(r.people),
      salesStaff: num(r.salesStaff),
      arrived: num(r.arrived),
      arrivedPeople: num(r.arrivedPeople),
      noShow: num(r.noShow),
      cancelled: num(r.cancelled),
      showUpRate: rate(num(r.arrived), num(r.registrations) - num(r.cancelled)),
    }));
  }

  /** The sales staff bringing customers in, across agencies (§XXII). */
  async topSalesStaff(options = {}, { limit = 20 } = {}) {
    const { sql, params } = this.#where({ ...options, visitorType: VISITOR_TYPES.AGENCY });
    const rows = await this.db.prepare(`
      SELECT ${STAFF_NAME} AS name,
             COALESCE(r.agency_name, '—') AS "agencyName",
             COUNT(*) AS registrations,
             COUNT(DISTINCT ${CUSTOMER_KEY}) AS customers,
             COALESCE(SUM(r.number_of_visitors), 0) AS people,
             COALESCE(SUM(c.actual_guests), 0) AS "arrivedPeople",
             COALESCE(SUM(CASE WHEN r.status IN ('CHECKED_IN','IN_VISIT','COMPLETED') THEN 1 ELSE 0 END), 0) AS arrived
      FROM registrations r LEFT JOIN checkins c ON c.registration_id = r.id ${sql}
      GROUP BY COALESCE(NULLIF(r.sales_staff_cccd, ''), ${STAFF_NAME}), ${STAFF_NAME},
               COALESCE(r.agency_name, '—')
      ORDER BY registrations DESC, name ASC
      LIMIT ?`).all(...params, Math.min(Math.max(Number(limit) || 20, 1), 200));

    return rows.map((r) => ({
      salesStaffName: r.name,
      agencyName: r.agencyName,
      registrations: num(r.registrations),
      customers: num(r.customers),
      people: num(r.people),
      arrived: num(r.arrived),
      arrivedPeople: num(r.arrivedPeople),
    }));
  }

  /** The customers who come back most often. */
  async topCustomers(options = {}, { limit = 20 } = {}) {
    const { sql, params } = this.#where(options);
    const rows = await this.db.prepare(`
      SELECT ${CUSTOMER_KEY} AS k,
             r.visitor_type AS "visitorType",
             COUNT(*) AS visits,
             COALESCE(SUM(r.number_of_visitors), 0) AS people,
             COALESCE(SUM(CASE WHEN r.status IN ('CHECKED_IN','IN_VISIT','COMPLETED') THEN 1 ELSE 0 END), 0) AS arrived,
             MIN(r.visit_date) AS "firstVisit",
             MAX(r.visit_date) AS "lastVisit",
             MAX(COALESCE(NULLIF(r.full_name, ''), NULLIF(r.customer_short_name, ''), '—')) AS name,
             MAX(COALESCE(r.agency_name, '')) AS "agencyName"
      FROM registrations r ${sql}
      GROUP BY k, r.visitor_type
      ORDER BY visits DESC, "lastVisit" DESC
      LIMIT ?`).all(...params, Math.min(Math.max(Number(limit) || 20, 1), 200));

    return rows.map((r) => ({
      name: r.name,
      visitorType: r.visitorType,
      agencyName: r.agencyName || null,
      visits: num(r.visits),
      people: num(r.people),
      arrived: num(r.arrived),
      firstVisit: r.firstVisit,
      lastVisit: r.lastVisit,
    }));
  }

  /** When customers choose to come: by time slot (§XLIV). */
  async byTimeSlot(options = {}) {
    const { sql, params } = this.#where(options);
    const rows = await this.db.prepare(`
      SELECT r.time_slot_id AS "slotId",
             COUNT(*) AS registrations,
             COUNT(DISTINCT ${CUSTOMER_KEY}) AS customers,
             COALESCE(SUM(r.number_of_visitors), 0) AS people,
             COALESCE(SUM(c.actual_guests), 0) AS "arrivedPeople",
             COALESCE(SUM(CASE WHEN r.status IN ('CHECKED_IN','IN_VISIT','COMPLETED') THEN 1 ELSE 0 END), 0) AS arrived,
             COALESCE(SUM(CASE WHEN r.status = 'NO_SHOW' THEN 1 ELSE 0 END), 0) AS "noShow",
             COALESCE(SUM(CASE WHEN r.status = 'CANCELLED' THEN 1 ELSE 0 END), 0) AS cancelled
      FROM registrations r LEFT JOIN checkins c ON c.registration_id = r.id ${sql}
      GROUP BY "slotId"`).all(...params);

    return (await this.masterData.listSlots()).map((slot) => {
      const r = rows.find((x) => x.slotId === slot.id) || {};
      const registrations = num(r.registrations);
      return {
        slotId: slot.id,
        label: slot.label,
        capacity: slot.capacity,
        registrations,
        customers: num(r.customers),
        people: num(r.people),
        arrived: num(r.arrived),
        arrivedPeople: num(r.arrivedPeople),
        noShow: num(r.noShow),
        showUpRate: rate(num(r.arrived), registrations - num(r.cancelled)),
      };
    });
  }

  /** Which days of the week customers prefer. */
  async byWeekday(options = {}) {
    const { sql, params } = this.#where(options);
    const rows = await this.db.prepare(`
      SELECT EXTRACT(DOW FROM r.visit_date::date)::int AS weekday,
             COUNT(*) AS registrations,
             COUNT(DISTINCT ${CUSTOMER_KEY}) AS customers,
             COALESCE(SUM(r.number_of_visitors), 0) AS people,
             COALESCE(SUM(c.actual_guests), 0) AS "arrivedPeople",
             COALESCE(SUM(CASE WHEN r.status IN ('CHECKED_IN','IN_VISIT','COMPLETED') THEN 1 ELSE 0 END), 0) AS arrived
      FROM registrations r LEFT JOIN checkins c ON c.registration_id = r.id ${sql}
      GROUP BY weekday`).all(...params);

    return DAY_NAMES.map((label, weekday) => {
      const r = rows.find((x) => num(x.weekday) === weekday) || {};
      return {
        weekday,
        label,
        registrations: num(r.registrations),
        customers: num(r.customers),
        people: num(r.people),
        arrived: num(r.arrived),
        arrivedPeople: num(r.arrivedPeople),
      };
    });
  }

  /** How big the groups are — the number that drives slot capacity. */
  async partySizes(options = {}) {
    const { sql, params } = this.#where(options);
    const rows = await this.db.prepare(`
      SELECT r.number_of_visitors AS size, COUNT(*) AS registrations,
             COALESCE(SUM(r.number_of_visitors), 0) AS people
      FROM registrations r ${sql}
      GROUP BY size ORDER BY size ASC`).all(...params);
    const total = rows.reduce((a, r) => a + num(r.registrations), 0);
    return rows.map((r) => ({
      size: num(r.size),
      registrations: num(r.registrations),
      people: num(r.people),
      share: rate(num(r.registrations), total),
    }));
  }

  /** Day-by-day trend over the filtered window. */
  async dailyTrend(options = {}) {
    const { sql, params } = this.#where(options);
    const rows = await this.db.prepare(`
      SELECT r.visit_date AS date,
             COUNT(*) AS registrations,
             COUNT(DISTINCT ${CUSTOMER_KEY}) AS customers,
             COALESCE(SUM(r.number_of_visitors), 0) AS people,
             COALESCE(SUM(c.actual_guests), 0) AS "arrivedPeople",
             COALESCE(SUM(CASE WHEN r.status IN ('CHECKED_IN','IN_VISIT','COMPLETED') THEN 1 ELSE 0 END), 0) AS arrived,
             COALESCE(SUM(CASE WHEN r.status = 'NO_SHOW' THEN 1 ELSE 0 END), 0) AS "noShow",
             COALESCE(SUM(CASE WHEN r.status = 'CANCELLED' THEN 1 ELSE 0 END), 0) AS cancelled
      FROM registrations r LEFT JOIN checkins c ON c.registration_id = r.id ${sql}
      GROUP BY date ORDER BY date ASC`).all(...params);

    return rows.map((r) => ({
      date: r.date,
      registrations: num(r.registrations),
      customers: num(r.customers),
      people: num(r.people),
      arrived: num(r.arrived),
      arrivedPeople: num(r.arrivedPeople),
      noShow: num(r.noShow),
      cancelled: num(r.cancelled),
    }));
  }

  /**
   * What actually happened at the door, from the receptionists' check-in records:
   * people counted against people booked, and how arrivals compared with the
   * slots they had booked.
   */
  async attendance(options = {}) {
    const { sql, params } = this.#where(options);
    const row = await this.db.prepare(`
      SELECT COUNT(*) AS checkins,
             COALESCE(SUM(c.expected_guests), 0) AS booked,
             COALESCE(SUM(c.actual_guests), 0) AS actual,
             COALESCE(SUM(CASE WHEN c.actual_guests = c.expected_guests THEN 1 ELSE 0 END), 0) AS matched,
             COALESCE(SUM(CASE WHEN c.actual_guests > c.expected_guests THEN 1 ELSE 0 END), 0) AS more,
             COALESCE(SUM(CASE WHEN c.actual_guests < c.expected_guests THEN 1 ELSE 0 END), 0) AS fewer,
             COALESCE(SUM(CASE WHEN c.arrival_status = 'ON_TIME' THEN 1 ELSE 0 END), 0) AS "onTime",
             COALESCE(SUM(CASE WHEN c.arrival_status = 'LATE' THEN 1 ELSE 0 END), 0) AS late,
             COALESCE(SUM(CASE WHEN c.arrival_status = 'EARLY' THEN 1 ELSE 0 END), 0) AS early,
             COALESCE(SUM(CASE WHEN c.arrival_status = 'AFTER_SLOT' THEN 1 ELSE 0 END), 0) AS "afterSlot",
             COALESCE(SUM(CASE WHEN c.arrival_status = 'OTHER_DAY' THEN 1 ELSE 0 END), 0) AS "otherDay",
             COALESCE(SUM(c.time_override), 0) AS overrides,
             AVG(CASE WHEN c.arrival_status = 'LATE' THEN c.minutes_from_slot_start END) AS "avgLate"
      FROM checkins c
      JOIN registrations r ON r.id = c.registration_id
      ${sql}`).get(...params);

    const checkins = num(row.checkins);
    return {
      checkins,
      bookedPeople: num(row.booked),
      actualPeople: num(row.actual),
      variance: num(row.actual) - num(row.booked),
      matched: num(row.matched),
      arrivedWithMore: num(row.more),
      arrivedWithFewer: num(row.fewer),
      punctuality: {
        onTime: num(row.onTime),
        late: num(row.late),
        early: num(row.early),
        afterSlot: num(row.afterSlot),
        otherDay: num(row.otherDay),
      },
      onTimeRate: rate(num(row.onTime), checkins),
      averageLateMinutes: row.avgLate == null ? 0 : Number(Number(row.avgLate).toFixed(0)),
      // Check-ins the desk had to confirm because they fell outside the slot or day.
      confirmedOutsideSlot: num(row.overrides),
    };
  }

  /** One line per check-in, newest first — the record behind the totals. */
  async checkinRecords(options = {}, { limit = 2000 } = {}) {
    const { sql, params } = this.#where(options);
    const rows = await this.db.prepare(`
      SELECT c.checkin_time AS "checkinTime", c.receptionist_name AS "receptionistName",
             c.expected_guests AS "expectedGuests", c.actual_guests AS "actualGuests",
             c.arrival_status AS "arrivalStatus", c.minutes_from_slot_start AS "minutesFromSlotStart",
             c.admitted_slot_id AS "admittedSlotId", c.time_override AS "timeOverride",
             r.confirmation_code AS "confirmationCode", r.visitor_type AS "visitorType",
             r.sales_office_id AS "salesOfficeId", r.visit_date AS "visitDate",
             r.time_slot_id AS "timeSlotId",
             COALESCE(r.agency_name, '') AS "agencyName"
      FROM checkins c
      JOIN registrations r ON r.id = c.registration_id
      ${sql}
      ORDER BY c.checkin_time DESC
      LIMIT ?`).all(...params, Math.min(Math.max(Number(limit) || 2000, 1), 5000));

    return rows.map((r) => ({
      ...r,
      expectedGuests: num(r.expectedGuests),
      actualGuests: num(r.actualGuests),
      variance: num(r.actualGuests) - num(r.expectedGuests),
      minutesFromSlotStart: r.minutesFromSlotStart == null ? null : Number(r.minutesFromSlotStart),
      timeOverride: num(r.timeOverride) === 1,
      agencyName: r.agencyName || null,
    }));
  }

  /** Everything the statistics screen and its export need, in one read. */
  async summary(options = {}) {
    return {
      filters: {
        salesOfficeId: options.salesOfficeId ?? options.scopeOfficeId ?? null,
        visitorType: options.visitorType ?? null,
        agencyId: options.agencyId ?? null,
        dateFrom: options.dateFrom ?? null,
        dateTo: options.dateTo ?? null,
      },
      overview: await this.overview(options),
      bySource: await this.bySource(options),
      byOffice: await this.byOffice(options),
      byAgency: await this.byAgency(options),
      topSalesStaff: await this.topSalesStaff(options),
      topCustomers: await this.topCustomers(options),
      byTimeSlot: await this.byTimeSlot(options),
      byWeekday: await this.byWeekday(options),
      partySizes: await this.partySizes(options),
      dailyTrend: await this.dailyTrend(options),
      attendance: await this.attendance(options),
      checkinRecords: await this.checkinRecords(options),
    };
  }
}

module.exports = { CustomerStatsService, customerKey, CUSTOMER_KEY, DAY_NAMES };
