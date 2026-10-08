-- KINERA VISITOR REGISTRATION & RECEPTION MANAGEMENT SYSTEM
-- PostgreSQL. Runs on PGlite (embedded) locally and in the test suite, and on
-- a hosted PostgreSQL in deployment — the same SQL either way.

CREATE TABLE IF NOT EXISTS sales_offices (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  location                TEXT NOT NULL,
  address                 TEXT NOT NULL,
  opening_hours           TEXT NOT NULL,
  contact                 TEXT NOT NULL,
  parking_ticket_enabled  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS time_slots (
  id            TEXT PRIMARY KEY,
  start_time    TEXT NOT NULL,
  end_time      TEXT NOT NULL,
  label         TEXT NOT NULL,
  capacity      INTEGER NOT NULL,   -- §VIII max guests per slot, per office, per date
  active        INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agencies (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  -- Keeps "Khác" pinned below the named agencies; everything else sorts by name.
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,
  full_name       TEXT NOT NULL,
  role            TEXT NOT NULL,
  -- NULL office = not scoped to a single office (Manager / Administrator).
  sales_office_id TEXT REFERENCES sales_offices(id),
  password_hash   TEXT NOT NULL,
  password_salt   TEXT NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  -- A password somebody else chose (the administrator, or the seed) has to be
  -- replaced by its owner at the first sign-in; until then the API refuses
  -- everything except the change itself.
  must_change_password INTEGER NOT NULL DEFAULT 0,
  password_changed_at  TEXT,
  -- Account activity, for the administrator's account list.
  last_login_at   TEXT,
  last_seen_at    TEXT,
  login_count     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS registrations (
  id                        TEXT PRIMARY KEY,
  confirmation_code         TEXT NOT NULL UNIQUE,     -- §XVIII.2  OE-XXXXX
  qr_token                  TEXT NOT NULL UNIQUE,     -- §XVIII.3  opaque token only
  language                  TEXT NOT NULL,
  sales_office_id           TEXT NOT NULL REFERENCES sales_offices(id),
  visitor_type              TEXT NOT NULL,            -- VISITOR | AGENCY
  registration_date         TEXT NOT NULL,            -- date the record was created
  visit_date                TEXT NOT NULL,            -- YYYY-MM-DD
  time_slot_id              TEXT NOT NULL REFERENCES time_slots(id),
  number_of_visitors        INTEGER NOT NULL,
  notes                     TEXT,
  status                    TEXT NOT NULL,
  -- Who the visitor is to the company. Required on new registrations; rows that
  -- predate the field keep NULL, and nothing treats NULL as a rule.
  guest_category            TEXT,

  -- §XXI — Khách Tham Quan
  full_name                 TEXT,
  cccd                      TEXT,
  phone                     TEXT,
  email                     TEXT,

  -- §XXII — Đại Lý
  agency_id                 TEXT REFERENCES agencies(id),
  agency_name               TEXT,
  sales_staff_name          TEXT,
  sales_staff_cccd          TEXT,
  sales_staff_phone         TEXT,
  customer_short_name       TEXT,
  customer_phone_last4      TEXT,

  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reg_office_date ON registrations(sales_office_id, visit_date);
CREATE INDEX IF NOT EXISTS idx_reg_slot        ON registrations(sales_office_id, visit_date, time_slot_id);
CREATE INDEX IF NOT EXISTS idx_reg_status      ON registrations(status);
CREATE INDEX IF NOT EXISTS idx_reg_phone       ON registrations(phone);
CREATE INDEX IF NOT EXISTS idx_reg_cccd        ON registrations(cccd);

-- §XXIII — every status change is recorded with who and when.
-- `seq` is a generated surrogate key: two changes inside the same second (or the
-- same injected test clock tick) still have a deterministic total order.
CREATE TABLE IF NOT EXISTS status_history (
  seq             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id              TEXT NOT NULL UNIQUE,
  registration_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  changed_by      TEXT NOT NULL,   -- user id, or SYSTEM / VISITOR
  changed_by_name TEXT NOT NULL,
  changed_at      TEXT NOT NULL,
  note            TEXT
);

CREATE INDEX IF NOT EXISTS idx_history_reg ON status_history(registration_id, seq);

-- §XXVIII — check-in record
CREATE TABLE IF NOT EXISTS checkins (
  id               TEXT PRIMARY KEY,
  registration_id  TEXT NOT NULL UNIQUE REFERENCES registrations(id) ON DELETE CASCADE,
  receptionist_id  TEXT NOT NULL REFERENCES users(id),
  receptionist_name TEXT NOT NULL,
  sales_office_id  TEXT NOT NULL REFERENCES sales_offices(id),
  checkin_time     TEXT NOT NULL,
  checkin_method   TEXT NOT NULL,   -- QR | SEARCH
  -- §XXVIII — the receptionist confirms how many people actually turned up
  -- against how many were booked. Both are kept: the booking is history, the
  -- arrival is what happened.
  expected_guests  INTEGER NOT NULL,
  actual_guests    INTEGER NOT NULL,
  notes            TEXT,
  -- How the arrival compared with the booked slot (ON_TIME | LATE | EARLY |
  -- AFTER_SLOT | OTHER_DAY) and by how many minutes from the slot's start
  -- (negative = early; NULL when it was not the booked day).
  arrival_status          TEXT,
  minutes_from_slot_start INTEGER,
  -- The slot and day the group actually walked into. A group that turns up
  -- outside its own slot occupies the one that is running, and is counted
  -- against that slot's capacity — otherwise arriving late would be a way
  -- round the limit.
  admitted_slot_id TEXT REFERENCES time_slots(id),
  admitted_date    TEXT,
  time_override    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_checkin_office ON checkins(sales_office_id, checkin_time);

-- §XXIX — parking tickets, counted separately for cars and motorbikes.
-- A group can arrive in a car AND on motorbikes, so a registration may hold
-- several tickets; each one is its own row with its own vehicle type.
CREATE TABLE IF NOT EXISTS parking_tickets (
  id               TEXT PRIMARY KEY,
  registration_id  TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  sales_office_id  TEXT NOT NULL REFERENCES sales_offices(id),
  vehicle_type     TEXT NOT NULL,          -- CAR | MOTORBIKE
  ticket_number    TEXT,
  issued_at        TEXT NOT NULL,
  issued_by        TEXT NOT NULL,
  issued_by_name   TEXT NOT NULL,
  returned_at      TEXT,
  returned_by      TEXT,
  returned_by_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_parking_reg    ON parking_tickets(registration_id);
CREATE INDEX IF NOT EXISTS idx_parking_office ON parking_tickets(sales_office_id, vehicle_type);

-- An administrator closes the show house for a day, a stretch of days, or a
-- single time slot — a public holiday, maintenance, a private event.
--
-- `sales_office_id` NULL means every office; `time_slot_id` NULL means the whole
-- day. The range is inclusive at both ends, and a single day is simply a range
-- where both ends are equal, so one shape covers every case the desk asks for.
CREATE TABLE IF NOT EXISTS blocked_periods (
  id              TEXT PRIMARY KEY,
  sales_office_id TEXT REFERENCES sales_offices(id),
  time_slot_id    TEXT REFERENCES time_slots(id),
  start_date      TEXT NOT NULL,          -- YYYY-MM-DD, inclusive
  end_date        TEXT NOT NULL,          -- YYYY-MM-DD, inclusive
  reason          TEXT,
  created_by      TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blocked_dates  ON blocked_periods(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_blocked_office ON blocked_periods(sales_office_id);

-- Every administrative write, kept so a change can be traced back to a person.
--
-- Registrations already carry their own status_history (§XXIII); this covers the
-- things that history cannot see — accounts created or deleted, passwords reset,
-- capacity changed, periods closed. `details` holds a small JSON object with the
-- before/after of whatever changed, so the row explains itself years later.
CREATE TABLE IF NOT EXISTS audit_log (
  -- Several actions can land in the same millisecond, and a timestamp alone
  -- would then order them arbitrarily — the same trap status_history avoids.
  seq         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id          TEXT NOT NULL UNIQUE,
  at          TEXT NOT NULL,          -- ISO timestamp
  actor_id    TEXT NOT NULL,
  actor_name  TEXT NOT NULL,
  actor_role  TEXT NOT NULL,
  action      TEXT NOT NULL,          -- USER_CREATED, SLOT_CAPACITY_CHANGED, …
  entity      TEXT NOT NULL,          -- USER | TIME_SLOT | AGENCY | BLOCKED_PERIOD
  entity_id   TEXT,
  summary     TEXT NOT NULL,          -- one readable line
  details     TEXT                    -- JSON, or NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_seq    ON audit_log(seq DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
