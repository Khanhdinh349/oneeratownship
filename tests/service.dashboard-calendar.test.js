'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildApp, makeClock, visitorPayload, agencyPayload,
  OFFICE_CII, OFFICE_TG, SLOT_A, SLOT_B, SLOT_1030,
} = require('./helpers');

/**
 * A fixed scenario used by most dashboard assertions. "Today" is 2026-10-05.
 *
 *  CII  2026-10-05  SLOT_A     VISITOR  2 people  → CHECKED_IN (+ parking ticket)
 *  CII  2026-10-05  SLOT_B     VISITOR  1 person  → COMPLETED  (+ ticket returned)
 *  CII  2026-10-05  SLOT_1030  AGENCY   6 people  → REGISTERED (expected)
 *  CII  2026-10-05  SLOT_1300  VISITOR  1 person  → NO_SHOW
 *  TG   2026-10-05  SLOT_A     VISITOR  4 people  → CHECKED_IN
 *  TG   2026-10-06  SLOT_1030  AGENCY   3 people  → CANCELLED
 */
async function scenario() {
  const clock = makeClock('2026-10-05T02:30:00.000Z');
  const { services } = await buildApp({ clock });
  const { registrations, checkins, auth } = services;
  const cii = (await auth.login('cii.reception01', 'Reception@123')).user;
  const tg = (await auth.login('tg.reception01', 'Reception@123')).user;
  const actor = { id: cii.id, name: cii.fullName };

  const r1 = await registrations.createRegistration(visitorPayload({
    visitDate: '2026-10-05', timeSlotId: SLOT_A, numberOfVisitors: 2, cccd: '111111111111',
    fullName: 'Nguyễn Văn A',
  }));
  const r2 = await registrations.createRegistration(visitorPayload({
    visitDate: '2026-10-05', timeSlotId: SLOT_B, numberOfVisitors: 1, cccd: '222222222222',
    fullName: 'Trần Thị B',
  }));
  const r3 = await registrations.createRegistration(agencyPayload({
    salesOfficeId: OFFICE_CII, visitDate: '2026-10-05', timeSlotId: SLOT_1030, numberOfVisitors: 6,
  }));
  const r4 = await registrations.createRegistration(visitorPayload({
    visitDate: '2026-10-05', timeSlotId: 'SLOT_1300_1430', numberOfVisitors: 1, cccd: '444444444444',
  }));
  const r5 = await registrations.createRegistration(visitorPayload({
    salesOfficeId: OFFICE_TG, visitDate: '2026-10-05', timeSlotId: SLOT_A,
    numberOfVisitors: 4, cccd: '555555555555',
  }));
  const r6 = await registrations.createRegistration(agencyPayload({
    salesOfficeId: OFFICE_TG, visitDate: '2026-10-06', timeSlotId: SLOT_1030,
    numberOfVisitors: 3, salesStaffCccd: '666666666666',
  }));

  await checkins.checkIn(r1.id, { allowTimeOverride: true, user: cii, method: 'QR' });
  await services.parking.issue(r1.id, { vehicleType: 'CAR', ticketNumber: 'PX-1' }, { actor });

  await checkins.checkIn(r2.id, { allowTimeOverride: true, user: cii, method: 'SEARCH' });
  const moto = await services.parking.issue(r2.id, { vehicleType: 'MOTORBIKE', ticketNumber: 'PX-2' }, { actor });
  await services.parking.markReturned(moto.id, { actor });
  await registrations.changeStatus(r2.id, 'COMPLETED', { actor });

  await registrations.changeStatus(r4.id, 'NO_SHOW', { actor });
  await checkins.checkIn(r5.id, { allowTimeOverride: true, user: tg, method: 'QR' });
  await registrations.changeStatus(r6.id, 'CANCELLED', { actor });

  return { ...services, clock, users: { cii, tg }, regs: { r1, r2, r3, r4, r5, r6 } };
}

// ===========================================================================
// §XXX / §XLIV — KPIs
// ===========================================================================

