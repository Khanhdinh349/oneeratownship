'use strict';

const { randomUUID } = require('node:crypto');
const {
  CHECKIN_METHODS, ROLES, MAX_GUEST_OVERAGE, ARRIVAL, EARLY_GRACE_MINUTES, LATE_GRACE_MINUTES,
  VISITOR_TYPES,
} = require('../config/master-data');
const { toDateString, minutesOfDay, parseHm } = require('../domain/dates');
const { STATUS, isCheckedInOrBeyond } = require('../domain/status');
const { isValidConfirmationCode } = require('../domain/codes');
const { conflict, forbidden, notFound, badRequest } = require('../domain/errors');
const { mapCheckin } = require('./mappers');

/**
 * §XXVI–§XXVIII — Receptionist check-in.
 * Every rule below is enforced here, on the backend (§Rule 4, §Rule 6).
 */
/** Wording for the status-history line: "3/3 guests" or "2/3 guests (-1)". */
function i18nGuests(guests) {
  return guests.matches ? 'guests' : `guests (${guests.variance > 0 ? '+' : ''}${guests.variance})`;
}

class CheckinService {
  constructor({ db, registrations, masterData, clock = async () => new Date() }) {
    this.db = db;
    this.registrations = registrations;
    this.masterData = masterData;
    this.clock = clock;
  }

  now() { return this.clock().toISOString(); }

  today() { return toDateString(this.clock()); }

  /**
   * How this group's arrival, right now, compares with what it booked — and how
   * many people the desk may let in.
   *
   * Timing. Inside its own slot (from the grace before the start until the slot
   * ends) a group is ON_TIME or LATE and simply checks in. Outside it — EARLY,
   * or AFTER_SLOT once its slot is over — the receptionist has to confirm, and
   * the group is admitted into whichever slot is running at that moment.
   *
   * Capacity. The limit is held against the slot the group actually walks into.
   * In its own slot a group may always bring the number it booked, because it
   * holds those places; anyone beyond that needs a free place. In any other
   * slot it holds nothing, so the whole group needs free places. That is what
   * stops a booking for two from becoming a party of nine at the door.
   */
  async assessArrival(registration) {
    const today = this.today();
    const now = minutesOfDay(this.clock());
    const slots = await this.masterData.listSlots({ includeInactive: true });
    const own = slots.find((x) => x.id === registration.timeSlotId) ?? null;

    const live = slots.filter((x) => x.active);
    const running = live.find((x) => now >= parseHm(x.startTime) && now < parseHm(x.endTime))
      ?? live.find((x) => now >= parseHm(x.startTime) - EARLY_GRACE_MINUTES && now < parseHm(x.startTime))
      ?? null;

    let status;
    let minutes = null;
    let admitted = own;
    let requiresConfirmation = false;

    if (registration.visitDate !== today || !own) {
      status = ARRIVAL.OTHER_DAY;
      admitted = running ?? own;
    } else {
      const start = parseHm(own.startTime);
      const end = parseHm(own.endTime);
      minutes = now - start;
      if (now < start - EARLY_GRACE_MINUTES) {
        status = ARRIVAL.EARLY;
        requiresConfirmation = true;
        admitted = running ?? own;
      } else if (now >= end) {
        status = ARRIVAL.AFTER_SLOT;
        requiresConfirmation = true;
        admitted = running ?? own;
      } else {
        status = minutes > LATE_GRACE_MINUTES ? ARRIVAL.LATE : ARRIVAL.ON_TIME;
      }
    }

    const inOwnSlot = Boolean(own && admitted && admitted.id === own.id
      && registration.visitDate === today);
    const occupiedByOthers = admitted
      ? ((await this.registrations.occupancy(registration.salesOfficeId, today,
        { excludeRegistrationId: registration.id })).get(admitted.id) ?? 0)
      : 0;
    const free = admitted ? Math.max(0, admitted.capacity - occupiedByOthers) : 0;
    const booked = registration.numberOfVisitors;

    return {
      timing: {
        status,
        minutesFromSlotStart: minutes,
        requiresConfirmation,
        bookedSlotId: own?.id ?? null,
        bookedSlotLabel: own?.label ?? null,
        admittedSlotId: admitted?.id ?? null,
        admittedSlotLabel: admitted?.label ?? null,
        admittedDate: today,
        inOwnSlot,
      },
      capacity: {
        slotId: admitted?.id ?? null,
        slotLabel: admitted?.label ?? null,
        capacity: admitted?.capacity ?? 0,
        occupiedByOthers,
        // The most this group may bring through the door right now.
        maxGuests: inOwnSlot ? Math.max(booked, free) : free,
        // Places beyond its own booking, if it turns up with more.
        extraPlaces: Math.max(0, free - booked),
      },
    };
  }

