'use strict';

/**
 * MASTER DATA
 * Per spec §XLVI: only 2 languages, 2 sales offices, 2 visitor types.
 * Nothing here is invented beyond the specification.
 */

const LANGUAGES = Object.freeze(['vi', 'en']);

const VISITOR_TYPES = Object.freeze({
  VISITOR: 'VISITOR', // Khách Tham Quan
  AGENCY: 'AGENCY',   // Đại Lý
});

const SALES_OFFICES = Object.freeze([
  Object.freeze({
    id: 'CII_BINH_THANH',
    name: 'CII - Bình Thạnh',
    location: 'TP. Hồ Chí Minh',
    address: 'Toà nhà CII, Quận Bình Thạnh, TP. Hồ Chí Minh',
    openingHours: '08:00 - 17:00',
    contact: '028 1234 5678',
    // §XXIX / §XLVI.16 — parking ticket tracking applies to CII only.
    parkingTicketEnabled: true,
  }),
  Object.freeze({
    id: 'THUAN_GIAO_BINH_DUONG',
    name: 'Thuận Giao - Bình Dương',
    location: 'Bình Dương',
    address: 'Thuận Giao, TP. Thuận An, Bình Dương',
    openingHours: '08:00 - 17:00',
    contact: '0274 1234 567',
    parkingTicketEnabled: false,
  }),
]);

/**
 * TIME SLOTS — §VIII
 *
 * The source requirement listed 09:00 – 10:30 twice and §XLVII asked for the
 * duplicate to be flagged rather than silently removed. That question has since
 * been settled with the business: there is ONE 09:00 – 10:30 slot, and every slot
 * holds at most 30 guests. Capacity is counted in people, per office and per date,
 * and an Administrator can change it through the master-data API.
 */
const SLOT_CAPACITY = 30;

const TIME_SLOTS = Object.freeze([
  Object.freeze({
    id: 'SLOT_0900_1030', startTime: '09:00', endTime: '10:30',
    label: '09:00 – 10:30', capacity: SLOT_CAPACITY,
  }),
  Object.freeze({
    id: 'SLOT_1030_1200', startTime: '10:30', endTime: '12:00',
    label: '10:30 – 12:00', capacity: SLOT_CAPACITY,
  }),
  Object.freeze({
    id: 'SLOT_1300_1430', startTime: '13:00', endTime: '14:30',
    label: '13:00 – 14:30', capacity: SLOT_CAPACITY,
  }),
  Object.freeze({
    id: 'SLOT_1430_1600', startTime: '14:30', endTime: '16:00',
    label: '14:30 – 16:00', capacity: SLOT_CAPACITY,
  }),
]);

/**
 * AGENCIES — §XI
 * Official list "will be provided later"; spec forbids hard-coding it into the
 * application if the data comes from Master Data. It therefore lives in the
 * `agencies` DB table and this array is only the initial seed, replaceable by an
 * Administrator through the master-data API.
 */
/**
 * §XXII — the agencies (đại lý) that bring customers to a sales office.
 *
 * The ids are stable and never regenerated from the name: a registration keeps a
 * foreign key to one of these for the life of the record, so renaming an agency
 * must change `name` here, never `id`. The display name is stored on the
 * registration as well, so an agency renamed later does not rewrite history.
 *
 * `sortOrder` keeps "Khác" at the bottom of the dropdown; everything else sorts
 * by name.
 */
const OTHER_AGENCY_ID = 'AG_OTHER';

const AGENCY_SEED = Object.freeze([
  Object.freeze({ id: 'AG_AN_GIA_LAP_NGHIEP', name: 'AN GIA LẬP NGHIỆP' }),
  Object.freeze({ id: 'AG_AN_THINH_PHAT', name: 'AN THỊNH PHÁT' }),
  Object.freeze({ id: 'AG_BOH', name: 'BOH' }),
  Object.freeze({ id: 'AG_BVM', name: 'BVM' }),
  Object.freeze({ id: 'AG_DWELL_REALTY', name: 'DWELL REALTY' }),
  Object.freeze({ id: 'AG_EMPIRE', name: 'EMPIRE' }),
  Object.freeze({ id: 'AG_IQI', name: 'IQI' }),
  Object.freeze({ id: 'AG_KIM_OANH_REALTY', name: 'KIM OANH REALTY' }),
  Object.freeze({ id: 'AG_KZZEN', name: 'KZEN' }),
  Object.freeze({ id: 'AG_LINH_HOMES', name: 'LINH HOMES' }),
  Object.freeze({ id: 'AG_LM_CONA_LAND_DAT_GROUP_SINGA', name: 'LM: CONA LAND - DAT GROUP - SINGA' }),
  Object.freeze({ id: 'AG_LM_LOC_PHAT_HUNG_THE_GLOBAL_HOLDING', name: 'LM: LỘC PHÁT HƯNG - THE GLOBAL HOLDING' }),
  Object.freeze({ id: 'AG_LM_RED_SWAN_IHD', name: 'LM: RED SWAN - IHD' }),
  Object.freeze({ id: 'AG_LM_THIEN_PHAT_REALTY_HPR_HAYHOMES', name: 'LM: THIÊN PHÁT REALTY - HPR - HAYHOMES' }),
  Object.freeze({ id: 'AG_LM_VISTALAND_TEA_LAND', name: 'LM: VISTALAND - TEA LAND' }),
  Object.freeze({ id: 'AG_NHA_NHU_Y_PROPER_HOMES', name: 'NHÀ NHƯ Ý (PROPER HOMES)' }),
  Object.freeze({ id: 'AG_NHA_TOAN_CAU_GLOBAL_HOMES', name: 'NHÀ TOÀN CẦU (GLOBAL HOMES)' }),
  Object.freeze({ id: 'AG_NOV_SAIGON', name: 'NOV SAIGON' }),
  Object.freeze({ id: 'AG_REALPLUS', name: 'REALPLUS' }),
  Object.freeze({ id: 'AG_SAI_GON_REALTY', name: 'SÀI GÒN REALTY' }),
  Object.freeze({ id: 'AG_THE_GIOI_DAT_VIET', name: 'THẾ GIỚI ĐẤT VIỆT' }),
  // Picking this one asks for the agency's name instead, so a unit that is not on
  // the list yet can still register rather than being turned away at the kiosk.
  Object.freeze({ id: OTHER_AGENCY_ID, name: 'Khác', allowsCustomName: true, sortOrder: 100 }),
]);