test('§XXX KPI totals reflect the real registration and check-in data', async () => {
  const s = await scenario();
  const k = await s.dashboard.kpis();
  assert.equal(k.totalRegistration, 6, 'Total Registration');
  assert.equal(k.totalPeople, 17, '2+1+6+1+4+3 people');
  assert.equal(k.todaysVisitors, 5, "Today's Visitors — 5 registrations dated 2026-10-05");
  assert.equal(k.todaysPeople, 14);
  assert.equal(k.expected, 5, 'Expected — everyone due at an office, i.e. all but the cancellation');
  assert.equal(k.pending, 1, 'Pending — only the still-unarrived agency booking');
  assert.equal(k.checkedIn, 3, 'Checked-in counts arrived visitors including completed');
  assert.equal(k.completed, 1, 'Completed');
  assert.equal(k.noShow, 1, 'No Show');
  assert.equal(k.cancelled, 1, 'Cancelled');
  assert.equal(k.today, '2026-10-05');
});

test('§XXX byStatus exposes registration and people counts per status', async () => {
  const s = await scenario();
  const { byStatus } = await s.dashboard.kpis();
  assert.equal(byStatus.CHECKED_IN.registrations, 2);
  assert.equal(byStatus.CHECKED_IN.people, 6, 'r1 (2) + r5 (4)');
  assert.equal(byStatus.COMPLETED.registrations, 1);
  assert.equal(byStatus.REGISTERED.registrations, 1);
  assert.equal(byStatus.IN_VISIT.registrations, 0, 'unused statuses are present and zeroed');
});

test('§Rule 8 KPIs move as soon as the underlying registration changes', async () => {
  const s = await scenario();
  assert.equal((await s.dashboard.kpis()).completed, 1);
  await s.registrations.changeStatus(s.regs.r1.id, 'IN_VISIT');
  await s.registrations.changeStatus(s.regs.r1.id, 'COMPLETED');
  const after = await s.dashboard.kpis();
  assert.equal(after.completed, 2, 'no cached or duplicated dashboard data');
  assert.equal(after.checkedIn, 3, 'arrived count is unchanged');
});

test('§XXXI dashboard filters by sales office', async () => {
  const s = await scenario();
  const cii = await s.dashboard.kpis({ salesOfficeId: OFFICE_CII });
  assert.equal(cii.totalRegistration, 4);
  assert.equal(cii.noShow, 1);
  assert.equal(cii.cancelled, 0);

  const tg = await s.dashboard.kpis({ salesOfficeId: OFFICE_TG });
  assert.equal(tg.totalRegistration, 2);
  assert.equal(tg.cancelled, 1);
  assert.equal(tg.noShow, 0);
});

test('§XXXI byOffice reports one row per office with the full status spread', async () => {
  const s = await scenario();
  const rows = await s.dashboard.byOffice();
  assert.equal(rows.length, 2);
  const cii = rows.find((r) => r.salesOfficeId === OFFICE_CII);
  assert.equal(cii.salesOfficeName, 'CII - Bình Thạnh');
  assert.equal(cii.registration, 4);
  assert.equal(cii.expected, 1);
  assert.equal(cii.checkedIn, 2);
  assert.equal(cii.completed, 1);
  assert.equal(cii.noShow, 1);
  assert.equal(cii.parkingTicketEnabled, true);

  const tg = rows.find((r) => r.salesOfficeId === OFFICE_TG);
  assert.equal(tg.cancelled, 1);
  assert.equal(tg.parkingTicketEnabled, false);
});

test('§XXV a receptionist scope narrows byOffice to their own office only', async () => {
  const s = await scenario();
  const rows = await s.dashboard.byOffice({ scopeOfficeId: OFFICE_TG });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].salesOfficeId, OFFICE_TG);
});

test('§XXXII byVisitorType splits Khách Tham Quan from Đại Lý', async () => {
  const s = await scenario();
  const t = await s.dashboard.byVisitorType();
  assert.equal(t.VISITOR.registrations, 4);
  assert.equal(t.VISITOR.people, 8, '2+1+1+4');
  assert.equal(t.AGENCY.registrations, 2);
  assert.equal(t.AGENCY.people, 9, '6+3');
});

