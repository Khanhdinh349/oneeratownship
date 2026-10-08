'use strict';

const { randomUUID } = require('node:crypto');
const { VEHICLE_TYPES, MAX_TICKETS_PER_ISSUE } = require('../config/master-data');
const { isCheckedInOrBeyond } = require('../domain/status');
const { badRequest, conflict, notFound } = require('../domain/errors');
const { mapParkingTicket } = require('./mappers');

/**
 * §XXIX / §XXXIV — parking tickets.
 *
 * Tickets are counted separately for cars and motorbikes, and a registration may
 * hold several: a group of six can arrive in one car and on two motorbikes, and
 * the desk needs all three tracked and returned individually.
 *
 * Only offices with parkingTicketEnabled (CII - Bình Thạnh) take part; asking for
 * a ticket anywhere else is refused rather than silently ignored.
 */
class ParkingService {
  constructor({ db, registrations, masterData, clock = async () => new Date() }) {
    this.db = db;
    this.registrations = registrations;
    this.masterData = masterData;
    this.clock = clock;
  }

  now() { return this.clock().toISOString(); }

  async #requireRegistration(registrationId) {
    const registration = await this.registrations.getById(registrationId);
    if (!registration) throw notFound('REGISTRATION_NOT_FOUND', 'Registration not found.');
    const office = await this.masterData.requireOffice(registration.salesOfficeId);
    if (!office.parkingTicketEnabled) {
      throw badRequest('PARKING_TICKET_NOT_APPLICABLE',
        `Parking ticket tracking is not enabled for ${office.name}.`);
    }
    if (!isCheckedInOrBeyond(registration.status)) {
      throw conflict('PARKING_TICKET_REQUIRES_CHECKIN',
        'A parking ticket can only be recorded after the visitor has checked in.',
        { status: registration.status });
    }
    return registration;
  }

  static assertVehicleType(vehicleType) {
    if (!Object.values(VEHICLE_TYPES).includes(vehicleType)) {
      throw badRequest('INVALID_VEHICLE_TYPE',
        `Vehicle type must be one of: ${Object.values(VEHICLE_TYPES).join(', ')}.`);
    }
    return vehicleType;
  }

  async listForRegistration(registrationId) {
    return (await this.db.prepare(
      'SELECT * FROM parking_tickets WHERE registration_id = ? ORDER BY issued_at, id',
    ).all(registrationId)).map(mapParkingTicket);
  }

  /**
   * §XXIX — hand out tickets for one vehicle type.
   *
   * A group arrives on several vehicles at once, so one action issues `quantity`
   * tickets rather than one. `ticketNumbers` may carry the physical numbers; when
   * supplied there must be exactly one per ticket, so that what the desk typed and
   * what the register holds can never drift apart. The whole batch is written in a
   * single transaction: a clash on the fifth number must not leave four phantom
   * tickets behind.
   */
  async issue(registrationId, { vehicleType, ticketNumber = null, ticketNumbers = null,
    quantity = null }, { actor }) {
    const registration = await this.#requireRegistration(registrationId);
    ParkingService.assertVehicleType(vehicleType);

    const numbers = ParkingService.#resolveNumbers({ ticketNumber, ticketNumbers, quantity });

    // Numbers are physical stock: the same one cannot be out twice, and a batch
    // must not repeat a number within itself either.
    const seen = new Set();
    for (const n of numbers) {
      if (n === null) continue;
      if (seen.has(n)) {
        throw badRequest('PARKING_TICKET_NUMBER_REPEATED',
          `Ticket number ${n} appears more than once in the same batch.`);
      }
      seen.add(n);
    }

    for (const n of numbers) {
      if (n === null) continue;
      // eslint-disable-next-line no-await-in-loop
      const clash = await this.db.prepare(`
        SELECT id FROM parking_tickets
        WHERE sales_office_id = ? AND vehicle_type = ? AND ticket_number = ? AND returned_at IS NULL`
      ).get(registration.salesOfficeId, vehicleType, n);
      if (clash) {
        throw conflict('PARKING_TICKET_NUMBER_IN_USE',
          `Ticket ${n} is already issued and has not been returned.`);
      }
    }

    const issuedAt = this.now();
    const ids = numbers.map(() => randomUUID());

    await this.db.transaction(async (tx) => {
      const insert = tx.prepare(`
        INSERT INTO parking_tickets (id, registration_id, sales_office_id, vehicle_type,
                                     ticket_number, issued_at, issued_by, issued_by_name)
        VALUES (?,?,?,?,?,?,?,?)`);
      for (const [i, n] of numbers.entries()) {
        // eslint-disable-next-line no-await-in-loop
        await insert.run(ids[i], registrationId, registration.salesOfficeId, vehicleType, n,
          issuedAt, actor.id, actor.name);
      }
    });

    const tickets = [];
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      tickets.push(mapParkingTicket(
        await this.db.prepare('SELECT * FROM parking_tickets WHERE id = ?').get(id)));
    }
    return tickets;
  }

  /**
   * Work out exactly which numbers this batch writes, one entry per ticket.
   *
   * `null` in the returned array means "a ticket with no number recorded". The
   * length of the array IS the number of tickets issued, so the count the desk
   * typed and the count written can never disagree.
   */
  static #resolveNumbers({ ticketNumber, ticketNumbers, quantity }) {
    const clean = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

    let list = null;
    if (Array.isArray(ticketNumbers)) list = ticketNumbers.map(clean);
    else if (ticketNumber !== null && ticketNumber !== undefined) list = [clean(ticketNumber)];

    let count;
    if (quantity === null || quantity === undefined || quantity === '') {
      count = list ? list.length : 1;
    } else {
      count = Number(quantity);
      if (!Number.isInteger(count) || count < 1) {
        throw badRequest('INVALID_TICKET_QUANTITY',
          'Number of tickets must be a whole number of at least 1.');
      }
    }

    if (count > MAX_TICKETS_PER_ISSUE) {
      throw badRequest('TOO_MANY_TICKETS',
        `At most ${MAX_TICKETS_PER_ISSUE} tickets can be issued in one go; ${count} were asked for.`);
    }

    if (!list) return new Array(count).fill(null);

    // Numbers supplied: there must be exactly one per ticket. Silently padding or
    // truncating is what makes the entered quantity and the register disagree.
    if (list.length !== count) {
      throw badRequest('TICKET_NUMBER_COUNT_MISMATCH',
        `${count} ticket(s) requested but ${list.length} ticket number(s) given.`);
    }
    return list;
  }

  /** §XXIX — take one back. */
  async markReturned(ticketId, { actor }) {
    const row = await this.db.prepare('SELECT * FROM parking_tickets WHERE id = ?').get(ticketId);
    if (!row) throw notFound('PARKING_TICKET_NOT_FOUND', 'Parking ticket not found.');
    if (row.returned_at) {
      throw conflict('PARKING_TICKET_ALREADY_RETURNED', 'This ticket was already returned.',
        { returnedAt: row.returned_at });
    }
    await this.db.prepare(
      'UPDATE parking_tickets SET returned_at = ?, returned_by = ?, returned_by_name = ? WHERE id = ?',
    ).run(this.now(), actor.id, actor.name, ticketId);
    return mapParkingTicket(await this.db.prepare('SELECT * FROM parking_tickets WHERE id = ?').get(ticketId));
  }

  /** Issued in error — remove it rather than leaving a phantom ticket out. */
  async remove(ticketId) {
    const row = await this.db.prepare('SELECT * FROM parking_tickets WHERE id = ?').get(ticketId);
    if (!row) throw notFound('PARKING_TICKET_NOT_FOUND', 'Parking ticket not found.');
    await this.db.prepare('DELETE FROM parking_tickets WHERE id = ?').run(ticketId);
    return mapParkingTicket(row);
  }

  /** Per-registration rollup used by the list and the check-in panel. */
  async summaryFor(registrationId) {
    const tickets = await this.listForRegistration(registrationId);
    return ParkingService.summarise(tickets);
  }

  static summarise(tickets) {
    const blank = () => ({ issued: 0, returned: 0, outstanding: 0 });
    const byType = { [VEHICLE_TYPES.CAR]: blank(), [VEHICLE_TYPES.MOTORBIKE]: blank() };
    tickets.forEach((t) => {
      const bucket = byType[t.vehicleType];
      if (!bucket) return;
      bucket.issued += 1;
      if (t.returnedAt) bucket.returned += 1;
      else bucket.outstanding += 1;
    });
    return {
      total: tickets.length,
      returned: tickets.filter((t) => t.returnedAt).length,
      outstanding: tickets.filter((t) => !t.returnedAt).length,
      byVehicleType: byType,
      tickets,
    };
  }
}

module.exports = { ParkingService };
