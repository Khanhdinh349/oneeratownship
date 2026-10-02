'use strict';

const { VISITOR_TYPES, VEHICLE_TYPES } = require('../config/master-data');
const { STATUS, FUNNEL } = require('../domain/status');
const { toDateString, startOfWeek, monthRange, addDays } = require('../domain/dates');

/**
 * §XXX–§XXXIV / §XLIV — Dashboard.
 * Every number is a live aggregate over `registrations` + `checkins` (§Rule 8,
 * §XLVI.13). Nothing is precomputed or stored separately.
 */
class DashboardService {
  constructor({ db, masterData, clock = () => new Date() }) {
    this.db = db;
    this.masterData = masterData;
    this.clock = clock;
  }

  today() { return toDateString(this.clock()); }

  #filters({ scopeOfficeId, salesOfficeId, visitorType, dateFrom, dateTo, timeSlotId }) {
    const where = [];
    const params = [];
    if (scopeOfficeId) { where.push('sales_office_id = ?'); params.push(scopeOfficeId); }
    if (salesOfficeId) { where.push('sales_office_id = ?'); params.push(salesOfficeId); }
    if (visitorType) { where.push('visitor_type = ?'); params.push(visitorType); }
    if (timeSlotId) { where.push('time_slot_id = ?'); params.push(timeSlotId); }
    if (dateFrom) { where.push('visit_date >= ?'); params.push(dateFrom); }
    if (dateTo) { where.push('visit_date <= ?'); params.push(dateTo); }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  async #countsByStatus(filters) {
    const { sql, params } = this.#filters(filters);
    const rows = await this.db.prepare(`
      SELECT status, COUNT(*) AS registrations, COALESCE(SUM(number_of_visitors), 0) AS people
      FROM registrations ${sql} GROUP BY status`).all(...params);