test('§XXXII day / week / month rollups use the right ranges', async () => {
  const s = await scenario();
  const p = await s.dashboard.periodBreakdown();
  assert.deepEqual(p.day.range, { from: '2026-10-05', to: '2026-10-05' });
  assert.deepEqual(p.week.range, { from: '2026-10-05', to: '2026-10-11' }, 'Monday-anchored week');
  assert.deepEqual(p.month.range, { from: '2026-10-01', to: '2026-10-31' });

  assert.equal(p.day.byVisitorType.VISITOR.registrations, 4, 'all four visitors are on 2026-10-05');
  assert.equal(p.day.byVisitorType.AGENCY.registrations, 1, 'the 10-06 agency booking is not in the day bucket');
  assert.equal(p.week.byVisitorType.AGENCY.registrations, 2, 'both agency bookings fall inside the week');
  assert.equal(p.month.byVisitorType.AGENCY.registrations, 2);
});

test('§XXXIII the funnel is cumulative — a checked-in visitor also counts as expected', async () => {
  const s = await scenario();
  const f = await s.dashboard.funnel();
  const at = (stage) => f.stages.find((x) => x.stage === stage).count;

  assert.equal(at('REGISTERED'), 4, 'every booking still in the pipeline');
  assert.equal(at('CONFIRMED'), 3, 'the one still sitting at Registered has not gone further');
  assert.equal(at('EXPECTED'), 3);
  assert.equal(at('CHECKED_IN'), 3, 'r1, r5 checked in and r2 completed');
  assert.equal(at('IN_VISIT'), 1, 'only the completed one passed In Visit');
  assert.equal(at('COMPLETED'), 1);
  assert.equal(f.arrived, 3);
  assert.equal(f.noShow, 1);
  assert.equal(f.cancelled, 1);
  assert.equal(f.expectedToArrive, 5, 'pipeline plus the no-show — the cancellation is excluded');

  // Monotonically non-increasing down the funnel.
  for (let i = 1; i < f.stages.length; i += 1) {
    assert.ok(f.stages[i].count <= f.stages[i - 1].count,
      `${f.stages[i].stage} must not exceed ${f.stages[i - 1].stage}`);
  }
});

test('§XXXIII the funnel matches the spec\'s Expected/Checked-in/No-show illustration', async () => {
  const clock = makeClock('2026-10-05T02:30:00.000Z');
  const { services } = await buildApp({ clock });
  const cii = (await services.auth.login('cii.reception01', 'Reception@123')).user;
  // Fifty single visitors cannot share one slot — the limit is thirty — so they
  // are spread over the first two, and each group checks in during its own.
  const made = [];
  for (let i = 0; i < 50; i += 1) {
    made.push(await services.registrations.createRegistration(visitorPayload({
      visitDate: '2026-10-05', timeSlotId: i < 25 ? SLOT_A : SLOT_1030, numberOfVisitors: 1,
      cccd: String(700000000000 + i),
    })));
  }
  for (const r of made.slice(0, 25)) {
    // eslint-disable-next-line no-await-in-loop
    await services.checkins.checkIn(r.id, { user: cii });
  }
  clock.set('2026-10-05T04:00:00.000Z'); // 11:00, inside the second slot
  for (const r of made.slice(25, 42)) {
    // eslint-disable-next-line no-await-in-loop
    await services.checkins.checkIn(r.id, { user: cii });
  }
  for (const r of made.slice(42)) {
    // eslint-disable-next-line no-await-in-loop
    await services.registrations.changeStatus(r.id, 'NO_SHOW');
  }

  const f = await services.dashboard.funnel();
  assert.equal(f.expectedToArrive, 50, 'Expected: 50');
  assert.equal(f.arrived, 42, 'Checked In: 42');
  assert.equal(f.noShow, 8, 'No Show: 8');
  assert.equal(f.expectedToArrive, f.arrived + f.noShow, 'the spec illustration balances exactly');
  assert.equal((await services.dashboard.kpis()).expected, 50, '§XXX Expected Visitors agrees with the funnel');
});

