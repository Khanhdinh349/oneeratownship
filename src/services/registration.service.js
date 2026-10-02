'use strict';

const { randomUUID } = require('node:crypto');
const { VISITOR_TYPES } = require('../config/master-data');
const { STATUS, assertTransition, isCheckedInOrBeyond, CHECKIN_ELIGIBLE } = require('../domain/status');
const {
  generateUniqueConfirmationCode, generateQrToken, isWellFormedQrToken,
  normalizeConfirmationCode, isValidConfirmationCode,
} = require('../domain/codes');
const { validateRegistrationInput, assertNoErrors, normalizePhone, normalizeCccd } = require('../domain/validation');
const { toDateString, isValidDateString, minutesOfDay, parseHm } = require('../domain/dates');
const { badRequest, notFound, conflict, forbidden } = require('../domain/errors');
const { mapRegistration, mapHistory, mapCheckin, mapParkingTicket, stripSecrets } = require('./mappers');

const SYSTEM_ACTOR = { id: 'SYSTEM', name: 'System' };
const VISITOR_ACTOR = { id: 'VISITOR', name: 'Visitor (self-service)' };

/** The most rows one Excel export will ever build. Beyond this, narrow the filters. */
const EXPORT_ROW_LIMIT = 20000;

class RegistrationService {
  /**
   * @param {object} deps
   * @param {import('node:sqlite').DatabaseSync} deps.db
   * @param {MasterDataService} deps.masterData
   * @param {string} deps.qrSecret
   * @param {() => Date} [deps.clock] injectable clock so the 10-day rule is testable
   */
  constructor({ db, masterData, qrSecret, blocks = null, clock = () => new Date() }) {
    this.db = db;
    this.masterData = masterData;
    this.qrSecret = qrSecret;
    // Optional so a test can build the service on its own; when present, closed
    // periods are honoured here rather than only in the form.
    this.blocks = blocks;
    this.clock = clock;
  }

  now() { return this.clock().toISOString(); }

  today() { return toDateString(this.clock()); }

  // ---------------------------------------------------------------- availability

  /**
   * §VIII / §XLI Process 6 — availability for one office + date.
   * Capacity is counted in people (assumption A4). Cancelled and No-show
   * registrations release their seats.
   */
  async getAvailability(salesOfficeId, visitDate) {
    await this.masterData.requireOffice(salesOfficeId);
    if (!isValidDateString(visitDate)) {
      throw badRequest('INVALID_VISIT_DATE', 'visitDate must be a valid YYYY-MM-DD date.');
    }
    const slots = await this.masterData.listSlots();
    const bookedBySlot = await this.occupancy(salesOfficeId, visitDate);

    // A slot that has already ended cannot be booked. On an earlier date every
    // slot has; today it is those whose end time has gone by, on the business's
    // own clock rather than the server's.
    const today = this.today();
    const nowMinutes = minutesOfDay(this.clock());
    const hasPassed = (slot) => visitDate < today
      || (visitDate === today && nowMinutes >= parseHm(slot.endTime));

    // An administrator may have closed the whole day or one slot of it.
    const blocks = this.blocks ? await this.blocks.blocksFor(salesOfficeId, visitDate) : [];
    const blockFor = (slotId) => blocks.find((b) => b.timeSlotId === null || b.timeSlotId === slotId) ?? null;

    return slots.map((slot) => {
      const booked = bookedBySlot.get(slot.id) ?? 0;
      const remaining = Math.max(0, slot.capacity - booked);
      const block = blockFor(slot.id);
      const passed = hasPassed(slot);
      return {
        slotId: slot.id,
        label: slot.label,
        startTime: slot.startTime,
        endTime: slot.endTime,
        capacity: slot.capacity,
        booked,
        // A closed or finished slot offers no places, whatever the count says.
        remaining: (block || passed) ? 0 : remaining,
        fullyBooked: Boolean(block) || remaining <= 0,
        blocked: Boolean(block),
        blockReason: block ? block.reason : null,
        passed,
      };
    });
  }