    const byStatus = {};
    for (const s of Object.values(STATUS)) byStatus[s] = { registrations: 0, people: 0 };
    for (const r of rows) {
      byStatus[r.status] = { registrations: Number(r.registrations), people: Number(r.people) };
    }
    return byStatus;
  }

  /** §XXX — KPI block. */
  async kpis(options = {}) {
    const today = this.today();
    const all = await this.#countsByStatus(options);
    const todayCounts = await this.#countsByStatus({ ...options, dateFrom: today, dateTo: today });

    const sum = (counts, statuses, key) =>
      statuses.reduce((acc, s) => acc + counts[s][key], 0);

    const arrived = [STATUS.CHECKED_IN, STATUS.IN_VISIT, STATUS.COMPLETED];
    const pending = [STATUS.REGISTERED, STATUS.CONFIRMED, STATUS.EXPECTED];
    // §XXX "Expected Visitors — khách dự kiến đến" is everyone still due at the
    // office, i.e. every registration that was not cancelled. §XXXIII's example
    // then holds exactly: Expected 50 = Checked In 42 + No Show 8.
    const dueToArrive = [...pending, ...arrived, STATUS.NO_SHOW];

    return {
      asOf: this.clock().toISOString(),
      today,
      totalRegistration: sum(all, Object.values(STATUS), 'registrations'),
      totalPeople: sum(all, Object.values(STATUS), 'people'),
      todaysVisitors: sum(todayCounts, Object.values(STATUS), 'registrations'),
      todaysPeople: sum(todayCounts, Object.values(STATUS), 'people'),
      expected: sum(all, dueToArrive, 'registrations'),
      pending: sum(all, pending, 'registrations'),
      checkedIn: sum(all, arrived, 'registrations'),
      inVisit: all[STATUS.IN_VISIT].registrations,
      completed: all[STATUS.COMPLETED].registrations,
      noShow: all[STATUS.NO_SHOW].registrations,
      cancelled: all[STATUS.CANCELLED].registrations,
      byStatus: all,
    };
  }

  /** §XXXI — breakdown per Sales Office (respecting a receptionist's scope). */
  async byOffice(options = {}) {
    const offices = (await this.masterData.listOffices())
      .filter((o) => !options.scopeOfficeId || o.id === options.scopeOfficeId);
    return Promise.all(offices.map(async (office) => {
      const counts = await this.#countsByStatus({ ...options, scopeOfficeId: null, salesOfficeId: office.id });
      return {
        salesOfficeId: office.id,
        salesOfficeName: office.name,
        parkingTicketEnabled: office.parkingTicketEnabled,
        registration: Object.values(STATUS).reduce((a, s) => a + counts[s].registrations, 0),
        expected: counts[STATUS.REGISTERED].registrations + counts[STATUS.CONFIRMED].registrations
          + counts[STATUS.EXPECTED].registrations,
        checkedIn: counts[STATUS.CHECKED_IN].registrations + counts[STATUS.IN_VISIT].registrations
          + counts[STATUS.COMPLETED].registrations,
        completed: counts[STATUS.COMPLETED].registrations,
        noShow: counts[STATUS.NO_SHOW].registrations,
        cancelled: counts[STATUS.CANCELLED].registrations,
      };
    }));
  }

  /** §XXXII — breakdown per Visitor Type, bucketed by day / week / month. */
  async byVisitorType(options = {}) {
    const result = {};
    for (const type of Object.values(VISITOR_TYPES)) {
      const counts = await this.#countsByStatus({ ...options, visitorType: type });
      result[type] = {
        registrations: Object.values(STATUS).reduce((a, s) => a + counts[s].registrations, 0),
        people: Object.values(STATUS).reduce((a, s) => a + counts[s].people, 0),
      };
    }
    return result;
  }

  /** §XXXII — day / week / month rollup. */
  async periodBreakdown(options = {}) {
    const today = this.today();
    const week = { from: startOfWeek(today), to: addDays(startOfWeek(today), 6) };
    const month = monthRange(today);
    return {
      day: {
        range: { from: today, to: today },
        byVisitorType: await this.byVisitorType({ ...options, dateFrom: today, dateTo: today }),
      },
      week: {
        range: week,
        byVisitorType: await this.byVisitorType({ ...options, dateFrom: week.from, dateTo: week.to }),
      },
      month: {
        range: month,
        byVisitorType: await this.byVisitorType({ ...options, dateFrom: month.from, dateTo: month.to }),
      },
    };
  }

  /**
   * §XXXIII — check-in funnel.
   *
   * `stages` is cumulative by CURRENT status: a registration sitting at CHECKED_IN
   * has necessarily passed Registered/Confirmed/Expected, so each stage counts
   * everything at that stage or beyond. It is therefore monotonically
   * non-increasing and never double-counts.
   *
   * `expectedToArrive` / `arrived` / `noShow` are the operational trio from the
   * spec's own illustration, where Expected 50 = Checked In 42 + No Show 8.
   */
  async funnel(options = {}) {
    const counts = await this.#countsByStatus(options);
    const reached = (stage) => FUNNEL.slice(FUNNEL.indexOf(stage))
      .reduce((acc, s) => acc + counts[s].registrations, 0);

    const arrived = reached(STATUS.CHECKED_IN);
    const noShow = counts[STATUS.NO_SHOW].registrations;

    return {
      stages: FUNNEL.map((stage) => ({ stage, count: reached(stage) })),
      expectedToArrive: reached(STATUS.REGISTERED) + noShow,
      arrived,
      noShow,
      cancelled: counts[STATUS.CANCELLED].registrations,
    };
  }

  /**
   * §XXXIV / §XLIV — parking ticket KPIs for CII - Bình Thạnh, counted separately
   * for cars and motorbikes, with what is still out at the end of the day.
   */
  async parkingTickets(options = {}) {
    const offices = (await this.masterData.listOffices())
      .filter((o) => o.parkingTicketEnabled)
      .filter((o) => !options.scopeOfficeId || o.id === options.scopeOfficeId);

    return Promise.all(offices.map(async (office) => {
      const { sql, params } = this.#filters({ ...options, scopeOfficeId: null, salesOfficeId: office.id });
      const arrived = [STATUS.CHECKED_IN, STATUS.IN_VISIT, STATUS.COMPLETED];
      const extra = `${sql ? `${sql} AND` : 'WHERE'} status IN (${arrived.map(() => '?').join(',')})`;

      const visitors = await this.db.prepare(`
        SELECT COUNT(*) AS total_visitors, COALESCE(SUM(number_of_visitors), 0) AS total_people
        FROM registrations ${extra}`).get(...params, ...arrived);

      // Tickets are joined back to the registrations the same filter selects, so
      // the date range and visitor-type filters apply to them too.
      const byType = await this.db.prepare(`
        SELECT pt.vehicle_type AS "vehicleType",
               COUNT(*) AS issued,
               COALESCE(SUM(CASE WHEN pt.returned_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS returned
        FROM parking_tickets pt
        JOIN registrations r ON r.id = pt.registration_id
        WHERE pt.registration_id IN (SELECT id FROM registrations ${extra})
        GROUP BY pt.vehicle_type`).all(...params, ...arrived);

      const bucket = (type) => {
        const row = byType.find((b) => b.vehicleType === type);
        const issued = row ? Number(row.issued) : 0;
        const returned = row ? Number(row.returned) : 0;
        return { issued, returned, outstanding: issued - returned };
      };

      const car = bucket(VEHICLE_TYPES.CAR);
      const motorbike = bucket(VEHICLE_TYPES.MOTORBIKE);
      const issued = car.issued + motorbike.issued;

      const withTicket = Number((await this.db.prepare(`
        SELECT COUNT(DISTINCT pt.registration_id) AS n
        FROM parking_tickets pt
        WHERE pt.registration_id IN (SELECT id FROM registrations ${extra})`)
        .get(...params, ...arrived)).n);

      const totalVisitors = Number(visitors.total_visitors);
      return {
        salesOfficeId: office.id,
        salesOfficeName: office.name,
        totalVisitors,
        totalPeople: Number(visitors.total_people),
        parkingTicketIssued: issued,
        parkingTicketReturned: car.returned + motorbike.returned,
        parkingTicketOutstanding: car.outstanding + motorbike.outstanding,
        registrationsWithTicket: withTicket,
        registrationsWithoutTicket: totalVisitors - withTicket,
        byVehicleType: { [VEHICLE_TYPES.CAR]: car, [VEHICLE_TYPES.MOTORBIKE]: motorbike },
        issueRate: totalVisitors === 0 ? 0 : Number((withTicket / totalVisitors).toFixed(4)),
      };
    }));
  }

  /**
   * §XXVIII — how the arrival counts compared with the bookings. A persistent gap
   * means the booked figures are not to be trusted for capacity planning.
   */
  async guestAccuracy(options = {}) {
    const { sql, params } = this.#filters(options);
    const arrived = [STATUS.CHECKED_IN, STATUS.IN_VISIT, STATUS.COMPLETED];
    const where = `${sql ? `${sql} AND` : 'WHERE'} status IN (${arrived.map(() => '?').join(',')})`;

    const row = await this.db.prepare(`
      SELECT COUNT(*) AS checkins,
             COALESCE(SUM(c.expected_guests), 0) AS expected,
             COALESCE(SUM(c.actual_guests), 0) AS actual,
             COALESCE(SUM(CASE WHEN c.actual_guests = c.expected_guests THEN 1 ELSE 0 END), 0) AS exact,
             COALESCE(SUM(CASE WHEN c.actual_guests > c.expected_guests THEN 1 ELSE 0 END), 0) AS more,
             COALESCE(SUM(CASE WHEN c.actual_guests < c.expected_guests THEN 1 ELSE 0 END), 0) AS fewer
      FROM checkins c
      WHERE c.registration_id IN (SELECT id FROM registrations ${where})`).get(...params, ...arrived);

    // How the same arrivals compared with the slots they had booked.
    const timing = await this.db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN c.arrival_status = 'ON_TIME' THEN 1 ELSE 0 END), 0) AS "onTime",
             COALESCE(SUM(CASE WHEN c.arrival_status = 'LATE' THEN 1 ELSE 0 END), 0) AS late,
             COALESCE(SUM(CASE WHEN c.arrival_status = 'EARLY' THEN 1 ELSE 0 END), 0) AS early,
             COALESCE(SUM(CASE WHEN c.arrival_status = 'AFTER_SLOT' THEN 1 ELSE 0 END), 0) AS "afterSlot",
             COALESCE(SUM(CASE WHEN c.arrival_status = 'OTHER_DAY' THEN 1 ELSE 0 END), 0) AS "otherDay"
      FROM checkins c
      WHERE c.registration_id IN (SELECT id FROM registrations ${where})`).get(...params, ...arrived);

    const checkins = Number(row.checkins);
    return {
      punctuality: {
        onTime: Number(timing.onTime),
        late: Number(timing.late),
        early: Number(timing.early),
        afterSlot: Number(timing.afterSlot),
        otherDay: Number(timing.otherDay),
      },
      checkins,
      expectedGuests: Number(row.expected),
      actualGuests: Number(row.actual),
      variance: Number(row.actual) - Number(row.expected),
      matched: Number(row.exact),
      arrivedWithMore: Number(row.more),
      arrivedWithFewer: Number(row.fewer),
      matchRate: checkins === 0 ? 0 : Number((Number(row.exact) / checkins).toFixed(4)),
    };
  }

  /** §XLIV — slot-level view for a given day. */
  async byTimeSlot(options = {}) {
    const slots = await this.masterData.listSlots();
    return Promise.all(slots.map(async (slot) => {
      const counts = await this.#countsByStatus({ ...options, timeSlotId: slot.id });
      return {
        slotId: slot.id,
        label: slot.label,
        capacity: slot.capacity,
        registrations: Object.values(STATUS).reduce((a, s) => a + counts[s].registrations, 0),
        people: Object.values(STATUS).reduce((a, s) => a + counts[s].people, 0),
        checkedIn: counts[STATUS.CHECKED_IN].registrations + counts[STATUS.IN_VISIT].registrations
          + counts[STATUS.COMPLETED].registrations,
        noShow: counts[STATUS.NO_SHOW].registrations,
      };
    }));
  }

  async summary(options = {}) {
    return {
      kpis: await this.kpis(options),
      byOffice: await this.byOffice(options),
      byVisitorType: await this.byVisitorType(options),
      periods: await this.periodBreakdown(options),
      funnel: await this.funnel(options),
      byTimeSlot: await this.byTimeSlot(options),
      parkingTickets: await this.parkingTickets(options),
      guestAccuracy: await this.guestAccuracy(options),
    };
  }
}

module.exports = { DashboardService };