test('§XXXIV / §XLIV parking-ticket KPIs are split by vehicle type, CII only', async () => {
  const s = await scenario();
  const rows = await s.dashboard.parkingTickets();
  assert.equal(rows.length, 1, 'Thuận Giao is absent — it does not track parking tickets');
  const [cii] = rows;
  assert.equal(cii.salesOfficeId, OFFICE_CII);
  assert.equal(cii.totalVisitors, 2, 'only arrived visitors are counted');
  assert.equal(cii.totalPeople, 3);

  assert.deepEqual(cii.byVehicleType.CAR, { issued: 1, returned: 0, outstanding: 1 });
  assert.deepEqual(cii.byVehicleType.MOTORBIKE, { issued: 1, returned: 1, outstanding: 0 });

  assert.equal(cii.parkingTicketIssued, 2, 'cars + motorbikes');
  assert.equal(cii.parkingTicketReturned, 1);
  assert.equal(cii.parkingTicketOutstanding, 1, 'the car ticket is still out');
  assert.equal(cii.registrationsWithTicket, 2);
  assert.equal(cii.registrationsWithoutTicket, 0);
  assert.equal(cii.issueRate, 1);
});

test('§XXXIV visitors without a ticket are counted separately from ticket totals', async () => {
  const s = await scenario();
  // A third CII arrival with no parking ticket.
  const extra = await s.registrations.createRegistration(visitorPayload({
    visitDate: '2026-10-05', timeSlotId: SLOT_1030, numberOfVisitors: 1, cccd: '999999999999',
  }));
  await s.checkins.checkIn(extra.id, { allowTimeOverride: true, user: s.users.cii });

  const [cii] = await s.dashboard.parkingTickets();
  assert.equal(cii.totalVisitors, 3);
  assert.equal(cii.parkingTicketIssued, 2, 'still two tickets');
  assert.equal(cii.registrationsWithTicket, 2);
  assert.equal(cii.registrationsWithoutTicket, 1);
  assert.equal(cii.issueRate, 0.6667);
});

test('§XXXIV one registration can hold several tickets of both types', async () => {
  const s = await scenario();
  const actor = { id: s.users.cii.id, name: s.users.cii.fullName };
  // The r1 party arrives in a car and on two motorbikes.
  await s.parking.issue(s.regs.r1.id, { vehicleType: 'MOTORBIKE' }, { actor });
  await s.parking.issue(s.regs.r1.id, { vehicleType: 'MOTORBIKE' }, { actor });

  const summary = await s.parking.summaryFor(s.regs.r1.id);
  assert.equal(summary.total, 3);
  assert.equal(summary.byVehicleType.CAR.issued, 1);
  assert.equal(summary.byVehicleType.MOTORBIKE.issued, 2);

  const [cii] = await s.dashboard.parkingTickets();
  assert.equal(cii.byVehicleType.MOTORBIKE.issued, 3, 'two new plus the returned one');
  assert.equal(cii.registrationsWithTicket, 2, 'still two registrations, not five');
});

test('§XXVIII the dashboard reports arrivals against bookings', async () => {
  const s = await scenario();
  const ga = await s.dashboard.guestAccuracy();
  // r1 (2 booked) and r5 (4 booked) checked in exactly; r2 (1 booked) exactly.
  assert.equal(ga.checkins, 3);
  assert.equal(ga.expectedGuests, 7);
  assert.equal(ga.actualGuests, 7);
  assert.equal(ga.variance, 0);
  assert.equal(ga.matched, 3);
  assert.equal(ga.matchRate, 1);
  assert.equal(ga.arrivedWithMore, 0);
  assert.equal(ga.arrivedWithFewer, 0);
});

test('§XXXIV parking KPIs are empty for a Thuận Giao receptionist', async () => {
  const s = await scenario();
  assert.deepEqual(await s.dashboard.parkingTickets({ scopeOfficeId: OFFICE_TG }), []);
});

