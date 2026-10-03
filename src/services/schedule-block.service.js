'use strict';

const { randomUUID } = require('node:crypto');
const { badRequest, notFound, conflict } = require('../domain/errors');
const { isValidDateString } = require('../domain/dates');
const { STATUS } = require('../domain/status');

/**
 * Blocked periods — an administrator closing the show house.
 *
 * A block is a date range (inclusive at both ends), optionally narrowed to one
 * Sales Office and one time slot. A single blocked day is a range whose ends are
 * equal, so one shape covers "Tết, both offices, all week", "this Saturday
 * morning at CII" and everything between.
 *
 * The rule is enforced where a registration is created, not only in the form
 * (§Rule 4): a visitor who kept a stale page open, or anyone posting straight to
 * the API, is refused just the same.
 */
class ScheduleBlockService {
  constructor({ db, masterData, clock = () => new Date() }) {
    this.db = db;
    this.masterData = masterData;
    this.clock = clock;
  }

  #map(row) {
    if (!row) return null;
    return {
      id: row.id,
      salesOfficeId: row.sales_office_id ?? null,
      timeSlotId: row.time_slot_id ?? null,
      startDate: row.start_date,
      endDate: row.end_date,
      reason: row.reason ?? null,
      createdBy: row.created_by,
      createdByName: row.created_by_name,
      createdAt: row.created_at,
    };
  }

  /** Every block, newest first; `from`/`to` keep it to a window when asked. */
  async list({ from = null, to = null, salesOfficeId = null } = {}) {
    const where = [];
    const params = [];
    // Two ranges overlap when each starts before the other ends.
    if (to) { where.push('start_date <= ?'); params.push(to); }
    if (from) { where.push('end_date >= ?'); params.push(from); }
    if (salesOfficeId) {
      where.push('(sales_office_id IS NULL OR sales_office_id = ?)');
      params.push(salesOfficeId);
    }
    const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await this.db.prepare(
      `SELECT * FROM blocked_periods ${sql} ORDER BY start_date DESC, created_at DESC`,
    ).all(...params);
    return rows.map((r) => this.#map(r));
  }

  /**
   * The blocks covering one office + date, most specific last.
   * A block with no office applies to every office; one with no slot closes the
   * whole day.
   */
  async blocksFor(salesOfficeId, date) {
    const rows = await this.db.prepare(`
      SELECT * FROM blocked_periods
      WHERE start_date <= ? AND end_date >= ?
        AND (sales_office_id IS NULL OR sales_office_id = ?)
      ORDER BY time_slot_id NULLS FIRST`).all(date, date, salesOfficeId);
    return rows.map((r) => this.#map(r));
  }

  /**
   * Is this exact office + date + slot closed?
   * @returns {{blocked: boolean, block: object|null}}
   */
  async check(salesOfficeId, date, timeSlotId = null) {
    const blocks = await this.blocksFor(salesOfficeId, date);
    const hit = blocks.find((b) => b.timeSlotId === null || b.timeSlotId === timeSlotId);
    return { blocked: Boolean(hit), block: hit ?? null };
  }

  /** Throws when the slot is closed, so callers need no second branch. */
  async assertOpen(salesOfficeId, date, timeSlotId) {
    const { blocked, block } = await this.check(salesOfficeId, date, timeSlotId);
    if (blocked) {
      throw conflict('PERIOD_BLOCKED',
        block.reason
          ? `This time is closed for registration: ${block.reason}`
          : 'This time is closed for registration. Please choose another date or time slot.',
        { startDate: block.startDate, endDate: block.endDate, timeSlotId: block.timeSlotId });
    }
  }

  async create({
    salesOfficeId = null, timeSlotId = null, startDate, endDate = null, reason = null,
  }, { actor }) {
    if (!isValidDateString(startDate)) {
      throw badRequest('INVALID_DATE', 'startDate must be a valid YYYY-MM-DD date.');
    }
    const finish = endDate || startDate;
    if (!isValidDateString(finish)) {
      throw badRequest('INVALID_DATE', 'endDate must be a valid YYYY-MM-DD date.');
    }
    if (finish < startDate) {
      throw badRequest('INVALID_RANGE', 'endDate cannot be before startDate.');
    }
    if (salesOfficeId) await this.masterData.requireOffice(salesOfficeId);
    if (timeSlotId) await this.masterData.requireSlot(timeSlotId);

    const row = {
      id: randomUUID(),
      salesOfficeId,
      timeSlotId,
      startDate,
      endDate: finish,
      reason: reason ? String(reason).trim().slice(0, 300) : null,
    };

    await this.db.prepare(`
      INSERT INTO blocked_periods (id, sales_office_id, time_slot_id, start_date, end_date,
                                   reason, created_by, created_by_name, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      row.id, row.salesOfficeId, row.timeSlotId, row.startDate, row.endDate, row.reason,
      actor.id, actor.name, this.clock().toISOString(),
    );

    const created = this.#map(await this.db.prepare('SELECT * FROM blocked_periods WHERE id = ?').get(row.id));
    // Blocking a period does not cancel what is already booked inside it — that
    // is a decision about real visitors, so the count is reported and the
    // administrator decides what to do with them.
    created.affectedRegistrations = await this.countAffected(created);
    return created;
  }

  /** Live registrations already booked inside a block. */
  async countAffected(block) {
    const where = ['visit_date >= ?', 'visit_date <= ?', 'status NOT IN (?, ?)'];
    const params = [block.startDate, block.endDate, STATUS.CANCELLED, STATUS.NO_SHOW];
    if (block.salesOfficeId) { where.push('sales_office_id = ?'); params.push(block.salesOfficeId); }
    if (block.timeSlotId) { where.push('time_slot_id = ?'); params.push(block.timeSlotId); }
    const { n } = await this.db.prepare(
      `SELECT COUNT(*) AS n FROM registrations WHERE ${where.join(' AND ')}`,
    ).get(...params);
    return Number(n);
  }

  async remove(id) {
    const row = await this.db.prepare('SELECT * FROM blocked_periods WHERE id = ?').get(id);
    if (!row) throw notFound('BLOCK_NOT_FOUND', 'No such blocked period.');
    await this.db.prepare('DELETE FROM blocked_periods WHERE id = ?').run(id);
    return { id, removed: true };
  }
}

module.exports = { ScheduleBlockService };
