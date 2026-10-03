'use strict';

const {
  LANGUAGES, VISITOR_TYPES, MAX_ADVANCE_DAYS, OTHER_AGENCY_ID, MAX_AGENCY_NAME_LENGTH,
} = require('../config/master-data');
const { isValidDateString, isVisitDateWithinWindow, addDays } = require('./dates');
const { badRequest } = require('./errors');

/**
 * ASSUMPTIONS (§Rule 12 — flagged, not silently invented):
 *  A1. Email is OPTIONAL. §VI lists "Required." explicitly for Full Name, CCCD,
 *      Phone and Number of Visitors, but for Email says only "Có validation email".
 *      It is therefore validated when supplied and accepted when blank.
 *  A2. Number of Visitors upper bound = 20 per registration. The spec forbids 0 but
 *      gives no maximum; a bound is required so slot capacity is meaningful.
 *  A3. CCCD accepts the 12-digit (current) or 9-digit (legacy) Vietnamese citizen ID.
 *  A4. Slot capacity is measured in PEOPLE (sum of number_of_visitors), not in
 *      registrations, since the constraint is show-house occupancy.
 */
const MAX_VISITORS_PER_REGISTRATION = 20;
const MAX_NOTES_LENGTH = 500;
const MAX_NAME_LENGTH = 120;

const CCCD_RE = /^(\d{12}|\d{9})$/;
const PHONE_RE = /^0\d{9}$/;               // normalized Vietnamese mobile/landline
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
const LAST4_RE = /^\d{4}$/;

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** Collapses internal whitespace; keeps Unicode letters (Vietnamese names). */
const cleanName = (v) => str(v).replace(/\s+/g, ' ');

/** Digits only, and +84 / 84 prefixes folded to a leading 0. */
function normalizePhone(v) {
  let s = str(v).replace(/[\s.()-]/g, '');
  if (s.startsWith('+84')) s = `0${s.slice(3)}`;
  else if (s.startsWith('84') && s.length === 11) s = `0${s.slice(2)}`;
  return s;
}

const normalizeCccd = (v) => str(v).replace(/[\s.-]/g, '');

function addError(errors, field, code, message) {
  errors.push({ field, code, message });
}

/** §XLI Process 1 */
function validateLanguage(language, errors) {
  if (!LANGUAGES.includes(language)) {
    addError(errors, 'language', 'INVALID_LANGUAGE',
      `Language must be one of: ${LANGUAGES.join(', ')}.`);
    return null;
  }
  return language;
}

/** §XLI Process 2 — §IV: Sales Office is mandatory. */
function validateSalesOffice(officeId, offices, errors) {
  const id = str(officeId);
  if (!id) {
    addError(errors, 'salesOfficeId', 'SALES_OFFICE_REQUIRED', 'Sales Office is required.');
    return null;
  }
  const office = offices.find((o) => o.id === id);
  if (!office) {
    addError(errors, 'salesOfficeId', 'INVALID_SALES_OFFICE', 'Unknown Sales Office.');
    return null;
  }
  return office;
}

/** §XLI Process 3 */
function validateVisitorType(visitorType, errors) {
  if (!Object.values(VISITOR_TYPES).includes(visitorType)) {
    addError(errors, 'visitorType', 'INVALID_VISITOR_TYPE',
      `Visitor Type must be one of: ${Object.values(VISITOR_TYPES).join(', ')}.`);
    return null;
  }
  return visitorType;
}

/** §VII / §XIV / §XLI Process 5 — backend enforcement of the 10-day window. */
function validateVisitDate(visitDate, today, errors) {
  const v = str(visitDate);
  if (!v) {
    addError(errors, 'visitDate', 'VISIT_DATE_REQUIRED', 'Visit date is required.');
    return null;
  }
  if (!isValidDateString(v)) {
    addError(errors, 'visitDate', 'INVALID_VISIT_DATE', 'Visit date must be a valid YYYY-MM-DD date.');
    return null;
  }
  if (!isVisitDateWithinWindow(v, today)) {
    addError(errors, 'visitDate', 'VISIT_DATE_OUT_OF_RANGE',
      `Visit date must be between ${today} and ${addDays(today, MAX_ADVANCE_DAYS)} (max ${MAX_ADVANCE_DAYS} days in advance).`);
    return null;
  }
  return v;
}