  /** §XXVI Option 1 — resolve a scan without mutating anything yet. */
  async resolveByQr(token, user) {
    const registration = await this.registrations.getByQrToken(token);
    this.registrations.assertOfficeAccess(registration, user);
    return { registration, readiness: await this.evaluateReadiness(registration, user) };
  }

  /** §XXVI Option 2 — resolve a desk search by confirmation code. */
  async resolveByConfirmationCode(code, user) {
    const registration = await this.registrations.getByConfirmationCode(code);
    if (!registration) {
      throw notFound('REGISTRATION_NOT_FOUND', 'No registration matches this confirmation code.');
    }
    this.registrations.assertOfficeAccess(registration, user);
    return { registration, readiness: await this.evaluateReadiness(registration, user) };
  }

  /**
   * §XXVI Option 2 — the desk's single search box. One free-text query that
   * accepts any of the identifiers the spec lists: confirmation code, visitor
   * name, phone, CCCD, agency or sales staff. Scanned QR payloads are handled
   * here too, so the receptionist never has to decide which kind of thing they
   * are typing.
   *
   * Returns { mode: 'single' | 'multiple' | 'none', ... } so the UI can show the
   * visitor straight away, offer a pick-list, or say plainly that nothing matched.
   */
  async lookup(query, user, { scopeOfficeId = null, limit = 15 } = {}) {
    const q = String(query ?? '').trim();
    if (!q) {
      throw badRequest('SEARCH_QUERY_REQUIRED',
        'Enter a confirmation code, name, phone, citizen ID, agency or sales staff name.');
    }

    // 1 — a scanned QR payload or a raw token.
    const token = this.#extractQrToken(q);
    if (token) {
      const { registration, readiness } = await this.resolveByQr(token, user);
      return { mode: 'single', method: CHECKIN_METHODS.QR, query: q, registration, readiness };
    }

    // 2 — an exact confirmation code.
    if (isValidConfirmationCode(q)) {
      const registration = await this.registrations.getByConfirmationCode(q);
      if (registration) {
        this.registrations.assertOfficeAccess(registration, user);
        return {
          mode: 'single',
          method: CHECKIN_METHODS.SEARCH,
          query: q,
          registration,
          readiness: await this.evaluateReadiness(registration, user),
        };
      }
    }

    // 3 — anything else: name, phone, CCCD, agency, sales staff, last-4 digits.
    const page = await this.registrations.list({
      scopeOfficeId,
      search: q,
      sortBy: 'visit_date',
      sortDir: 'asc',
      pageSize: limit,
    });

    const matches = [];
    for (const registration of page.items) {
      // eslint-disable-next-line no-await-in-loop
      matches.push({ registration, readiness: await this.evaluateReadiness(registration, user) });
    }

    if (matches.length === 0) {
      return { mode: 'none', method: CHECKIN_METHODS.SEARCH, query: q, matches: [] };
    }
    if (matches.length === 1) {
      return {
        mode: 'single',
        method: CHECKIN_METHODS.SEARCH,
        query: q,
        registration: matches[0].registration,
        readiness: matches[0].readiness,
      };
    }
    return {
      mode: 'multiple',
      method: CHECKIN_METHODS.SEARCH,
      query: q,
      total: page.total,
      matches,
    };
  }

