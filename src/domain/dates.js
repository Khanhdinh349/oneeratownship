'use strict';

const { MAX_ADVANCE_DAYS, BUSINESS_UTC_OFFSET_MINUTES } = require('../config/master-data');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The instant shifted so its UTC fields read as the business's wall clock. */
function businessClock(d) {
  return new Date(new Date(d).getTime() + BUSINESS_UTC_OFFSET_MINUTES * 60000);
}

/** Calendar date (YYYY-MM-DD) of an instant, as the business sees it. */
function toDateString(d) {
  return businessClock(d).toISOString().slice(0, 10);
}

/** Minutes since midnight, business time — 09:30 is 570. */
function minutesOfDay(d) {
  const b = businessClock(d);
  return b.getUTCHours() * 60 + b.getUTCMinutes();
}

/** '09:00' → 540. */
function parseHm(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + m;
}

function isValidDateString(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, day] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day;
}

function addDays(dateString, days) {
  const [y, m, d] = dateString.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function toUtcMillis(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function diffDays(from, to) {
  return Math.round((toUtcMillis(to) - toUtcMillis(from)) / 86400000);
}

/**
 * §VII / §XLI Process 5 — booking window.
 *   today <= visitDate <= today + MAX_ADVANCE_DAYS
 * Spec example: today 01/10 → selectable 01/10 … 11/10 (11 days inclusive).
 * Enforced on the backend, not only in the UI (§VII "Không được chỉ khóa trên UI").
 */
function isVisitDateWithinWindow(visitDate, today) {
  if (!isValidDateString(visitDate)) return false;
  const delta = diffDays(today, visitDate);
  return delta >= 0 && delta <= MAX_ADVANCE_DAYS;
}

/** Inclusive list of every selectable visit date, for the UI date picker. */
function selectableDates(today) {
  return Array.from({ length: MAX_ADVANCE_DAYS + 1 }, (_, i) => addDays(today, i));
}

function startOfWeek(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0 = Sunday
  const backToMonday = (dow + 6) % 7;
  return addDays(dateString, -backToMonday);
}

function monthRange(dateString) {
  const [y, m] = dateString.split('-').map(Number);
  const first = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: first, to: `${first.slice(0, 8)}${String(daysInMonth).padStart(2, '0')}` };
}

module.exports = {
  DATE_RE, toDateString, minutesOfDay, parseHm, businessClock,
  isValidDateString, addDays, diffDays,
  isVisitDateWithinWindow, selectableDates, startOfWeek, monthRange,
};