/** §VIII / §XV / §XLI Process 6 — slot must exist and be active. */
function validateTimeSlot(timeSlotId, slots, errors) {
  const id = str(timeSlotId);
  if (!id) {
    addError(errors, 'timeSlotId', 'TIME_SLOT_REQUIRED', 'Time slot is required.');
    return null;
  }
  const slot = slots.find((s) => s.id === id && s.active !== 0 && s.active !== false);
  if (!slot) {
    addError(errors, 'timeSlotId', 'INVALID_TIME_SLOT', 'Unknown or inactive time slot.');
    return null;
  }
  return slot;
}

/** §VI.5 / §XIII.3 — required, never 0. */
function validateNumberOfVisitors(value, errors) {
  if (value === '' || value === null || value === undefined) {
    addError(errors, 'numberOfVisitors', 'NUMBER_OF_VISITORS_REQUIRED', 'Number of visitors is required.');
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n)) {
    addError(errors, 'numberOfVisitors', 'INVALID_NUMBER_OF_VISITORS', 'Number of visitors must be a whole number.');
    return null;
  }
  if (n <= 0) {
    addError(errors, 'numberOfVisitors', 'NUMBER_OF_VISITORS_TOO_LOW', 'Number of visitors must be at least 1.');
    return null;
  }
  if (n > MAX_VISITORS_PER_REGISTRATION) {
    addError(errors, 'numberOfVisitors', 'NUMBER_OF_VISITORS_TOO_HIGH',
      `Number of visitors cannot exceed ${MAX_VISITORS_PER_REGISTRATION}.`);
    return null;
  }
  return n;
}

function validateNotes(notes, errors) {
  const v = str(notes);
  if (v.length > MAX_NOTES_LENGTH) {
    addError(errors, 'notes', 'NOTES_TOO_LONG', `Notes cannot exceed ${MAX_NOTES_LENGTH} characters.`);
    return null;
  }
  return v || null;
}

function validateRequiredName(value, field, label, errors) {
  const v = cleanName(value);
  if (!v) {
    addError(errors, field, 'REQUIRED', `${label} is required.`);
    return null;
  }
  if (v.length > MAX_NAME_LENGTH) {
    addError(errors, field, 'TOO_LONG', `${label} cannot exceed ${MAX_NAME_LENGTH} characters.`);
    return null;
  }
  return v;
}

function validateCccd(value, field, label, errors) {
  const v = normalizeCccd(value);
  if (!v) {
    addError(errors, field, 'REQUIRED', `${label} is required.`);
    return null;
  }
  if (!CCCD_RE.test(v)) {
    addError(errors, field, 'INVALID_CCCD', `${label} must be 12 digits (or 9 for legacy IDs).`);
    return null;
  }
  return v;
}

function validatePhone(value, field, label, errors) {
  const v = normalizePhone(value);
  if (!v) {
    addError(errors, field, 'REQUIRED', `${label} is required.`);
    return null;
  }
  if (!PHONE_RE.test(v)) {
    addError(errors, field, 'INVALID_PHONE', `${label} must be a 10-digit Vietnamese number starting with 0.`);
    return null;
  }
  return v;
}

/** Assumption A1 — optional, validated when present. */
function validateOptionalEmail(value, errors) {
  const v = str(value);
  if (!v) return null;
  if (!EMAIL_RE.test(v)) {
    addError(errors, 'email', 'INVALID_EMAIL', 'Email format is not valid.');
    return null;
  }
  return v.toLowerCase();
}

/** §XIII.2 — only the last 4 digits of the customer's phone are ever accepted. */
function validateLast4(value, errors) {
  const v = str(value).replace(/\s/g, '');
  if (!v) {
    addError(errors, 'customerPhoneLast4', 'REQUIRED', 'Last 4 digits of the customer phone are required.');
    return null;
  }
  if (!LAST4_RE.test(v)) {
    addError(errors, 'customerPhoneLast4', 'INVALID_LAST4', 'Enter exactly 4 digits.');
    return null;
  }
  return v;
}

/**
 * §XXII — which agency brought the customer.
 *
 * Picking "Khác" means the unit is not on the list, so the name is typed in and
 * is then required: a registration that names no agency at all would tell the
 * sales office nothing about where the customer came from. Enforced here, in the
 * backend, not only in the form (§Rule 4).
 *
 * A typed name that matches a listed agency is folded back onto that agency
 * (§Rule 11, no duplicate records): "KIM OANH REALTY" entered under "Khác" is the
 * agency already on the list, and two spellings of one agency would otherwise
 * split every statistic between them.
 *
 * @returns {{id: string, name: string|null}|null}
 */