/**
 * Placeholder agencies from before the real list existed. They are switched off
 * rather than deleted: registrations already point at them, and a deleted row
 * would break those foreign keys.
 */
const RETIRED_AGENCY_IDS = Object.freeze(['AG_A', 'AG_B', 'AG_C']);

/** How long a typed-in agency name may be. */
const MAX_AGENCY_NAME_LENGTH = 120;

const ROLES = Object.freeze({
  RECEPTIONIST: 'RECEPTIONIST',
  SALES: 'SALES',
  MANAGER: 'MANAGER',
  ADMINISTRATOR: 'ADMINISTRATOR',
});

/** §VII — booking window: today .. today + 10 days inclusive. */
const MAX_ADVANCE_DAYS = 10;

/** §XXXVII — data refresh cadence. */
const AUTO_REFRESH_MS = 60 * 1000;

const CHECKIN_METHODS = Object.freeze({ QR: 'QR', SEARCH: 'SEARCH' });

/** §XXIX — parking tickets are counted separately per vehicle type. */
const VEHICLE_TYPES = Object.freeze({ CAR: 'CAR', MOTORBIKE: 'MOTORBIKE' });

/**
 * How far the arrival count may differ from the booking before the desk is told
 * the number looks wrong. A party can grow or shrink a little on the day; a wild
 * number is usually a typo.
 */
const MAX_GUEST_OVERAGE = 10;

/**
 * The wall clock every report is written in (Asia/Ho_Chi_Minh, UTC+7, no DST).
 *
 * Timestamps are stored in UTC, but a spreadsheet cell carries no timezone — so
 * the export states the zone explicitly instead of inheriting whatever the server
 * happens to be set to. Otherwise the same file would read 15:30 when exported
 * from a machine in Vietnam and 08:30 from one in UTC.
 */
const REPORT_UTC_OFFSET_MINUTES = 7 * 60;

/**
 * The clock the business itself runs on.
 *
 * "Today", "this slot has ended" and "they arrived twenty minutes late" are all
 * statements about time in Vietnam. The server may sit in any timezone (Vercel
 * runs in UTC), and before this existed "today" was the UTC date — seven hours
 * out, so a visitor booking at 06:00 was offered yesterday as the first day.
 */
const BUSINESS_UTC_OFFSET_MINUTES = REPORT_UTC_OFFSET_MINUTES;

/**
 * How far either side of a slot's start still counts as arriving on time.
 * Outside the slot altogether — earlier than the grace before it, or after it
 * has ended — the desk has to confirm the check-in, and the group is counted
 * against whichever slot is actually running when they walk in.
 */
const EARLY_GRACE_MINUTES = 15;
const LATE_GRACE_MINUTES = 15;

/** How a group's arrival compared with the slot it booked. */
const ARRIVAL = Object.freeze({
  ON_TIME: 'ON_TIME',
  LATE: 'LATE',               // inside its own slot, past the grace
  EARLY: 'EARLY',             // before its own slot opens
  AFTER_SLOT: 'AFTER_SLOT',   // its own slot has already ended
  OTHER_DAY: 'OTHER_DAY',     // not the day that was booked
});

/** A user counts as online if they were seen this recently. */
const ONLINE_WINDOW_MINUTES = 5;

const officeById = (id) => SALES_OFFICES.find((o) => o.id === id) || null;
const slotById = (id) => TIME_SLOTS.find((s) => s.id === id) || null;

module.exports = {
  LANGUAGES,
  VISITOR_TYPES,
  SALES_OFFICES,
  TIME_SLOTS,
  SLOT_CAPACITY,
  AGENCY_SEED,
  OTHER_AGENCY_ID,
  RETIRED_AGENCY_IDS,
  MAX_AGENCY_NAME_LENGTH,
  ROLES,
  MAX_ADVANCE_DAYS,
  AUTO_REFRESH_MS,
  CHECKIN_METHODS,
  VEHICLE_TYPES,
  MAX_GUEST_OVERAGE,
  REPORT_UTC_OFFSET_MINUTES,
  BUSINESS_UTC_OFFSET_MINUTES,
  EARLY_GRACE_MINUTES,
  LATE_GRACE_MINUTES,
  ARRIVAL,
  ONLINE_WINDOW_MINUTES,
  officeById,
  slotById,
};