  /** A QR payload URL, or a bare token; null when the text is neither. */
  #extractQrToken(text) {
    const fromUrl = text.match(/[?&]t=([^&\s]+)/);
    const candidate = fromUrl ? decodeURIComponent(fromUrl[1]) : text;
    return /^[0-9a-f]{32}\.[0-9a-f]{16}$/.test(candidate) ? candidate : null;
  }

  /**
   * Non-throwing pre-flight so the receptionist screen can render
   * "Already Completed" / "Cancelled" / "Wrong date" states (§Step 7 UI States)
   * instead of only a hard error.
   */
  async evaluateReadiness(registration, user) {
    const reasons = [];
    const today = this.today();

    if (user.salesOfficeId && registration.salesOfficeId !== user.salesOfficeId) {
      reasons.push({ code: 'WRONG_OFFICE', message: 'Registration belongs to another Sales Office.' });
    }
    if (registration.status === STATUS.CANCELLED) {
      reasons.push({ code: 'CANCELLED', message: 'This registration was cancelled.' });
    }
    if (registration.status === STATUS.NO_SHOW) {
      reasons.push({ code: 'NO_SHOW', message: 'This registration was marked as a no-show.' });
    }
    if (isCheckedInOrBeyond(registration.status)) {
      reasons.push({
        code: 'ALREADY_CHECKED_IN',
        message: 'This visitor has already been checked in.',
        checkinTime: registration.checkin?.checkinTime ?? null,
      });
    }
    if (registration.visitDate !== today) {
      reasons.push({
        code: registration.visitDate > today ? 'FUTURE_VISIT_DATE' : 'PAST_VISIT_DATE',
        message: `Registration is for ${registration.visitDate}, today is ${today}.`,
      });
    }

    // Timing and capacity only matter for a registration that could still be
    // checked in; a cancelled one has nothing to assess.
    const terminal = reasons.some((x) => ['CANCELLED', 'NO_SHOW', 'ALREADY_CHECKED_IN', 'WRONG_OFFICE']
      .includes(x.code));
    if (terminal) return { canCheckIn: false, reasons, timing: null, capacity: null };

    const { timing, capacity } = await this.assessArrival(registration);
    if (timing.status === ARRIVAL.EARLY) {
      reasons.push({
        code: 'ARRIVED_EARLY',
        message: `Arrived ${-timing.minutesFromSlotStart} minutes before the ${timing.bookedSlotLabel} slot.`,
      });
    }
    if (timing.status === ARRIVAL.AFTER_SLOT) {
      reasons.push({
        code: 'ARRIVED_AFTER_SLOT',
        message: `The ${timing.bookedSlotLabel} slot has ended.`,
      });
    }
    if (capacity.maxGuests < 1) {
      reasons.push({
        code: 'SLOT_FULL',
        message: `The ${capacity.slotLabel} slot is full (${capacity.occupiedByOthers}/${capacity.capacity}).`,
      });
    }
    return { canCheckIn: reasons.length === 0, reasons, timing, capacity };
  }

  /**
   * §XXVIII — CHECK IN.
   * 1 validate registration, 2 validate office, 3 validate date, 4 validate status,
   * 5 record time, 6 record receptionist, 7 update status, 8/9 dashboard + calendar
   * update automatically because both read from the Registration record.
   */
  /**
   * §XXVIII — the arrival count the receptionist is being asked to confirm, and
   * how it compares with the booking. Exposed so the desk can show the number
   * before anyone presses CHECK IN.
   */
  static verifyGuestCount(registration, actualGuests, capacity = null) {
    const expected = registration.numberOfVisitors;
    const unconfirmed = actualGuests === undefined || actualGuests === null || actualGuests === '';
    const actual = unconfirmed ? expected : Number(actualGuests);

    // The hard limit: nobody is waved through into a slot that has no place for
    // them, whatever the booking said and whoever is asking. There is no
    // override for this one — the extra guests book another slot.
    if (capacity && Number.isInteger(actual) && actual > capacity.maxGuests) {
      throw conflict('SLOT_CAPACITY_EXCEEDED',
        capacity.maxGuests < 1
          ? `The ${capacity.slotLabel} slot is full (${capacity.occupiedByOthers}/${capacity.capacity}).`
          : `Only ${capacity.maxGuests} guest(s) can be admitted to the ${capacity.slotLabel} slot `
            + `(${capacity.occupiedByOthers}/${capacity.capacity} taken by other groups). `
            + 'The rest need to register for another slot.',
        {
          expected,
          actual,
          maxGuests: capacity.maxGuests,
          capacity: capacity.capacity,
          occupiedByOthers: capacity.occupiedByOthers,
          slotId: capacity.slotId,
        });
    }

    if (unconfirmed) {
      return { expected, actual: expected, variance: 0, matches: true, confirmed: false };
    }
    if (!Number.isInteger(actual)) {
      throw badRequest('INVALID_GUEST_COUNT', 'The number of arriving guests must be a whole number.');
    }
    if (actual < 1) {
      throw badRequest('GUEST_COUNT_TOO_LOW',
        'At least one guest must have arrived to check in. Mark the registration as a no-show instead.');
    }
    if (actual > expected + MAX_GUEST_OVERAGE) {
      throw badRequest('GUEST_COUNT_TOO_HIGH',
        `${actual} guests is more than ${MAX_GUEST_OVERAGE} above the ${expected} booked. `
        + 'Check the number, or register the extra guests separately.',
        { expected, actual, maxOverage: MAX_GUEST_OVERAGE });
    }
    return {
      expected,
      actual,
      variance: actual - expected,
      matches: actual === expected,
      confirmed: true,
    };
  }

  /**
   * §XXVIII — CHECK IN.
   * 1 validate registration, 2 validate office, 3 validate date, 4 validate status,
   * 5 verify how many guests actually arrived against the booking, 6 record time,
   * 7 record receptionist, 8 update status. The dashboard and calendar follow
   * automatically because both read from the Registration record.
   */
  async checkIn(registrationId, {
    user, method = CHECKIN_METHODS.QR, notes = null, allowDateOverride = false,
    allowTimeOverride = false, actualGuests = null,
  }) {
    if (!user) throw forbidden('Authentication required to check in a visitor.');
    if (![ROLES.RECEPTIONIST, ROLES.ADMINISTRATOR].includes(user.role)) {
      throw forbidden('Only a Receptionist or Administrator can perform check-in.');
    }
    if (!Object.values(CHECKIN_METHODS).includes(method)) {
      throw badRequest('INVALID_CHECKIN_METHOD',
        `Check-in method must be one of: ${Object.values(CHECKIN_METHODS).join(', ')}.`);
    }

    // 1 — registration exists
    const registration = await this.registrations.getById(registrationId);
    if (!registration) throw notFound('REGISTRATION_NOT_FOUND', 'Registration not found.');

    // 2 — office
    this.registrations.assertOfficeAccess(registration, user);

    // 4 — status (checked before date so "already checked in" wins over a stale date)
    if (isCheckedInOrBeyond(registration.status)) {
      throw conflict('ALREADY_CHECKED_IN', 'This visitor has already been checked in.',
        { status: registration.status, checkinTime: registration.checkin?.checkinTime ?? null });
    }
    if (registration.status === STATUS.CANCELLED) {
      throw conflict('REGISTRATION_CANCELLED', 'This registration was cancelled and cannot be checked in.');
    }
    if (registration.status === STATUS.NO_SHOW) {
      throw conflict('REGISTRATION_NO_SHOW', 'This registration was marked as a no-show.');
    }
    if (!this.registrations.eligibleForCheckin(registration)) {
      throw conflict('NOT_ELIGIBLE_FOR_CHECKIN',
        `A registration with status ${registration.status} cannot be checked in.`);
    }

    // 3 — date
    const today = this.today();
    if (registration.visitDate !== today && !allowDateOverride) {
      throw conflict('VISIT_DATE_MISMATCH',
        `This registration is for ${registration.visitDate}, not today (${today}).`,
        { visitDate: registration.visitDate, today, overridable: true });
    }

    // 3b — time of day. A group outside its own slot is not turned away, but the
    // desk has to say so deliberately, and it is written down.
    const { timing, capacity } = await this.assessArrival(registration);
    if (timing.requiresConfirmation && !allowTimeOverride) {
      throw conflict('ARRIVAL_OUTSIDE_SLOT',
        timing.status === ARRIVAL.EARLY
          ? `This group booked ${timing.bookedSlotLabel} and has arrived ${-timing.minutesFromSlotStart} minutes early.`
          : `This group booked ${timing.bookedSlotLabel}, which has already ended.`,
        { ...timing, capacity, overridable: true });
    }

    // 5 — how many actually turned up, held against the places really free
    const guests = CheckinService.verifyGuestCount(registration, actualGuests, capacity);

    const actor = { id: user.id, name: user.fullName };
    const checkinId = randomUUID();
    const checkinTime = this.now();
    const varianceNote = guests.matches
      ? null
      : `Arrived ${guests.actual} of ${guests.expected} booked (${
        guests.variance > 0 ? `+${guests.variance}` : guests.variance})`;
    const timingNote = {
      [ARRIVAL.LATE]: `Late by ${timing.minutesFromSlotStart} min`,
      [ARRIVAL.EARLY]: `Early by ${-timing.minutesFromSlotStart} min, admitted to ${timing.admittedSlotLabel}`,
      [ARRIVAL.AFTER_SLOT]: `After the booked slot, admitted to ${timing.admittedSlotLabel}`,
      [ARRIVAL.OTHER_DAY]: `Booked for ${registration.visitDate}`,
    }[timing.status] ?? null;
    const overridden = (timing.requiresConfirmation && allowTimeOverride)
      || registration.visitDate !== today;

    await this.db.transaction(async (tx) => {
      // 6 + 7 — time and receptionist are both recorded (§Rule 7 / §XLVI.12)
      await tx.prepare(`
        INSERT INTO checkins (id, registration_id, receptionist_id, receptionist_name,
                              sales_office_id, checkin_time, checkin_method,
                              expected_guests, actual_guests, notes,
                              arrival_status, minutes_from_slot_start,
                              admitted_slot_id, admitted_date, time_override)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(checkinId, registrationId, user.id, user.fullName,
        registration.salesOfficeId, checkinTime, method,
        guests.expected, guests.actual,
        // Timing lives in its own columns; only the count variance is echoed here.
        [notes, varianceNote].filter(Boolean).join(' · ') || null,
        timing.status, timing.minutesFromSlotStart,
        timing.admittedSlotId, timing.admittedDate, overridden ? 1 : 0);

      // 8 — status
      await this.registrations._applyStatusWithinTransaction(
        registrationId, registration.status, STATUS.CHECKED_IN, actor,
        `Checked in via ${method}${registration.visitDate !== today ? ' (date override)' : ''}`
        + ` — ${guests.actual}/${guests.expected} ${i18nGuests(guests)}`
        + (timingNote ? ` — ${timingNote}` : ''),
        tx,
      );
    });

    return {
      checkin: mapCheckin(await this.db.prepare('SELECT * FROM checkins WHERE id = ?').get(checkinId)),
      registration: await this.registrations.getById(registrationId),
      guests,
      timing,
    };
  }

  /**
   * Correct a check-in after the fact.
   *
   * The desk gets things wrong in the moment — six people counted as five, a group
   * walked into the 13:00 slot while the record still says 10:30, the wrong sales
   * staff named. Until now none of it could be fixed, so a mistake stayed in the
   * reports forever.
   *
   * Only the three things reception asked for can change, and each is checked
   * exactly as it is at check-in: the arrival count still cannot exceed the places
   * a slot really has, and the slot must be a real one. Every correction is written
   * to the status history, so it is visible rather than silent (§Rule 7).
   */
  async amendCheckin(registrationId, {
    actualGuests = undefined, admittedSlotId = undefined, salesStaffName = undefined,
  }, { actor, user }) {
    const registration = await this.registrations.getById(registrationId);
    if (!registration) throw notFound('REGISTRATION_NOT_FOUND', 'Registration not found.');
    this.registrations.assertOfficeAccess(registration, user ?? actor);

    if (!isCheckedInOrBeyond(registration.status)) {
      throw conflict('NOT_CHECKED_IN',
        'Only a registration that has been checked in can be corrected.',
        { status: registration.status });
    }

    const row = await this.db.prepare('SELECT * FROM checkins WHERE registration_id = ?')
      .get(registrationId);
    if (!row) throw notFound('CHECKIN_NOT_FOUND', 'There is no check-in record to correct.');

    const slots = await this.masterData.listSlots({ includeInactive: true });
    const changes = [];
    const sets = [];
    const params = [];

    // --- which slot the group was actually admitted into ----------------------
    let slot = null;
    if (admittedSlotId !== undefined && admittedSlotId !== null && admittedSlotId !== '') {
      slot = slots.find((s) => s.id === admittedSlotId) ?? null;
      if (!slot) throw badRequest('INVALID_TIME_SLOT', 'That time slot does not exist.');
      if (slot.id !== row.admitted_slot_id) {
        sets.push('admitted_slot_id = ?');
        params.push(slot.id);
        const from = slots.find((s) => s.id === row.admitted_slot_id);
        changes.push(`slot ${from?.label ?? row.admitted_slot_id ?? '—'} → ${slot.label}`);
      }
    }

    // --- how many people actually came ---------------------------------------
    if (actualGuests !== undefined && actualGuests !== null && actualGuests !== '') {
      const actual = Number(actualGuests);
      if (!Number.isInteger(actual)) {
        throw badRequest('INVALID_GUEST_COUNT',
          'The number of arriving guests must be a whole number.');
      }
      if (actual < 1) {
        throw badRequest('GUEST_COUNT_TOO_LOW', 'At least one guest must have arrived.');
      }

      // The slot this count will sit in once the correction lands, and what every
      // other group already occupies there. This group's own numbers are excluded,
      // otherwise it would be counted against itself.
      const targetSlotId = slot?.id ?? row.admitted_slot_id;
      const targetDate = row.admitted_date ?? registration.visitDate;
      if (targetSlotId) {
        const target = slots.find((s) => s.id === targetSlotId) ?? null;
        const occupiedByOthers = (await this.registrations.occupancy(
          registration.salesOfficeId, targetDate, { excludeRegistrationId: registrationId },
        )).get(targetSlotId) ?? 0;
        const capacity = target?.capacity ?? 0;
        const room = Math.max(0, capacity - occupiedByOthers);
        if (actual > room) {
          throw conflict('SLOT_CAPACITY_EXCEEDED',
            `Only ${room} guest(s) fit in the ${target?.label ?? targetSlotId} slot `
            + `(${occupiedByOthers}/${capacity} taken by other groups).`,
            { actual, maxGuests: room, capacity, occupiedByOthers, slotId: targetSlotId });
        }
      }

      if (actual !== row.actual_guests) {
        sets.push('actual_guests = ?');
        params.push(actual);
        changes.push(`guests ${row.actual_guests} → ${actual}`);
      }
    }

    // --- who at the agency brought them --------------------------------------
    // Only an agency booking carries a sales staff name; asking to change it on a
    // walk-in visitor is a mistake, not a silent no-op.
    let newStaffName;
    if (salesStaffName !== undefined && salesStaffName !== null) {
      if (registration.visitorType !== VISITOR_TYPES.AGENCY) {
        throw badRequest('NOT_AN_AGENCY_REGISTRATION',
          'Only an agency registration has a sales staff name.');
      }
      const trimmed = String(salesStaffName).trim();
      if (!trimmed) {
        throw badRequest('SALES_STAFF_NAME_REQUIRED', 'Sales staff name cannot be blank.');
      }
      if (trimmed !== (registration.agency?.salesStaffName ?? null)) {
        newStaffName = trimmed;
        changes.push(`sales staff ${registration.agency?.salesStaffName ?? '—'} → ${trimmed}`);
      }
    }

    if (!changes.length) {
      return { changed: false, changes: [], checkin: mapCheckin(row), registration };
    }

    await this.db.transaction(async (tx) => {
      if (sets.length) {
        await tx.prepare(`UPDATE checkins SET ${sets.join(', ')} WHERE id = ?`)
          .run(...params, row.id);
      }
      if (newStaffName !== undefined) {
        await tx.prepare('UPDATE registrations SET sales_staff_name = ?, updated_at = ? WHERE id = ?')
          .run(newStaffName, this.now(), registrationId);
      }
      // The status does not move, but what changed, who changed it and when all
      // go on the record.
      await this.registrations.recordNote(
        registrationId, registration.status, actor,
        `Check-in corrected — ${changes.join('; ')}`, tx,
      );
    });

    return {
      changed: true,
      changes,
      checkin: mapCheckin(await this.db.prepare('SELECT * FROM checkins WHERE id = ?').get(row.id)),
      registration: await this.registrations.getById(registrationId),
    };
  }

  async listCheckins({ salesOfficeId = null, date = null } = {}) {
    const where = [];
    const params = [];
    if (salesOfficeId) { where.push('sales_office_id = ?'); params.push(salesOfficeId); }
    // The business day the group was admitted on, not the UTC date of the stamp.
    if (date) { where.push('COALESCE(admitted_date, substr(checkin_time, 1, 10)) = ?'); params.push(date); }
    const sql = `SELECT * FROM checkins ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY checkin_time DESC`;
    return (await this.db.prepare(sql).all(...params)).map(mapCheckin);
  }
}

module.exports = { CheckinService };