function validateAgency(agencyId, agencies, errors, customName) {
  const id = str(agencyId);
  if (!id) {
    addError(errors, 'agencyId', 'REQUIRED', 'Agency is required.');
    return null;
  }
  const agency = agencies.find((a) => a.id === id && a.active !== 0 && a.active !== false);
  if (!agency) {
    addError(errors, 'agencyId', 'INVALID_AGENCY', 'Unknown or inactive agency.');
    return null;
  }
  if (agency.id !== OTHER_AGENCY_ID) return { id: agency.id, name: agency.name };

  const typed = cleanName(customName);
  if (!typed) {
    addError(errors, 'agencyName', 'REQUIRED', 'Enter the name of the agency.');
    return { id: agency.id, name: null };
  }
  if (typed.length > MAX_AGENCY_NAME_LENGTH) {
    addError(errors, 'agencyName', 'TOO_LONG',
      `Agency name cannot exceed ${MAX_AGENCY_NAME_LENGTH} characters.`);
    return { id: agency.id, name: null };
  }
  const listed = agencies.find((a) => a.id !== OTHER_AGENCY_ID
    && a.active !== 0 && a.active !== false
    && a.name.toLowerCase() === typed.toLowerCase());
  if (listed) return { id: listed.id, name: listed.name };

  return { id: agency.id, name: typed };
}

/**
 * §XLI Process 4 — full form validation for both visitor types.
 * Returns { value, errors }. `errors` empty means the payload is accepted.
 */
function validateRegistrationInput(input, ctx) {
  const errors = [];
  const { offices, slots, agencies, today } = ctx;
  const payload = input && typeof input === 'object' ? input : {};

  const language = validateLanguage(payload.language, errors);
  const office = validateSalesOffice(payload.salesOfficeId, offices, errors);
  const visitorType = validateVisitorType(payload.visitorType, errors);
  const visitDate = validateVisitDate(payload.visitDate, today, errors);
  const slot = validateTimeSlot(payload.timeSlotId, slots, errors);
  const numberOfVisitors = validateNumberOfVisitors(payload.numberOfVisitors, errors);
  const notes = validateNotes(payload.notes, errors);

  const value = {
    language,
    salesOfficeId: office?.id ?? null,
    visitorType,
    visitDate,
    timeSlotId: slot?.id ?? null,
    numberOfVisitors,
    notes,
  };

  if (visitorType === VISITOR_TYPES.VISITOR) {
    value.fullName = validateRequiredName(payload.fullName, 'fullName', 'Full name', errors);
    value.cccd = validateCccd(payload.cccd, 'cccd', 'Citizen ID (CCCD)', errors);
    value.phone = validatePhone(payload.phone, 'phone', 'Phone number', errors);
    value.email = validateOptionalEmail(payload.email, errors);
  } else if (visitorType === VISITOR_TYPES.AGENCY) {
    const agency = validateAgency(payload.agencyId, agencies, errors, payload.agencyName);
    value.agencyId = agency?.id ?? null;
    value.agencyName = agency?.name ?? null;
    value.salesStaffName = validateRequiredName(payload.salesStaffName, 'salesStaffName', 'Sales staff name', errors);
    value.salesStaffCccd = validateCccd(payload.salesStaffCccd, 'salesStaffCccd', 'Sales staff CCCD', errors);
    value.salesStaffPhone = validatePhone(payload.salesStaffPhone, 'salesStaffPhone', 'Sales staff phone', errors);
    value.customerShortName = validateRequiredName(payload.customerShortName, 'customerShortName', 'Customer short name', errors);
    value.customerPhoneLast4 = validateLast4(payload.customerPhoneLast4, errors);
  }

  return { value, errors };
}

function assertNoErrors(errors) {
  if (errors.length > 0) {
    throw badRequest('VALIDATION_FAILED', 'One or more fields are invalid.', errors);
  }
}

module.exports = {
  MAX_VISITORS_PER_REGISTRATION, MAX_NOTES_LENGTH, MAX_NAME_LENGTH,
  CCCD_RE, PHONE_RE, EMAIL_RE, LAST4_RE,
  normalizePhone, normalizeCccd, cleanName,
  validateLanguage, validateSalesOffice, validateVisitorType, validateVisitDate,
  validateTimeSlot, validateNumberOfVisitors, validateNotes, validateRequiredName,
  validateCccd, validatePhone, validateOptionalEmail, validateLast4, validateAgency,
  validateRegistrationInput, assertNoErrors,
};
