'use strict';

const { mapOffice, mapSlot, mapAgency } = require('./mappers');
const { notFound, badRequest } = require('../domain/errors');
const { SLOT_CAPACITY } = require('../config/master-data');

/**
 * A slot holding nobody is simply inactive. The ceiling is the business limit of
 * 30 guests per slot: an administrator may lower a slot below it, never raise
 * one above it.
 */
const MIN_SLOT_CAPACITY = 1;
const MAX_SLOT_CAPACITY = SLOT_CAPACITY;

class MasterDataService {
  constructor(db) {
    this.db = db;
  }

  async listOffices() {
    return (await this.db.prepare('SELECT * FROM sales_offices ORDER BY name').all()).map(mapOffice);
  }

  async getOffice(id) {
    return mapOffice(await this.db.prepare('SELECT * FROM sales_offices WHERE id = ?').get(id));
  }

  async requireOffice(id) {
    const o = await this.getOffice(id);
    if (!o) throw notFound('SALES_OFFICE_NOT_FOUND', `Sales office "${id}" not found.`);
    return o;
  }

  async listSlots({ includeInactive = false } = {}) {
    const sql = includeInactive
      ? 'SELECT * FROM time_slots ORDER BY sort_order'
      : 'SELECT * FROM time_slots WHERE active = 1 ORDER BY sort_order';
    return (await this.db.prepare(sql).all()).map(mapSlot);
  }

  async getSlot(id) {
    return mapSlot(await this.db.prepare('SELECT * FROM time_slots WHERE id = ?').get(id));
  }

  async requireSlot(id) {
    const s = await this.getSlot(id);
    if (!s) throw notFound('TIME_SLOT_NOT_FOUND', `Time slot "${id}" not found.`);
    return s;
  }

  async listAgencies({ includeInactive = false } = {}) {
    const sql = includeInactive
      ? 'SELECT * FROM agencies ORDER BY sort_order, name'
      : 'SELECT * FROM agencies WHERE active = 1 ORDER BY sort_order, name';
    return (await this.db.prepare(sql).all()).map(mapAgency);
  }

  /** §XXXIX Administrator — manage Agency master data. */
  async upsertAgency({ id, name, active = true }) {
    await this.db.prepare(`
      INSERT INTO agencies (id, name, active) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, active = excluded.active`
    ).run(id, name, active ? 1 : 0);
    return mapAgency(await this.db.prepare('SELECT * FROM agencies WHERE id = ?').get(id));
  }

  /**
   * §XXXIX Administrator — change a slot's capacity, or take it out of service.
   *
   * Lowering capacity is allowed even when a future date already holds more
   * people than the new figure: those visitors have been told to come, and
   * cancelling them is a decision about real people. The affected dates are
   * reported instead, so the administrator can see what they have just done.
   */
  async updateSlot(id, { capacity, active }) {
    const existing = await this.getSlot(id);
    if (!existing) throw notFound('TIME_SLOT_NOT_FOUND', `Time slot "${id}" not found.`);

    let nextCapacity = existing.capacity;
    if (capacity !== undefined && capacity !== null && capacity !== '') {
      nextCapacity = Number(capacity);
      if (!Number.isInteger(nextCapacity) || nextCapacity < MIN_SLOT_CAPACITY
        || nextCapacity > MAX_SLOT_CAPACITY) {
        throw badRequest('INVALID_CAPACITY',
          `Capacity must be a whole number between ${MIN_SLOT_CAPACITY} and ${MAX_SLOT_CAPACITY}.`);
      }
    }
    const nextActive = (active ?? existing.active) ? 1 : 0;

    await this.db.prepare('UPDATE time_slots SET capacity = ?, active = ? WHERE id = ?')
      .run(nextCapacity, nextActive, id);

    const slot = await this.getSlot(id);
    slot.previousCapacity = existing.capacity;
    slot.overbookedDates = nextCapacity < existing.capacity
      ? await this.#datesOverCapacity(id, nextCapacity)
      : [];
    return slot;
  }

  /** Future dates whose bookings already exceed a proposed capacity. */
  async #datesOverCapacity(timeSlotId, capacity) {
    const rows = await this.db.prepare(`
      SELECT visit_date AS date, sales_office_id AS "salesOfficeId",
             COALESCE(SUM(number_of_visitors), 0) AS booked
      FROM registrations
      WHERE time_slot_id = ? AND status NOT IN ('CANCELLED', 'NO_SHOW')
      GROUP BY visit_date, sales_office_id
      HAVING COALESCE(SUM(number_of_visitors), 0) > ?
      ORDER BY visit_date`).all(timeSlotId, capacity);
    return rows.map((r) => ({ ...r, booked: Number(r.booked), capacity }));
  }
}

module.exports = { MasterDataService, MIN_SLOT_CAPACITY, MAX_SLOT_CAPACITY };
