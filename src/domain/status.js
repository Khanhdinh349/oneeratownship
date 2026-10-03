'use strict';

const { conflict } = require('./errors');

/**
 * §XXIII — Status lifecycle
 *   Registered → Confirmed → Expected → Checked In → In Visit → Completed
 * Plus terminal exits: Cancelled, No Show.
 */
const STATUS = Object.freeze({
  REGISTERED: 'REGISTERED',
  CONFIRMED: 'CONFIRMED',
  EXPECTED: 'EXPECTED',
  CHECKED_IN: 'CHECKED_IN',
  IN_VISIT: 'IN_VISIT',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
});

const ALL_STATUSES = Object.freeze(Object.values(STATUS));

/** Statuses from which the visitor may still turn up at the desk. */
const CHECKIN_ELIGIBLE = Object.freeze([STATUS.REGISTERED, STATUS.CONFIRMED, STATUS.EXPECTED]);

/** Ordered funnel used by the dashboard (§XXXIII). */
const FUNNEL = Object.freeze([
  STATUS.REGISTERED, STATUS.CONFIRMED, STATUS.EXPECTED, STATUS.CHECKED_IN,
  STATUS.IN_VISIT, STATUS.COMPLETED,
]);

const TRANSITIONS = Object.freeze({
  [STATUS.REGISTERED]: [STATUS.CONFIRMED, STATUS.EXPECTED, STATUS.CHECKED_IN, STATUS.CANCELLED, STATUS.NO_SHOW],
  [STATUS.CONFIRMED]:  [STATUS.EXPECTED, STATUS.CHECKED_IN, STATUS.CANCELLED, STATUS.NO_SHOW],
  [STATUS.EXPECTED]:   [STATUS.CHECKED_IN, STATUS.CANCELLED, STATUS.NO_SHOW],
  [STATUS.CHECKED_IN]: [STATUS.IN_VISIT, STATUS.COMPLETED],
  [STATUS.IN_VISIT]:   [STATUS.COMPLETED],
  [STATUS.COMPLETED]:  [],
  [STATUS.CANCELLED]:  [],
  [STATUS.NO_SHOW]:    [],
});

function isKnownStatus(s) {
  return ALL_STATUSES.includes(s);
}

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

function assertTransition(from, to) {
  if (!isKnownStatus(to)) {
    throw conflict('UNKNOWN_STATUS', `Unknown status "${to}".`);
  }
  if (!canTransition(from, to)) {
    throw conflict('INVALID_STATUS_TRANSITION',
      `Cannot change status from ${from} to ${to}.`,
      { from, to, allowed: TRANSITIONS[from] ?? [] });
  }
}

/** Counts as "already arrived" — blocks a second check-in. */
function isCheckedInOrBeyond(status) {
  return [STATUS.CHECKED_IN, STATUS.IN_VISIT, STATUS.COMPLETED].includes(status);
}

module.exports = {
  STATUS, ALL_STATUSES, CHECKIN_ELIGIBLE, FUNNEL, TRANSITIONS,
  isKnownStatus, canTransition, assertTransition, isCheckedInOrBeyond,
};