test('§XLIV byTimeSlot reports each of the four slots with its capacity', async () => {
  const s = await scenario();
  const rows = await s.dashboard.byTimeSlot({ dateFrom: '2026-10-05', dateTo: '2026-10-05' });
  assert.equal(rows.length, 4);
  rows.forEach((r) => assert.equal(r.capacity, 30, `${r.slotId} capacity is reported`));

  const a = rows.find((r) => r.slotId === SLOT_A);
  assert.equal(a.registrations, 2, 'r1 at CII and r5 at TG both use the 09:00 slot');
  assert.equal(a.people, 6);
  assert.equal(a.checkedIn, 2);
  const b = rows.find((r) => r.slotId === SLOT_B);
  assert.equal(b.registrations, 2, 'r2 (completed) and r4 (no-show) both sit at 13:00');
  assert.equal(b.noShow, 1);
  rows.forEach((r) => assert.equal('needsBusinessConfirmation' in r, false));
});

test('§XLIV the summary bundles every dashboard section', async () => {
  const s = await scenario();
  const sum = await s.dashboard.summary();
  assert.deepEqual(Object.keys(sum).sort(),
    ['byOffice', 'byTimeSlot', 'byVisitorType', 'funnel', 'guestAccuracy', 'kpis',
      'parkingTickets', 'periods']);
  assert.equal(sum.kpis.totalRegistration, 6);
});

test('§XXX an empty system reports zeros rather than failing', async () => {
  const clock = makeClock();
  const { services } = await buildApp({ clock });
  const k = await services.dashboard.kpis();
  assert.equal(k.totalRegistration, 0);
  assert.equal(k.checkedIn, 0);
  const [cii] = await services.dashboard.parkingTickets();
  assert.equal(cii.totalVisitors, 0);
  assert.equal(cii.issueRate, 0, 'no division by zero');
  assert.equal(cii.byVehicleType.CAR.issued, 0);
  assert.equal(cii.byVehicleType.MOTORBIKE.issued, 0);
  assert.equal((await services.dashboard.guestAccuracy()).matchRate, 0);
  (await services.dashboard.funnel()).stages.forEach((st) => assert.equal(st.count, 0));
});

// ===========================================================================
// §XXXV / §XXXVI — calendar
// ===========================================================================

test('§XXXV the day view returns only that day\'s registrations', async () => {
  const s = await scenario();
  const day = await s.calendar.events({ view: 'day', date: '2026-10-05' });
  assert.equal(day.from, '2026-10-05');
  assert.equal(day.to, '2026-10-05');
  assert.equal(day.count, 5);
  assert.ok(day.events.every((e) => e.date === '2026-10-05'));
});

test('§XXXV week and month views cover the right spans', async () => {
  const s = await scenario();
  const week = await s.calendar.events({ view: 'week', date: '2026-10-07' });
  assert.equal(week.from, '2026-10-05');
  assert.equal(week.to, '2026-10-11');
  assert.equal(week.count, 6, 'both days of the scenario fall in the same week');

  const month = await s.calendar.events({ view: 'month', date: '2026-10-20' });
  assert.equal(month.from, '2026-10-01');
  assert.equal(month.to, '2026-10-31');
  assert.equal(month.count, 6);

  const other = await s.calendar.events({ view: 'month', date: '2026-11-10' });
  assert.equal(other.count, 0, 'a month with no visits is empty, not an error');
});

test('§XXXVI each event links back to its registration and carries the display fields', async () => {
  const s = await scenario();
  const { events } = await s.calendar.events({ view: 'day', date: '2026-10-05' });
  const ev = events.find((e) => e.confirmationCode === s.regs.r1.confirmationCode);

  assert.equal(ev.registrationId, s.regs.r1.id, '§XXXV event references the Registration record');
  assert.equal(ev.timeLabel, '09:00 – 10:30');
  assert.equal(ev.startTime, '09:00');
  assert.equal(ev.title, 'Nguyễn Văn A');
  assert.equal(ev.subtitle, 'Khách Tham Quan');
  assert.equal(ev.salesOfficeName, 'CII - Bình Thạnh');
  assert.equal(ev.status, 'CHECKED_IN');
  assert.equal(ev.numberOfVisitors, 2);
});