  /**
   * People in each slot of one office on one day — the figure the 30-guest
   * limit is held against.
   *
   * Two things make this the real occupancy rather than the sum of what people
   * typed into the form:
   *
   *  • once a group has checked in, the number the receptionist counted replaces
   *    the number that was booked — so booking 2 and arriving with 9 uses nine
   *    places, not two;
   *  • a group admitted outside its own slot (early, late, or on another day)
   *    is counted in the slot and day it actually walked into.
   *
   * Cancelled and no-show registrations hold no places (assumption A5).
   * `excludeRegistrationId` leaves one registration out, for asking "how many
   * are in there besides this group?".
   */
  async occupancy(salesOfficeId, date, { excludeRegistrationId = null } = {}) {
    const rows = await this.db.prepare(`
      SELECT COALESCE(c.admitted_slot_id, r.time_slot_id) AS "slotId",
             COALESCE(SUM(COALESCE(c.actual_guests, r.number_of_visitors)), 0) AS people
      FROM registrations r
      LEFT JOIN checkins c ON c.registration_id = r.id
      WHERE r.sales_office_id = ?
        AND COALESCE(c.admitted_date, r.visit_date) = ?
        AND r.status NOT IN (?, ?)
        AND r.id <> ?
      GROUP BY 1`).all(salesOfficeId, date, STATUS.CANCELLED, STATUS.NO_SHOW,
      excludeRegistrationId ?? '');
    return new Map(rows.map((r) => [r.slotId, Number(r.people)]));
  }

  async assertSlotHasRoom(salesOfficeId, visitDate, timeSlotId, numberOfVisitors) {
    // Checked first: "we are closed that day" is the true reason, and saying
    // "fully booked" instead would send the visitor looking for a free seat.
    if (this.blocks) await this.blocks.assertOpen(salesOfficeId, visitDate, timeSlotId);

    const availability = (await this.getAvailability(salesOfficeId, visitDate))
      .find((a) => a.slotId === timeSlotId);
    if (!availability) {
      throw badRequest('INVALID_TIME_SLOT', 'Unknown or inactive time slot.');
    }
    // Greyed out in the form, and refused here for anyone who gets past it.
    if (availability.passed) {
      throw conflict('TIME_SLOT_PASSED',
        'This time slot has already ended. Please choose a later slot or another day.',
        { slotId: timeSlotId, endTime: availability.endTime });
    }
    if (availability.fullyBooked) {
      throw conflict('TIME_SLOT_FULLY_BOOKED', 'This time slot is fully booked.',
        { slotId: timeSlotId, capacity: availability.capacity, booked: availability.booked });
    }
    if (numberOfVisitors > availability.remaining) {
      throw conflict('TIME_SLOT_INSUFFICIENT_CAPACITY',
        `Only ${availability.remaining} place(s) remain in this time slot.`,
        { slotId: timeSlotId, remaining: availability.remaining, requested: numberOfVisitors });
    }
    return availability;
  }

  // ------------------------------------------------------------------- creation

  async confirmationCodeExists(code) {
    return Boolean(await this.db.prepare('SELECT 1 FROM registrations WHERE confirmation_code = ?').get(code));
  }

