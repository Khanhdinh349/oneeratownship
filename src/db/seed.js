'use strict';

const { randomUUID } = require('node:crypto');
const {
  SALES_OFFICES, TIME_SLOTS, AGENCY_SEED, RETIRED_AGENCY_IDS, ROLES,
} = require('../config/master-data');
const { hashPassword } = require('../domain/passwords');

/**
 * Seeds master data (§XXIV — each Sales Office has its own Receptionist accounts).
 * Idempotent: safe to call on an existing database.
 */
async function seed(db, { now = new Date().toISOString() } = {}) {
  const insOffice = db.prepare(`
    INSERT INTO sales_offices (id, name, location, address, opening_hours, contact, parking_ticket_enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, location = excluded.location, address = excluded.address,
      opening_hours = excluded.opening_hours, contact = excluded.contact,
      parking_ticket_enabled = excluded.parking_ticket_enabled`);

  for (const o of SALES_OFFICES) {
    // Sequential: seeding is a one-off at startup, and in order the failing row is
    // obvious if one of them is malformed.
    // eslint-disable-next-line no-await-in-loop
    await insOffice.run(o.id, o.name, o.location, o.address, o.openingHours, o.contact,
      o.parkingTicketEnabled ? 1 : 0);
  }

  const insSlot = db.prepare(`
    INSERT INTO time_slots (id, start_time, end_time, label, capacity, active, sort_order)
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET
      start_time = excluded.start_time, end_time = excluded.end_time, label = excluded.label,
      capacity = excluded.capacity, sort_order = excluded.sort_order`);

  for (const [i, s] of TIME_SLOTS.entries()) {
    // eslint-disable-next-line no-await-in-loop
    await insSlot.run(s.id, s.startTime, s.endTime, s.label, s.capacity, i);
  }

  const insAgency = db.prepare(
    `INSERT INTO agencies (id, name, active, sort_order) VALUES (?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                                   active = 1,
                                   sort_order = excluded.sort_order`);
  for (const a of AGENCY_SEED) await insAgency.run(a.id, a.name, a.sortOrder ?? 0);

  // Placeholders from before the real list: switched off, never deleted, because
  // registrations created against them still hold the foreign key.
  const retire = db.prepare('UPDATE agencies SET active = 0 WHERE id = ?');
  for (const id of RETIRED_AGENCY_IDS) await retire.run(id);

  // --- Staff accounts -------------------------------------------------------
  //
  // The passwords below are development defaults and are published in the README,
  // so a deployment anyone can reach must not use them. Each role reads an
  // environment variable first, which is how the demo gets its own credentials
  // without a code change. Existing accounts keep their password: the insert ends
  // in DO NOTHING, so changing these never silently resets a live account.
  const seedPassword = (name, fallback) => process.env[`KINERA_SEED_${name}_PASSWORD`] || fallback;
  const RECEPTION_PASSWORD = seedPassword('RECEPTION', 'Reception@123');
  const SALES_PASSWORD = seedPassword('SALES', 'Sales@123');
  const MANAGER_PASSWORD = seedPassword('MANAGER', 'Manager@123');
  const ADMIN_PASSWORD = seedPassword('ADMIN', 'Admin@123');

  const accounts = [];
  for (const office of SALES_OFFICES) {
    const prefix = office.id === 'CII_BINH_THANH' ? 'cii' : 'tg';
    for (let n = 1; n <= 3; n += 1) {
      accounts.push({
        username: `${prefix}.reception${String(n).padStart(2, '0')}`,
        fullName: `${office.name} — Receptionist ${String(n).padStart(2, '0')}`,
        role: ROLES.RECEPTIONIST,
        officeId: office.id,
        password: RECEPTION_PASSWORD,
      });
    }
    accounts.push({
      username: `${prefix}.sales01`,
      fullName: `${office.name} — Sales 01`,
      role: ROLES.SALES,
      officeId: office.id,
      password: SALES_PASSWORD,
    });
  }
  accounts.push({
    username: 'manager01', fullName: 'Kinera Manager', role: ROLES.MANAGER,
    officeId: null, password: MANAGER_PASSWORD,
  });
  accounts.push({
    username: 'admin', fullName: 'System Administrator', role: ROLES.ADMINISTRATOR,
    officeId: null, password: ADMIN_PASSWORD,
  });

  // Seeded passwords are handed out by whoever set the system up, so every
  // seeded account replaces its own at the first sign-in. The switch exists for
  // the test suite, which signs in hundreds of times and is not testing this.
  const mustChange = process.env.KINERA_SEED_REQUIRE_PASSWORD_CHANGE === '0' ? 0 : 1;

  const insUser = db.prepare(`
    INSERT INTO users (id, username, full_name, role, sales_office_id, password_hash, password_salt,
                       active, created_at, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(username) DO NOTHING`);

  for (const a of accounts) {
    const { hash, salt } = hashPassword(a.password);
    // eslint-disable-next-line no-await-in-loop
    await insUser.run(randomUUID(), a.username, a.fullName, a.role, a.officeId, hash, salt, now, mustChange);
  }

  return { accounts: accounts.map(({ password, ...rest }) => rest) };
}

module.exports = { seed };
