'use strict';

const { ROLES } = require('../config/master-data');
const { forbidden } = require('./errors');

/** §XXXIX — permission matrix. */
const P = Object.freeze({
  REGISTRATION_CREATE: 'registration:create',
  REGISTRATION_VIEW: 'registration:view',
  REGISTRATION_SEARCH: 'registration:search',
  QR_SCAN: 'qr:scan',
  CHECKIN: 'checkin:perform',
  /**
   * Correct a check-in after the fact — the arrival count, the slot the group was
   * admitted into, the agency's sales staff. Reception holds this because
   * reception is who notices the mistake, usually minutes later.
   */
  CHECKIN_AMEND: 'checkin:amend',
  STATUS_UPDATE: 'status:update',
  PARKING_TICKET_UPDATE: 'parking:update',
  CALENDAR_VIEW: 'calendar:view',
  DASHBOARD_VIEW: 'dashboard:view',
  REPORTS_VIEW: 'reports:view',
  /**
   * Export the registration list to Excel. Deliberately the same audience as
   * REGISTRATION_VIEW: the file contains exactly the rows and columns the user can
   * already read on screen, scoped to their own office (§XXV).
   */
  REGISTRATION_EXPORT: 'registration:export',
  /**
   * The customer statistics screen and its export. Management information, not
   * desk work — so Manager and Administrator only, per §XXXIX, where the whole
   * data set is theirs to see and the desk roles are confined to their own day.
   */
  CUSTOMER_STATS_VIEW: 'customer-stats:view',
  MASTER_DATA_MANAGE: 'masterdata:manage',
  USER_MANAGE: 'user:manage',
  /** Close a date, a range of dates or a single time slot to new registrations. */
  SCHEDULE_BLOCK: 'schedule:block',
  /**
   * The floor procedure. Desk roles only — it describes work an administrator
   * does not do, and the administrator's screen is account management.
   */
  GUIDE_VIEW: 'guide:view',
  /** The administrative audit log — who changed what, and when. */
  AUDIT_VIEW: 'audit:view',
});

const MATRIX = Object.freeze({
  [ROLES.RECEPTIONIST]: [
    P.REGISTRATION_CREATE, P.REGISTRATION_VIEW, P.REGISTRATION_SEARCH, P.REGISTRATION_EXPORT,
    P.QR_SCAN, P.CHECKIN, P.CHECKIN_AMEND,
    P.STATUS_UPDATE, P.PARKING_TICKET_UPDATE, P.CALENDAR_VIEW, P.GUIDE_VIEW,
  ],
  [ROLES.SALES]: [
    P.REGISTRATION_CREATE, P.REGISTRATION_VIEW, P.REGISTRATION_SEARCH,
    P.REGISTRATION_EXPORT, P.CALENDAR_VIEW, P.GUIDE_VIEW,
  ],
  [ROLES.MANAGER]: [
    P.REGISTRATION_VIEW, P.REGISTRATION_SEARCH, P.REGISTRATION_EXPORT, P.CALENDAR_VIEW,
    P.DASHBOARD_VIEW, P.REPORTS_VIEW, P.CUSTOMER_STATS_VIEW, P.GUIDE_VIEW,
  ],
  /**
   * The Administrator runs the system, not the floor.
   *
   * Accounts, master data and the opening calendar — and deliberately NOT
   * check-in, the registration list, the dashboard or the customer statistics.
   * Those hold visitors' names, ID numbers and phone numbers, and an account
   * whose job is managing logins has no reason to read them. It keeps the
   * personal data with the people who actually receive the visitors; anyone
   * who needs both holds an account of each kind.
   */
  [ROLES.ADMINISTRATOR]: [
    P.USER_MANAGE, P.MASTER_DATA_MANAGE, P.SCHEDULE_BLOCK, P.CALENDAR_VIEW, P.AUDIT_VIEW,
  ],
});

function can(user, permission) {
  if (!user) return false;
  return Boolean(MATRIX[user.role]?.includes(permission));
}

function assertCan(user, permission) {
  if (!can(user, permission)) {
    throw forbidden(`Your role (${user?.role ?? 'anonymous'}) is not permitted to ${permission}.`);
  }
}

/**
 * §XXV / §XLVI.11 — the office a staff user is confined to.
 * Receptionist and Sales are pinned to their own office; Manager and Administrator
 * are unrestricted and may pass an explicit office filter instead.
 */
function scopeOfficeFor(user) {
  if (!user) return null;
  if ([ROLES.RECEPTIONIST, ROLES.SALES].includes(user.role)) return user.salesOfficeId ?? null;
  return null;
}

module.exports = { P, MATRIX, can, assertCan, scopeOfficeFor };