  /**
   * §XLI Process 4-10 — validate everything on the backend, then create the
   * Registration, Confirmation Code and QR token in one transaction.
   */
  async createRegistration(input, { actor = VISITOR_ACTOR } = {}) {
    const ctx = {
      offices: await this.masterData.listOffices(),
      slots: await this.masterData.listSlots(),
      agencies: await this.masterData.listAgencies(),
      today: this.today(),
    };

    const { value, errors } = validateRegistrationInput(input, ctx);
    assertNoErrors(errors);

    await this.assertSlotHasRoom(value.salesOfficeId, value.visitDate, value.timeSlotId, value.numberOfVisitors);
    await this.assertNoDuplicate(value);

    const id = randomUUID();
    const now = this.now();
    const confirmationCode = await generateUniqueConfirmationCode((c) => this.confirmationCodeExists(c));
    const qrToken = generateQrToken(this.qrSecret);

    await this.db.transaction(async (tx) => {
      await tx.prepare(`
        INSERT INTO registrations (
          id, confirmation_code, qr_token, language, sales_office_id, visitor_type,
          registration_date, visit_date, time_slot_id, number_of_visitors, notes, status,
          full_name, cccd, phone, email,
          agency_id, agency_name, sales_staff_name, sales_staff_cccd, sales_staff_phone,
          customer_short_name, customer_phone_last4,
          created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id, confirmationCode, qrToken, value.language, value.salesOfficeId, value.visitorType,
        this.today(), value.visitDate, value.timeSlotId, value.numberOfVisitors, value.notes, STATUS.REGISTERED,
        value.fullName ?? null, value.cccd ?? null, value.phone ?? null, value.email ?? null,
        value.agencyId ?? null, value.agencyName ?? null, value.salesStaffName ?? null,
        value.salesStaffCccd ?? null, value.salesStaffPhone ?? null,
        value.customerShortName ?? null, value.customerPhoneLast4 ?? null,
        now, now,
      );
      await this.#recordHistory(id, null, STATUS.REGISTERED, actor, 'Registration created', tx);
    });

    const registration = await this.getById(id, { includeQrToken: true });
    return registration;
  }

  /**
   * §Rule 11 / §VI.2 — do not create a duplicate visitor record. A duplicate is the
   * same person (CCCD for a visitor, sales-staff CCCD + customer for an agency)
   * already holding a live registration for the same office, date and slot.
   */
  async assertNoDuplicate(value) {
    const live = [STATUS.REGISTERED, STATUS.CONFIRMED, STATUS.EXPECTED,
      STATUS.CHECKED_IN, STATUS.IN_VISIT, STATUS.COMPLETED];
    const placeholders = live.map(() => '?').join(',');

    if (value.visitorType === VISITOR_TYPES.VISITOR) {
      const row = await this.db.prepare(`
        SELECT confirmation_code FROM registrations
        WHERE cccd = ? AND sales_office_id = ? AND visit_date = ? AND time_slot_id = ?
          AND status IN (${placeholders})`
      ).get(value.cccd, value.salesOfficeId, value.visitDate, value.timeSlotId, ...live);
      if (row) {
        throw conflict('DUPLICATE_REGISTRATION',
          'A registration already exists for this Citizen ID at the same office, date and time slot.',
          { confirmationCode: row.confirmation_code });
      }
    } else {
      const row = await this.db.prepare(`
        SELECT confirmation_code FROM registrations
        WHERE sales_staff_cccd = ? AND customer_short_name = ? AND customer_phone_last4 = ?
          AND sales_office_id = ? AND visit_date = ? AND time_slot_id = ?
          AND status IN (${placeholders})`
      ).get(value.salesStaffCccd, value.customerShortName, value.customerPhoneLast4,
        value.salesOfficeId, value.visitDate, value.timeSlotId, ...live);
      if (row) {
        throw conflict('DUPLICATE_REGISTRATION',
          'This sales staff has already registered the same customer for this office, date and time slot.',
          { confirmationCode: row.confirmation_code });
      }
    }
  }

  // -------------------------------------------------------------------- reading

  async #row(sql, ...params) {
    return await this.db.prepare(sql).get(...params);
  }

  /** §XXIX — tickets for this registration, counted per vehicle type. */
  async parkingSummary(registrationId) {
    const { ParkingService } = require('./parking.service');
    const tickets = (await this.db.prepare(
      'SELECT * FROM parking_tickets WHERE registration_id = ? ORDER BY issued_at, id',
    ).all(registrationId)).map(mapParkingTicket);
    return ParkingService.summarise(tickets);
  }

  async getById(id, { includeQrToken = false } = {}) {
    const row = await this.#row('SELECT * FROM registrations WHERE id = ?', id);
    if (!row) return null;
    return await this.#decorate(row, includeQrToken);
  }

  async getByConfirmationCode(code, { includeQrToken = false } = {}) {
    const normalized = normalizeConfirmationCode(code);
    if (!isValidConfirmationCode(normalized)) return null;
    const row = await this.#row('SELECT * FROM registrations WHERE confirmation_code = ?', normalized);
    if (!row) return null;
    return await this.#decorate(row, includeQrToken);
  }

  /** §XXVI Option 1 — resolve a scanned QR. Malformed tokens never reach the DB. */
  async getByQrToken(token) {
    if (!isWellFormedQrToken(token, this.qrSecret)) {
      throw badRequest('INVALID_QR_TOKEN', 'This QR code is not valid.');
    }
    const row = await this.#row('SELECT * FROM registrations WHERE qr_token = ?', token);
    if (!row) {
      throw notFound('REGISTRATION_NOT_FOUND', 'No registration matches this QR code.');
    }
    return await this.#decorate(row, false);
  }

  async #decorate(row, includeQrToken) {
    const reg = mapRegistration(row);
    reg.salesOffice = await this.masterData.getOffice(row.sales_office_id);
    reg.timeSlot = await this.masterData.getSlot(row.time_slot_id);
    reg.checkin = mapCheckin(await this.#row('SELECT * FROM checkins WHERE registration_id = ?', row.id));
    reg.statusHistory = (await this.db
      .prepare('SELECT * FROM status_history WHERE registration_id = ? ORDER BY seq')
      .all(row.id)).map(mapHistory);
    reg.parkingTicketApplicable = Boolean(reg.salesOffice?.parkingTicketEnabled);
    reg.parking = await this.parkingSummary(row.id);
    if (includeQrToken) reg.qrToken = row.qr_token;
    return reg;
  }

  /**
   * §XXXVIII — Registration Management list with search / filter / sort / pagination.
   * `scopeOfficeId` enforces §XXV: a receptionist only ever sees their own office.
   */
  #listQuery({
    scopeOfficeId = null, salesOfficeId = null, visitorType = null, status = null,
    dateFrom = null, dateTo = null, search = null, parkingTicket = null,
  } = {}) {
    const where = [];
    const params = [];

    if (scopeOfficeId) { where.push('r.sales_office_id = ?'); params.push(scopeOfficeId); }
    if (salesOfficeId) { where.push('r.sales_office_id = ?'); params.push(salesOfficeId); }
    if (visitorType) { where.push('r.visitor_type = ?'); params.push(visitorType); }
    if (status) {
      const list = Array.isArray(status) ? status : [status];
      where.push(`r.status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
    if (dateFrom) { where.push('r.visit_date >= ?'); params.push(dateFrom); }
    if (dateTo) { where.push('r.visit_date <= ?'); params.push(dateTo); }
    const hasTicket = 'EXISTS (SELECT 1 FROM parking_tickets pt WHERE pt.registration_id = r.id';
    if (parkingTicket === 'issued') where.push(`${hasTicket})`);
    if (parkingTicket === 'not_issued') where.push(`NOT ${hasTicket})`);
    if (parkingTicket === 'returned') where.push(`${hasTicket} AND pt.returned_at IS NOT NULL)`);
    if (parkingTicket === 'outstanding') where.push(`${hasTicket} AND pt.returned_at IS NULL)`);
    if (parkingTicket === 'car') where.push(`${hasTicket} AND pt.vehicle_type = 'CAR')`);
    if (parkingTicket === 'motorbike') where.push(`${hasTicket} AND pt.vehicle_type = 'MOTORBIKE')`);

    if (search) {
      // §XXVI Option 2 — search by code, name, phone, CCCD, agency or sales staff.
      const raw = String(search).trim();
      const code = normalizeConfirmationCode(raw);
      const phone = normalizePhone(raw);
      const cccd = normalizeCccd(raw);
      const like = `%${raw.toLowerCase()}%`;
      where.push(`(
        r.confirmation_code = ?
        OR lower(r.full_name) LIKE ?
        OR lower(COALESCE(r.agency_name, '')) LIKE ?
        OR lower(COALESCE(r.sales_staff_name, '')) LIKE ?
        OR lower(COALESCE(r.customer_short_name, '')) LIKE ?
        OR r.phone = ? OR r.sales_staff_phone = ?
        OR r.cccd = ? OR r.sales_staff_cccd = ?
        OR r.customer_phone_last4 = ?
      )`);
      params.push(code, like, like, like, like, phone, phone, cccd, cccd, raw.replace(/\D/g, '').slice(-4));
    }

    return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  // eslint-disable-next-line class-methods-use-this
  #orderBy(sortBy, sortDir) {
    const sortable = {
      visit_date: 'r.visit_date', created_at: 'r.created_at', status: 'r.status',
      confirmation_code: 'r.confirmation_code', number_of_visitors: 'r.number_of_visitors',
      sales_office: 'r.sales_office_id', checkin_time: 'c.checkin_time',
      time_slot: 's.sort_order',
    };
    const orderCol = sortable[sortBy] ?? sortable.visit_date;
    const dir = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    return `ORDER BY ${orderCol} ${dir}, s.sort_order ASC, r.created_at ASC`;
  }

  async list(filters = {}) {
    const { sortBy = 'visit_date', sortDir = 'asc', page = 1, pageSize = 20 } = filters;
    const { whereSql, params } = this.#listQuery(filters);
    const orderSql = this.#orderBy(sortBy, sortDir);

    const size = Math.min(Math.max(Number(pageSize) || 20, 1), 200);
    const current = Math.max(Number(page) || 1, 1);
    const offset = (current - 1) * size;

    const total = Number((await this.db.prepare(`
      SELECT COUNT(*) AS n FROM registrations r
      LEFT JOIN checkins c ON c.registration_id = r.id
      LEFT JOIN time_slots s ON s.id = r.time_slot_id
      ${whereSql}`).get(...params)).n);

    const rows = await this.db.prepare(`
      SELECT r.* FROM registrations r
      LEFT JOIN checkins c ON c.registration_id = r.id
      LEFT JOIN time_slots s ON s.id = r.time_slot_id
      ${whereSql}
      ${orderSql}
      LIMIT ? OFFSET ?`).all(...params, size, offset);

    return {
      items: await Promise.all(rows.map(async (row) => stripSecrets(await this.#decorate(row, false)))),
      page: current,
      pageSize: size,
      total,
      totalPages: Math.max(1, Math.ceil(total / size)),
    };
  }

  /**
   * Every registration matching the same filters as `list()`, unpaginated — for
   * the Excel export, which has to cover the whole result set and not just the
   * page on screen. `limit` is a safety valve: a runaway export would otherwise
   * build the entire table in memory.
   */
  async listAll(filters = {}, { limit = EXPORT_ROW_LIMIT } = {}) {
    const { sortBy = 'visit_date', sortDir = 'asc' } = filters;
    const { whereSql, params } = this.#listQuery(filters);
    const orderSql = this.#orderBy(sortBy, sortDir);
    const cap = Math.min(Math.max(Number(limit) || EXPORT_ROW_LIMIT, 1), EXPORT_ROW_LIMIT);

    const total = Number((await this.db.prepare(`
      SELECT COUNT(*) AS n FROM registrations r
      LEFT JOIN checkins c ON c.registration_id = r.id
      LEFT JOIN time_slots s ON s.id = r.time_slot_id
      ${whereSql}`).get(...params)).n);

    const rows = await this.db.prepare(`
      SELECT r.* FROM registrations r
      LEFT JOIN checkins c ON c.registration_id = r.id
      LEFT JOIN time_slots s ON s.id = r.time_slot_id
      ${whereSql}
      ${orderSql}
      LIMIT ?`).all(...params, cap);

    return {
      items: await Promise.all(rows.map(async (row) => stripSecrets(await this.#decorate(row, false)))),
      total,
      limit: cap,
      truncated: total > rows.length,
    };
  }

  // --------------------------------------------------------------- status moves

  /**
   * `runner` is the transaction handle when this is part of a larger change, so
   * the history row commits or rolls back with the change it describes. Without
   * it the row would go in on its own connection and survive a rollback.
   */
  async #recordHistory(registrationId, from, to, actor, note = null, runner = this.db) {
    await runner.prepare(`
      INSERT INTO status_history (id, registration_id, from_status, to_status, changed_by, changed_by_name, changed_at, note)
      VALUES (?,?,?,?,?,?,?,?)`
    ).run(randomUUID(), registrationId, from, to, actor.id, actor.name, this.now(), note);
  }

  /** §XXIII — every change is validated against the lifecycle and recorded. */
  async changeStatus(registrationId, nextStatus, { actor = SYSTEM_ACTOR, note = null } = {}) {
    const row = await this.#row('SELECT * FROM registrations WHERE id = ?', registrationId);
    if (!row) throw notFound('REGISTRATION_NOT_FOUND', 'Registration not found.');

    assertTransition(row.status, nextStatus);

    const now = this.now();
    await this.db.transaction(async (tx) => {
      await tx.prepare('UPDATE registrations SET status = ?, updated_at = ? WHERE id = ?')
        .run(nextStatus, now, registrationId);
      await this.#recordHistory(registrationId, row.status, nextStatus, actor, note, tx);
    });
    return await this.getById(registrationId);
  }

  /** Raw insert used by the check-in service inside its own transaction. */
  async _applyStatusWithinTransaction(registrationId, from, to, actor, note, tx) {
    assertTransition(from, to);
    const runner = tx || this.db;
    await runner.prepare('UPDATE registrations SET status = ?, updated_at = ? WHERE id = ?')
      .run(to, this.now(), registrationId);
    await this.#recordHistory(registrationId, from, to, actor, note, tx);
  }

  // ----------------------------------------------------------------- guard rails

  /** §XXV — office scoping for any staff action on a registration. */
  assertOfficeAccess(registration, user) {
    if (!user.salesOfficeId) return; // Manager / Administrator
    if (registration.salesOfficeId !== user.salesOfficeId) {
      throw forbidden('This registration belongs to a different Sales Office.');
    }
  }

  eligibleForCheckin(registration) {
    return CHECKIN_ELIGIBLE.includes(registration.status);
  }
}

module.exports = { RegistrationService, SYSTEM_ACTOR, VISITOR_ACTOR, EXPORT_ROW_LIMIT };