test('§XXXVI an agency event shows the agency and its sales staff', async () => {
  const s = await scenario();
  const { events } = await s.calendar.events({ view: 'day', date: '2026-10-05', visitorType: 'AGENCY' });
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'IQI');
  assert.equal(events[0].subtitle, 'Sales: Nguyễn Văn B');
  assert.equal(events[0].visitorType, 'AGENCY');
  assert.equal(events[0].numberOfVisitors, 6);
});

test('§Rule 17 the calendar holds no data of its own — it is a projection', async () => {
  const s = await scenario();
  const tables = (await s.db.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()").all()).map((r) => r.name);
  assert.equal(tables.some((t) => /calendar|event/i.test(t)), false,
    'no calendar table exists, so no duplicate data can drift');

  // Changing the registration immediately changes the event.
  await s.registrations.changeStatus(s.regs.r3.id, 'CANCELLED');
  const ev = (await s.calendar.events({ view: 'day', date: '2026-10-05' }))
    .events.find((e) => e.registrationId === s.regs.r3.id);
  assert.equal(ev.status, 'CANCELLED');
});

test('§XXXV the calendar honours office, type and status filters', async () => {
  const s = await scenario();
  assert.equal((await s.calendar.events({ view: 'month', date: '2026-10-05', salesOfficeId: OFFICE_CII })).count, 4);
  assert.equal((await s.calendar.events({ view: 'month', date: '2026-10-05', salesOfficeId: OFFICE_TG })).count, 2);
  assert.equal((await s.calendar.events({ view: 'month', date: '2026-10-05', visitorType: 'VISITOR' })).count, 4);
  assert.equal((await s.calendar.events({ view: 'month', date: '2026-10-05', status: 'CHECKED_IN' })).count, 2);
  assert.equal((await s.calendar.events({ view: 'month', date: '2026-10-05', status: ['CANCELLED', 'NO_SHOW'] })).count, 2);
});

test('§XXV a receptionist scope limits the calendar to their office', async () => {
  const s = await scenario();
  const scoped = await s.calendar.events({ view: 'month', date: '2026-10-05', scopeOfficeId: OFFICE_TG });
  assert.equal(scoped.count, 2);
  assert.ok(scoped.events.every((e) => e.salesOfficeId === OFFICE_TG));
});

test('§XXXV events are ordered by date then by slot start time', async () => {
  const s = await scenario();
  const { events } = await s.calendar.events({ view: 'month', date: '2026-10-05' });
  const keys = events.map((e) => `${e.date} ${e.startTime}`);
  assert.deepEqual(keys, [...keys].sort(), 'chronological order');
});

test('§XXXV groupedByDate emits every day in range, including empty ones', async () => {
  const s = await scenario();
  const grouped = await s.calendar.groupedByDate({ view: 'week', date: '2026-10-05' });
  assert.equal(grouped.days.length, 7);
  assert.deepEqual(grouped.days.map((d) => d.date), [
    '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08',
    '2026-10-09', '2026-10-10', '2026-10-11',
  ]);
  assert.equal(grouped.days[0].events.length, 5);
  assert.equal(grouped.days[1].events.length, 1);
  assert.equal(grouped.days[2].events.length, 0, 'an empty day is still present in the grid');
});

test('§XXXV an unknown view or malformed date is rejected', async () => {
  const s = await scenario();
  await assert.rejects(async () => await s.calendar.events({ view: 'decade' }), (e) => e.code === 'INVALID_CALENDAR_VIEW');
  await assert.rejects(async () => await s.calendar.events({ view: 'day', date: '05/10/2026' }), (e) => e.code === 'INVALID_DATE');
});

test('§XXXV the calendar defaults to today when no date is given', async () => {
  const s = await scenario();
  const day = await s.calendar.events({ view: 'day' });
  assert.equal(day.from, '2026-10-05');
  assert.equal(day.count, 5);
});
