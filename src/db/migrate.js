'use strict';

const { randomUUID } = require('node:crypto');

/**
 * In-place upgrades for databases created by an earlier version.
 *
 * schema.sql uses CREATE TABLE IF NOT EXISTS, which creates missing tables but
 * never alters an existing one — so a database from a previous release keeps its
 * old columns and fails at query time with "column does not exist". Each step
 * below is idempotent and safe to run on a fresh database too.
 */

const columns = async (db, table) => (await db.prepare(
  'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?',
).all(table)).map((c) => c.column_name);

const tableExists = async (db, table) => Boolean(await db.prepare(
  'SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?',
).get(table));

async function migrate(db) {
  const applied = [];

  // --- §XXII: agencies gain a display order, so "Khác" can sit last ----------
  if (await tableExists(db, 'agencies') && !(await columns(db, 'agencies')).includes('sort_order')) {
    await db.exec('ALTER TABLE agencies ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    applied.push('agencies.sort_order');
  }

  // --- §XXVIII: check-ins record booked vs actual guest counts ---------------
  if (await tableExists(db, 'checkins')) {
    const cols = await columns(db, 'checkins');
    if (!cols.includes('expected_guests')) {
      await db.exec('ALTER TABLE checkins ADD COLUMN expected_guests INTEGER NOT NULL DEFAULT 0');
      applied.push('checkins.expected_guests');
    }
    if (!cols.includes('actual_guests')) {
      await db.exec('ALTER TABLE checkins ADD COLUMN actual_guests INTEGER NOT NULL DEFAULT 0');
      applied.push('checkins.actual_guests');
    }
    // Historic check-ins predate the count, so the booked number is the best
    // record we have of who turned up.
    const backfilled = await db.prepare(`
      UPDATE checkins
      SET expected_guests = r.number_of_visitors,
          actual_guests   = r.number_of_visitors
      FROM registrations r
      WHERE r.id = checkins.registration_id
        AND checkins.expected_guests = 0 AND checkins.actual_guests = 0`).run();
    if (backfilled.changes > 0) applied.push(`backfilled ${backfilled.changes} check-in(s)`);
  }

  // --- arrival timing and the slot a group was actually admitted into --------
  if (await tableExists(db, 'checkins')) {
    const cols = await columns(db, 'checkins');
    const add = async (name, ddl) => {
      if (cols.includes(name)) return false;
      await db.exec(`ALTER TABLE checkins ADD COLUMN ${ddl}`);
      applied.push(`checkins.${name}`);
      return true;
    };
    await add('arrival_status', 'arrival_status TEXT');
    await add('minutes_from_slot_start', 'minutes_from_slot_start INTEGER');
    await add('admitted_slot_id', 'admitted_slot_id TEXT REFERENCES time_slots(id)');
    await add('time_override', 'time_override INTEGER NOT NULL DEFAULT 0');
    if (await add('admitted_date', 'admitted_date TEXT')) {
      // Check-ins from before this existed were admitted into the slot and day
      // they had booked: that is all the old model could express.
      await db.exec(`
        UPDATE checkins
        SET admitted_slot_id = (SELECT t.id FROM time_slots t WHERE t.id = r.time_slot_id),
            admitted_date = r.visit_date
        FROM registrations r
        WHERE r.id = checkins.registration_id AND checkins.admitted_date IS NULL`);
    }
  }

  // --- account activity and the forced first-login password change -----------
  if (await tableExists(db, 'users')) {
    const cols = await columns(db, 'users');
    const add = async (name, ddl) => {
      if (cols.includes(name)) return false;
      await db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
      applied.push(`users.${name}`);
      return true;
    };
    await add('password_changed_at', 'password_changed_at TEXT');
    await add('last_login_at', 'last_login_at TEXT');
    await add('last_seen_at', 'last_seen_at TEXT');
    await add('login_count', 'login_count INTEGER NOT NULL DEFAULT 0');
    if (await add('must_change_password', 'must_change_password INTEGER NOT NULL DEFAULT 0')) {
      // Every account that exists at this point was given its password by
      // someone else, so each one changes it at its next sign-in. This runs only
      // in the release that adds the column — never again on a later start.
      const flagged = await db.prepare('UPDATE users SET must_change_password = 1').run();
      applied.push(`${flagged.changes} account(s) must change their password at next sign-in`);
    }
  }

  // --- §XXIX: single parking column → one row per ticket, typed by vehicle ---
  if (await tableExists(db, 'registrations') && await tableExists(db, 'parking_tickets')) {
    const regCols = await columns(db, 'registrations');
    if (regCols.includes('parking_ticket_issued')) {
      // Everything already issued was a car: that is all the old model recorded.
      const legacy = await db.prepare(`
        SELECT id, sales_office_id, parking_ticket_number, parking_ticket_issued_at,
               parking_ticket_returned_at, created_at
        FROM registrations
        WHERE parking_ticket_issued = 1
          AND id NOT IN (SELECT registration_id FROM parking_tickets)`).all();

      const insert = db.prepare(`
        INSERT INTO parking_tickets (id, registration_id, sales_office_id, vehicle_type,
                                     ticket_number, issued_at, issued_by, issued_by_name,
                                     returned_at, returned_by, returned_by_name)
        VALUES (?,?,?,'CAR',?,?,'MIGRATION','Migrated from previous version',?,?,?)`);

      for (const row of legacy) {
        // Sequential on purpose: a migration is a one-off, and ordering keeps the
        // failure point obvious if one row is bad.
        // eslint-disable-next-line no-await-in-loop
        await insert.run(randomUUID(), row.id, row.sales_office_id, row.parking_ticket_number,
          row.parking_ticket_issued_at || row.created_at,
          row.parking_ticket_returned_at,
          row.parking_ticket_returned_at ? 'MIGRATION' : null,
          row.parking_ticket_returned_at ? 'Migrated from previous version' : null);
      }
      if (legacy.length) applied.push(`moved ${legacy.length} parking ticket(s) to the new table`);
    }
  }

  return applied;
}

module.exports = { migrate };
