'use strict';

const { randomUUID } = require('node:crypto');
const { VEHICLE_TYPES } = require('../config/master-data');
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

  /** §XXIX — hand out one ticket, for one vehicle, of a stated type. */
  async issue(registrationId, { vehicleType, ticketNumber = null }, { actor }) {
    const registration = await this.#requireRegistration(registrationId);
    ParkingService.assertVehicleType(vehicleType);

    const number = ticketNumber === null || ticketNumber === undefined
      ? null : String(ticketNumber).trim() || null;

    if (number) {
      // A ticket number is physical stock; the same one cannot be out twice.
      const clash = await this.db.prepare(`
        SELECT id FROM parking_tickets
        WHERE sales_office_id = ? AND vehicle_type = ? AND ticket_number = ? AND returned_at IS NULL`
      ).get(registration.salesOfficeId, vehicleType, number);
      if (clash) {
        throw conflict('PARKING_TICKET_NUMBER_IN_USE',
          `Ticket ${number} is already issued and has not been returned.`);
      }
    }

    const id = randomUUID();
    await this.db.prepare(`
      INSERT INTO parking_tickets (id, registration_id, sales_office_id, vehicle_type,
                                   ticket_number, issued_at, issued_by, issued_by_name)
      VALUES (?,?,?,?,?,?,?,?)`
    ).run(id, registrationId, registration.salesOfficeId, vehicleType, number,
      this.now(), actor.id, actor.name);

    return mapParkingTicket(await this.db.prepare('SELECT * FROM parking_tickets WHERE id = ?').get(id));
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
