'use strict';

const { VISITOR_TYPES, OTHER_AGENCY_ID } = require('../config/master-data');

const bool = (v) => v === 1 || v === true;

function mapOffice(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    address: row.address,
    openingHours: row.opening_hours,
    contact: row.contact,
    parkingTicketEnabled: bool(row.parking_ticket_enabled),
  };
}

function mapSlot(row) {
  if (!row) return null;
  return {
    id: row.id,
    startTime: row.start_time,
    endTime: row.end_time,
    label: row.label,
    capacity: row.capacity,
    active: bool(row.active),
    sortOrder: row.sort_order,
  };
}

function mapAgency(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    active: bool(row.active),
    sortOrder: row.sort_order ?? 0,
    // §XXII — "Khác" asks for the agency's name instead of standing for one.
    allowsCustomName: row.id === OTHER_AGENCY_ID,
  };
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    role: row.role,
    salesOfficeId: row.sales_office_id ?? null,
    active: bool(row.active),
    createdAt: row.created_at,
    mustChangePassword: bool(row.must_change_password),
    passwordChangedAt: row.password_changed_at ?? null,
    lastLoginAt: row.last_login_at ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    loginCount: Number(row.login_count ?? 0),
  };
}

function mapRegistration(row) {
  if (!row) return null;
  const base = {
    id: row.id,
    confirmationCode: row.confirmation_code,
    language: row.language,
    salesOfficeId: row.sales_office_id,
    visitorType: row.visitor_type,
    registrationDate: row.registration_date,
    visitDate: row.visit_date,
    timeSlotId: row.time_slot_id,
    numberOfVisitors: row.number_of_visitors,
    notes: row.notes ?? null,
    status: row.status,
    // NULL on registrations taken before the field existed.
    guestCategory: row.guest_category ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.visitor_type === VISITOR_TYPES.VISITOR) {
    base.visitor = {
      fullName: row.full_name,
      cccd: row.cccd,
      phone: row.phone,
      email: row.email ?? null,
    };
  } else {
    base.agency = {
      agencyId: row.agency_id,
      agencyName: row.agency_name,
      salesStaffName: row.sales_staff_name,
      salesStaffCccd: row.sales_staff_cccd,
      salesStaffPhone: row.sales_staff_phone,
      customerShortName: row.customer_short_name,
      customerPhoneLast4: row.customer_phone_last4,
    };
  }
  return base;
}

function mapCheckin(row) {
  if (!row) return null;
  return {
    id: row.id,
    registrationId: row.registration_id,
    receptionistId: row.receptionist_id,
    receptionistName: row.receptionist_name,
    salesOfficeId: row.sales_office_id,
    checkinTime: row.checkin_time,
    checkinMethod: row.checkin_method,
    // §XXVIII — booked versus actually arrived, and the difference between them.
    expectedGuests: row.expected_guests,
    actualGuests: row.actual_guests,
    guestVariance: row.actual_guests - row.expected_guests,
    notes: row.notes ?? null,
    // How the arrival compared with the booked slot, and where the group was
    // actually admitted.
    arrivalStatus: row.arrival_status ?? null,
    minutesFromSlotStart: row.minutes_from_slot_start ?? null,
    admittedSlotId: row.admitted_slot_id ?? null,
    admittedDate: row.admitted_date ?? null,
    timeOverride: row.time_override === 1 || row.time_override === true,
  };
}

function mapParkingTicket(row) {
  if (!row) return null;
  return {
    id: row.id,
    registrationId: row.registration_id,
    salesOfficeId: row.sales_office_id,
    vehicleType: row.vehicle_type,
    ticketNumber: row.ticket_number ?? null,
    issuedAt: row.issued_at,
    issuedByName: row.issued_by_name,
    returnedAt: row.returned_at ?? null,
    returnedByName: row.returned_by_name ?? null,
  };
}

function mapHistory(row) {
  if (!row) return null;
  return {
    id: row.id,
    seq: row.seq,
    fromStatus: row.from_status ?? null,
    toStatus: row.to_status,
    changedBy: row.changed_by,
    changedByName: row.changed_by_name,
    changedAt: row.changed_at,
    note: row.note ?? null,
  };
}

/** §XVIII.3 / Rule 3 — the QR token is never exposed to staff listings or to the
 *  visitor beyond the success page, and is stripped from every read model. */
function stripSecrets(registration) {
  if (!registration) return registration;
  const { qrToken, ...rest } = registration;
  return rest;
}

module.exports = {
  mapOffice, mapSlot, mapAgency, mapUser, mapRegistration, mapCheckin, mapHistory,
  mapParkingTicket, stripSecrets,
};
