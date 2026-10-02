'use strict';

const { VISITOR_TYPES } = require('../config/master-data');
const { toDateString, startOfWeek, addDays, monthRange, isValidDateString } = require('../domain/dates');
const { badRequest } = require('../domain/errors');

/**
 * §XXXV–§XXXVI — Calendar.
 * Events are projected directly from Registration rows: there is no calendar table,
 * so no duplicate data can drift out of sync (§XXXV, §Rule 17, §XLVI.14/17).
 * Each event carries registrationId so a click opens the Registration detail.
 */
class CalendarService {
  constructor({ db, registrations, masterData, blocks = null, clock = () => new Date() }) {
    this.db = db;
    this.registrations = registrations;
    this.masterData = masterData;
    this.blocks = blocks;
    this.clock = clock;
  }

  today() { return toDateString(this.clock()); }

  range(view, anchorDate) {
    const anchor = anchorDate || this.today();
    if (!isValidDateString(anchor)) {
      throw badRequest('INVALID_DATE', 'date must be a valid YYYY-MM-DD date.');
    }
    switch (view) {
      case 'day': return { view, from: anchor, to: anchor };
      case 'week': {
        const from = startOfWeek(anchor);
        return { view, from, to: addDays(from, 6) };
      }
      case 'month': return { view, ...monthRange(anchor) };
      default:
        throw badRequest('INVALID_CALENDAR_VIEW', 'view must be one of: day, week, month.');
    }
  }

  async events({ view = 'day', date = null, scopeOfficeId = null, salesOfficeId = null, visitorType = null, status = null } = {}) {
    const { from, to } = this.range(view, date);

    const where = ['r.visit_date BETWEEN ? AND ?'];
    const params = [from, to];
    if (scopeOfficeId) { where.push('r.sales_office_id = ?'); params.push(scopeOfficeId); }
    if (salesOfficeId) { where.push('r.sales_office_id = ?'); params.push(salesOfficeId); }
    if (visitorType) { where.push('r.visitor_type = ?'); params.push(visitorType); }
    if (status) {
      const list = Array.isArray(status) ? status : [status];
      where.push(`r.status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }

    const rows = await this.db.prepare(`
      SELECT r.*, s.label AS slot_label, s.start_time, s.end_time, s.sort_order, o.name AS office_name
      FROM registrations r
      JOIN time_slots s ON s.id = r.time_slot_id
      JOIN sales_offices o ON o.id = r.sales_office_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.visit_date ASC, s.sort_order ASC, r.created_at ASC`).all(...params);

    const events = rows.map((row) => ({
      // Reference back to the single source of truth.
      registrationId: row.id,
      confirmationCode: row.confirmation_code,
      date: row.visit_date,
      timeSlotId: row.time_slot_id,
      timeLabel: row.slot_label,
      startTime: row.start_time,
      endTime: row.end_time,
      title: row.visitor_type === VISITOR_TYPES.VISITOR ? row.full_name : row.agency_name,
      subtitle: row.visitor_type === VISITOR_TYPES.VISITOR
        ? 'Khách Tham Quan'
        : `Sales: ${row.sales_staff_name}`,
      visitorType: row.visitor_type,
      salesOfficeId: row.sales_office_id,
      salesOfficeName: row.office_name,
      numberOfVisitors: row.number_of_visitors,
      status: row.status,
    }));

    return { view, from, to, count: events.length, events };
  }

  /** Grouped shape the month/week grid renders directly. */
  async groupedByDate(options) {
    const result = await this.events(options);
    const map = new Map();
    for (const ev of result.events) {
      if (!map.has(ev.date)) map.set(ev.date, []);
      map.get(ev.date).push(ev);
    }
    // Days an administrator has closed, so the calendar shows why a day is empty
    // rather than leaving the desk to guess.
    const blocks = this.blocks
      ? await this.blocks.list({ from: result.from, to: result.to, salesOfficeId: options.salesOfficeId || options.scopeOfficeId || null })
      : [];

    const days = [];
    for (let d = result.from; d <= result.to; d = addDays(d, 1)) {
      const onThisDay = blocks.filter((b) => b.startDate <= d && b.endDate >= d);
      days.push({
        date: d,
        events: map.get(d) ?? [],
        blocks: onThisDay,
        // A block with no time slot closes the whole day; one with a slot closes
        // only that slot, and the day is still open for the others.
        fullyBlocked: onThisDay.some((b) => b.timeSlotId === null),
      });
    }
    return { ...result, days, blocks };
  }
}

module.exports = { CalendarService };
