# ONE ERA / KINERA — Visitor Registration & Reception Management

Full implementation of the KINERA registration specification: the visitor-facing
registration wizard, the receptionist check-in desk, parking-ticket tracking,
the management dashboard and the calendar — all reading from one Registration
record, with every business rule enforced on the backend.

The interface follows the existing ONE ERA site: the same brand palette
(sky `#5DA9DD`, sunset `#F79552`, lavender `#B3ABC4` on slate `#0F172A`), Inter
400–900, glass panels over the ONE ERA backdrop, pill buttons and uppercase
micro-labels. The visitor wizard and the staff sign-in sit on the brand photo;
the staff app itself uses the same tokens on flat slate, because dense tables
and a photographic backdrop do not mix.

## Running it

```bash
npm install
npm start        # http://localhost:3000
npm test         # 252 tests
```

* Visitor registration — `http://localhost:3000/`
* Staff area — `http://localhost:3000/staff.html`

The dev server keeps its data in `data/kinera.sqlite` (created on first run).
Set `KINERA_DB` to move it, `PORT` to change the port, and `KINERA_SECRET` /
`KINERA_QR_SECRET` / `KINERA_PUBLIC_URL` before any real deployment.

### Seeded accounts

| Username | Password | Role | Office |
| --- | --- | --- | --- |
| `cii.reception01` … `03` | `Reception@123` | Receptionist | CII - Bình Thạnh |
| `tg.reception01` … `03` | `Reception@123` | Receptionist | Thuận Giao - Bình Dương |
| `cii.sales01`, `tg.sales01` | `Sales@123` | Sales | respective office |
| `manager01` | `Manager@123` | Manager | all offices |
| `admin` | `Admin@123` | Administrator | all offices |

## Architecture

```
src/
  config/master-data.js      offices, time slots, languages, roles, constants
  db/schema.sql, seed.js     SQLite schema + idempotent master-data seed
  domain/                    pure business logic, no I/O
    dates.js                 the 10-day booking window
    codes.js                 OE-XXXXX confirmation codes, signed QR tokens
    status.js                status lifecycle and legal transitions
    validation.js            field validation for both visitor types
    permissions.js           the §XXXIX role matrix and office scoping
  services/                  orchestration over the database
    registration, checkin, dashboard, calendar, masterdata, auth
  app.js                     REST API, authentication, error shaping
public/                      registration wizard + staff area (no build step)
tests/                       252 tests
```

**One source of truth.** The dashboard and the calendar are queries over
`registrations` and `checkins`. There is no calendar table and no precomputed
dashboard — a test asserts the schema contains neither, so the duplication
§Rule 17 forbids cannot creep in.

**Backend-authoritative.** The UI disables out-of-range dates and full slots, but
every rule is re-checked server-side: the booking window, slot availability,
office scoping, status transitions and check-in eligibility. The frontend can be
bypassed entirely and no rule gives way.

**QR carries no personal data.** The QR encodes `…/checkin?t=<token>`, where the
token is 16 random bytes plus an HMAC. Forged tokens are rejected before any
database lookup, and the token never appears in any staff listing or read model.

## Registration flow

Registration is **one page**, laid out like the existing ONE ERA pages.

Language, sales office and role share a single row at the top. Choosing a role
reveals that role's own form directly beneath it:

* **Khách Tham Quan** → *Đăng ký trải nghiệm* — full name, CCCD, phone, email,
  two fields to a row
* **Đại Lý** → *Đăng ký tiếp đón đại lý* — searchable agency picker, then the
  sales-staff block and the customer block, each with its own sub-heading

Guests, visit date and time slot sit together in one recessed panel, and a
full-width sunset button confirms. There are no numbered step sections and no
review screen — every field is visible at once, so the confirm button registers
and the confirmation (§XIX) opens as a dialog over the page.

The date input is clamped to the booking window and each slot option carries its
remaining places — a slot that is full, or that cannot fit the party size entered,
cannot be selected. Switching role swaps the form in place and keeps everything
already typed (§Rule 2).

## Time slots

Four booking windows, **30 guests each**, counted per office and per date:

| Slot | Window | Capacity |
| --- | --- | --- |
| `SLOT_0900_1030` | 09:00 – 10:30 | 30 |
| `SLOT_1030_1200` | 10:30 – 12:00 | 30 |
| `SLOT_1300_1430` | 13:00 – 14:30 | 30 |
| `SLOT_1430_1600` | 14:30 – 16:00 | 30 |

Each slot option shows **how many places are left** for the chosen office and date,
e.g. *09:00 – 10:30 — Còn 24 chỗ*. The number of people who have already registered
is deliberately not shown anywhere on the visitor-facing page — only availability is. Remaining is derived from real registrations, never cached;
cancellations and no-shows release their seats. A slot that is full, or that
cannot fit the party size entered, is shown as **Đã hết chỗ / Fully Booked** and
cannot be selected — and the backend refuses it too, so the UI cannot be bypassed.

Staff still see the full picture: the dashboard's per-slot table reports capacity,
registrations, people, checked-in and no-show counts.

The earlier §XLVII question (09:00 – 10:30 appearing twice in the source
requirement) has been settled: there is one 09:00 slot, and the
"pending business confirmation" message has been removed throughout.

## Assumptions (flagged, per §Rule 12)

| # | Assumption | Why |
| --- | --- | --- |
| A1 | Email is **optional**, validated when supplied | §VI marks name, CCCD, phone and visitor count "Required."; for email it says only "Có validation email." |
| A2 | Max **20** visitors per registration | §VI.5 forbids 0 but sets no ceiling; one is needed for slot capacity to mean anything. |
| A3 | CCCD accepts 12 digits, or 9 for legacy IDs | Covers both Vietnamese ID generations. |
| A4 | Slot capacity counts **people**, 30 per slot | The real constraint is show-house occupancy. Capacity is per office + date + slot and is editable by an Administrator. |
| A5 | Cancelled and no-show bookings release their seats | Otherwise a day of cancellations would permanently block a slot. |
| A6 | A wrong-day check-in is refused but **overridable** by the receptionist, and the override is recorded | §XXVIII.3 requires date validation; refusing outright would strand an early or late visitor. |
| A7 | Duplicate = same CCCD (or same sales staff + customer) with a live booking for the same office, date and slot | §Rule 11 forbids duplicates without defining the key. |
| A8 | A **customer identity** for statistics is the visitor's CCCD (falling back to phone), or, for an agency booking, the agency plus the customer short name and last four phone digits | There is no Customer table (§Rule 11 discourages one), so the identity is derived from the fields the form actually captures. "Unique customers" therefore means distinct identities as recorded. |
| A10 | **Capacity counts the people who actually arrive.** Once a group has checked in, the number the receptionist counted replaces the number booked; a group admitted outside its own slot (early, late, another day) is counted in the slot it walked into | A booking for 2 that turns up as 9 would otherwise put 37 people in a 30-guest slot. In its own slot a group may always bring the number it booked; beyond that, and in any other slot, it needs free places. There is no override for a full slot. |
| A11 | A slot is bookable **until it ends**, and is greyed out afterwards. On-time means from 15 minutes before the slot starts to 15 minutes after; later than that, inside the slot, is *late* and needs no confirmation. Earlier than the grace, or after the slot has ended, the desk must confirm the check-in | "Once a time slot has passed" is read as *has ended*, so a walk-in can still be registered into the slot in progress. The 15-minute graces are `EARLY_GRACE_MINUTES` / `LATE_GRACE_MINUTES` in `src/config/master-data.js`. |
| A12 | "Today" and every time-of-day rule use **Vietnam time (UTC+7)**, whatever timezone the server runs in | Vercel runs in UTC; before this, "today" between midnight and 07:00 was yesterday's date. |
| A13 | The 30-guest limit is a **ceiling**: an administrator can lower a slot's capacity, not raise it above 30 | The limit was stated as a maximum. Change `SLOT_CAPACITY` to move it. |
| A14 | Every account whose password was chosen by someone else — created or reset by an administrator, or seeded — must change it at the first sign-in, and the API refuses everything else until it does | Enforced in the authentication middleware for every route, not only on the sign-in screen. |
| A15 | **Guest category** is required on every new registration, and is one of four values the business supplied: Khách của HĐQT, Đối tác của Sales, Khách hàng, Đối tác khác | The values are the company's own, not inferred. Registrations taken before the field existed keep NULL — they cannot be classified after the fact, and guessing would invent data. The category drives no workflow; it is recorded for reception and for reporting. |
| A16 | A parking-ticket action issues a **quantity** of tickets (default 1, ceiling 20). When ticket numbers are given there must be exactly one per ticket | A group arriving on eight motorbikes is one action, not eight. Padding or truncating a short list is what made the register disagree with the drawer, so a mismatch is refused instead. The whole batch is written in one transaction. |
| A17 | Reception may correct a check-in afterwards — **arrival count, admitted slot, agency sales staff** — and nothing else. Every correction is written to the status history with who made it | The desk notices its own mistakes, usually within minutes. The corrected count is re-checked against the slot's real free places, so a correction cannot be used to get round capacity. Sales cannot correct a check-in. |
| A18 | Reception can register a **walk-in at the desk** and check them in in the same action | Same endpoint, same validation as the public form; only today's date, the receptionist's own office and the running slot are filled in for them. The "check in immediately" box can be unticked when registering at the desk for a later slot. |
| A9 | Exporting the registration list is open to everyone who can read it; **customer statistics are Manager and Administrator only** | The list export holds exactly the rows and columns already on screen. The statistics screen is management information — §XXXIX gives the whole data set to Manager and Administrator, and pins the desk roles to their own office and day. |

## Status lifecycle (§XXIII)

```
REGISTERED → CONFIRMED → EXPECTED → CHECKED_IN → IN_VISIT → COMPLETED
     └──────────┴───────────┴──→ CANCELLED / NO_SHOW
```

Terminal statuses accept no further transition. Every change records the new
status, a timestamp and who made it; the history is ordered by an autoincrement
sequence, so two changes in the same second still have a deterministic order.

## Dashboard definitions

* **Expected** — everyone due at an office, i.e. every registration except a
  cancellation. This makes §XXXIII's illustration balance exactly:
  Expected 50 = Checked In 42 + No Show 8.
* **Pending** — due to arrive and not yet resolved.
* **Checked-in** — has arrived (`CHECKED_IN`, `IN_VISIT` or `COMPLETED`).
* **Funnel stages** — cumulative by current status, so each stage counts
  everything at that stage or beyond and the funnel never increases downward.

## Capacity, slot timing and arrivals

* **The limit.** Thirty guests per office, per day, per slot. Occupancy is the
  number *counted at the desk* for groups that have arrived and the number booked
  for those that have not — see `RegistrationService.occupancy()`.
* **At the desk.** The check-in card shows how many people the group may bring
  ("đoàn này được vào tối đa N người") before anyone presses CHECK IN. Asking for
  more returns `SLOT_CAPACITY_EXCEEDED`, with no override; the extra guests book
  another slot.
* **Finished slots.** `/api/availability` marks each slot `passed`; the form greys
  it out ("Đã qua giờ") and `POST /api/registrations` answers `TIME_SLOT_PASSED`.
* **Early and late.** Every check-in records `arrivalStatus` (`ON_TIME`, `LATE`,
  `EARLY`, `AFTER_SLOT`, `OTHER_DAY`), the minutes from the slot's start, the slot
  and day the group was actually admitted into, and whether the receptionist had
  to confirm it. Outside its own slot a group is counted against the slot that is
  running, so arriving late is not a way round the limit either.

## Account activity and first sign-in

The administrator's account list shows, per account: online / seen today / seen
in the last seven days / dormant / never signed in, the last sign-in, the number
of sign-ins, and whether the account still owes a password change. "Last seen" is
written at most once a minute per account.

An account created or reset by an administrator signs in, is shown a
change-password form, and can do nothing else until it has chosen its own
password — the API returns `PASSWORD_CHANGE_REQUIRED` for every other route.
Seeded accounts behave the same way; a database upgraded from an earlier release
flags every existing account once, at the upgrade.

## Customer statistics (Manager)

A separate screen from the operational Dashboard, answering "who are our
customers" rather than "what is happening today": new versus returning, visits
per customer, average party size, how far ahead people book, show-up rate, the
split between direct visitors and agency-introduced customers, a ranking per
agency and per agency sales staff, the slots and weekdays customers choose, the
distribution of party sizes and a day-by-day trend.

* **Returning** is judged against the customer's whole history, not just the
  filtered window — someone who came in May and again in June reads as returning
  in a June-only report.
* **Customer identity** is derived (assumption A8 above); the derivation lives in
  one place, `src/services/customer-stats.service.js`.
* Every block respects the same filters, and office scoping (§XXV) is taken from
  the session so a query parameter can narrow the view but never widen it.

## Excel export

Two reports, both `.xlsx`, written by `src/export/xlsx.js` — a small
dependency-free OOXML writer, so the public deployment carries no spreadsheet
library.

| Report | Where | Contents |
| --- | --- | --- |
| Registration list | the **Đăng ký** screen | every row matching the filters on screen (not just the page), one sheet of data plus a `Bộ lọc` sheet recording the filters, who exported it and when |
| Customer statistics | the **Thống kê khách** screen | one sheet per block of the screen, so each can be pivoted or charted on its own |

Both are downloaded through the authenticated API — the bearer token is sent as a
header and the file arrives as a blob, so no token ever appears in a URL, in
browser history or in a proxy log. Timestamps are written in Vietnam time
(UTC+7) whatever timezone the server runs in, and visit dates are written as
calendar days that cannot drift across a date boundary. An export is capped at
20,000 rows; a truncated file says so on its `Bộ lọc` sheet rather than quietly
looking complete.

## API

| Method | Path | Who |
| --- | --- | --- |
| `GET` | `/api/config` | public — master data, rules, open business questions |
| `GET` | `/api/availability` | public — slot availability for an office + date |
| `POST` | `/api/registrations` | public (or Sales) — create a registration |
| `GET` | `/api/registrations/:code/qr.png` | public, requires the matching token |
| `GET` | `/api/registrations/lookup` | public, requires code **and** token |
| `POST` | `/api/auth/login` · `GET /api/auth/me` | staff |
| `GET` | `/api/staff/registrations` · `/:id` | Receptionist, Sales, Manager, Admin |
| `GET` | `/api/staff/registrations/export.xlsx` | Receptionist, Sales, Manager, Admin — same filters, same office scope |
| `POST` | `/api/staff/checkin/scan` · `/resolve` | Receptionist, Admin |
| `POST` | `/api/staff/registrations/:id/checkin` | Receptionist, Admin |
| `POST` | `/api/staff/registrations/:id/status` | Receptionist, Admin |
| `POST` | `/api/staff/registrations/:id/parking-ticket` | Receptionist, Admin — CII only |
| `GET` | `/api/staff/dashboard` | Manager, Admin |
| `GET` | `/api/staff/customer-stats` · `/export.xlsx` | **Manager, Admin only** |
| `GET` | `/api/staff/office-summary` | any staff — scoped to their desk |
| `GET` | `/api/staff/calendar` | Receptionist, Sales, Manager, Admin |
| `GET`/`POST` | `/api/admin/users` · `/api/admin/agencies` · `PATCH /api/admin/time-slots/:id` | Administrator |

Errors are always `{ "error": { "code", "message", "details? } }`. Field-level
validation failures come back as `VALIDATION_FAILED` with one entry per field,
which the wizard renders against the exact input and the step that owns it.

## Deploying publicly

The app runs two ways from one codebase: as a long-lived process (`npm start`, which
is what a VPS or a container would use) and as a Vercel serverless function
(`api/index.js`). Both build the same Express app; only the database differs.

### Environment

**The app refuses to start with `NODE_ENV=production` unless the first three are
set**, because the development defaults are in this repository and would let anyone
forge a session token or a QR token:

| Variable | Purpose |
| --- | --- |
| `KINERA_SECRET` | Signs staff session tokens. Long and random. |
| `KINERA_QR_SECRET` | Signs QR tokens. Different from the above. |
| `KINERA_PUBLIC_URL` | The real origin, e.g. `https://dangky.oneera.vn`. It is what the QR encodes, so it must be right before the first registration is made. |
| `KINERA_DB_URL` | PostgreSQL connection string. Without it the app falls back to an embedded PGlite database in `data/`, which is the zero-setup local default and **not** suitable for a deployment. |
| `KINERA_TRUST_PROXY` | `true` behind a reverse proxy or on Vercel, so client IPs are real and the rate limiter works per visitor. |
| `KINERA_SEED_*_PASSWORD` | `RECEPTION`, `SALES`, `MANAGER`, `ADMIN` — the passwords `scripts/setup-database.js` gives the seeded accounts. Set these for any deployment: the defaults are published below. |
| `PORT` / `HOST` | Defaults 3000 / 0.0.0.0. Not used on Vercel. |

Generate the secrets with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

### Preparing the database

Once, before the first deploy — not on every start:

```sh
KINERA_DB_URL='postgresql://…' \
KINERA_SEED_RECEPTION_PASSWORD='…' KINERA_SEED_SALES_PASSWORD='…' \
KINERA_SEED_MANAGER_PASSWORD='…'   KINERA_SEED_ADMIN_PASSWORD='…' \
npm run setup-db
```

It applies the schema, runs the migrations and seeds the master data and staff
accounts, and is safe to run again: the schema uses `CREATE TABLE IF NOT EXISTS`,
the migrations are idempotent, and an account that already exists keeps its
password. The serverless entry point deliberately does **not** seed — hashing ten
passwords with scrypt on every cold start would make the first request after an
idle period take seconds.

### On Vercel

`vercel.json` serves `public/` from the CDN and routes `/api/*` to the one
function. Point the function's region at the database's region (`sin1` for a
Supabase project in Singapore): the app makes several queries per request, and a
cross-ocean round trip for each is the difference between a snappy demo and a
sluggish one.

Use a **connection pooler** (Supabase's transaction pooler on port 6543), never the
direct database port. Each warm function instance holds its own small pool, and
without a pooler a burst of cold starts exhausts PostgreSQL's connection limit.
The app builds its app object once per instance, not once per request, for the
same reason.

### Already handled in the code

* **Security headers** on every response — a CSP with no `unsafe-inline` for scripts
  and no `unsafe-eval`, `frame-ancestors 'none'`, `nosniff`, a referrer policy, and
  HSTS once in production. All application JavaScript is external, so the strict CSP holds.
* **Rate limiting** on the two endpoints the public can reach: sign-in (10 per 15 min
  per IP + username, reset by a success so one fumbled password can't lock the desk out
  for the shift) and registration (20 per hour per IP).
* **Graceful shutdown** on SIGTERM/SIGINT — stops accepting, drains in-flight requests,
  then closes the connection pool so connections are returned rather than dropped.
* **No CSRF surface** — the API authenticates with a bearer token from `sessionStorage`,
  never a cookie, so a cross-site form post carries no credentials.
* **Errors do not leak internals** — unexpected failures return a generic message;
  stack traces go to stderr only.

### Still yours to do before a real launch

1. **Change every seeded password.** `Reception@123`, `Sales@123`, `Manager@123` and
   `Admin@123` are in this README. Set `KINERA_SEED_*_PASSWORD` before preparing the
   database, or sign in as `admin` and recreate the accounts.
2. **Point `KINERA_PUBLIC_URL` at the real domain before the first registration.**
   The QR encodes it, so codes issued under a temporary URL stop resolving when the
   domain changes.
3. **Back up the database.** Supabase takes daily backups on paid plans; on the free
   tier, export it yourself.
4. **Rate limiting is per instance.** The counters live in each function instance's
   memory, so several warm instances each enforce their own share. For a real launch,
   enforce it at the edge (Vercel Firewall or Cloudflare) instead.
5. **Decide how long registrations are kept.** Nothing expires today; visitor CCCD and
   phone numbers accumulate indefinitely, which is a data-protection question, not a
   technical one.

## Guidelines on screen

Both audiences get the procedure where they are, rather than in a document nobody
opens.

* **Visitors** — a **Hướng dẫn / How it works** button under the title on the
  registration page opens the five steps, in whichever language is selected. The
  booking window and the slot capacity are read from `/api/config` rather than
  written into the text, so the guidance cannot drift away from the rules the
  backend enforces.
* **Staff** — a **Hướng dẫn** tab, visible to every signed-in role, holds the floor
  procedure for all four roles: reception check-in, Sales booking on a customer's
  behalf, what a manager watches, and administration. The section matching the
  signed-in role is marked, and the rest stay visible — the desk sometimes needs to
  know what the manager sees, and the manager needs to know what the desk was told.
  "In hướng dẫn" prints it.

## Tests

491 tests across twelve files, run with `npm test`:

| File | Covers |
| --- | --- |
| `unit.domain.test.js` | booking window, code and token generation, lifecycle, field validation, permissions |
| `service.registration.test.js` | creation, availability, duplicates, lookup, list/search/sort/paging, parking ticket |
| `service.checkin.test.js` | the four check-in validations, readiness states, authentication |
| `service.dashboard-calendar.test.js` | every KPI, funnel, breakdown and calendar view |
| `api.test.js` | the whole system over HTTP, including permission boundaries |
| `ui.contract.test.js` | translation parity, wizard lifecycle, UI states, calendar navigation and popover, output escaping |
| `integrity.test.js` | schema, constraints, transaction rollback, capacity under load, rule coverage |
| `security.test.js` | production secret checks, security headers, rate limiting, error-leak safety, database portability and migration |
| `admin.test.js` | the Administrator role, account management, blocked periods, slot capacity, the audit log |
| `capacity-timing.test.js` | the business clock, the 30-guest limit against real arrivals, finished slots, early / late / other-day check-ins, actual attendance in reports, account activity, the forced password change |
| `desk-operations.test.js` | parking tickets issued by quantity (batch atomicity, number/quantity mismatch, re-issue after return), correcting a check-in, walk-in registration, the guest category |
| `export.customer-stats.test.js` | the .xlsx writer (ZIP structure, escaping, timezone handling, sheet naming), both reports, every customer statistic against hand-checked numbers, and the Manager-only boundary |

The suite pins a fake clock (`2026-10-01`), so date-dependent rules are
deterministic. `tests/integrity.test.js` also asserts that each of the eighteen
numbered rules in §XLVI has at least one covering test.

The UI was additionally driven end to end in a real Chromium browser: both
languages, both visitor types, validation states, the QR on the success page,
reception check-in, parking ticket, dashboard, all three calendar views, the
prev/next/today navigation and the in-place event popover — and, for this
release, the statistics screen, both export buttons and the files they actually
download. Generated workbooks are verified a second time with `openpyxl`, an
independent reader, so "valid .xlsx" is not just this code agreeing with itself.

## Reception check-in (§XXVIII)

Before anyone is checked in, the desk confirms **how many guests actually arrived**.
The count is pre-filled with the booked number, so the usual case is one glance and
one click; − / + adjust it. A match is confirmed in green, a difference is flagged
with the variance.

Both numbers are stored on the check-in — `expected_guests` and `actual_guests` —
and the booking itself is never rewritten, so the record shows what was booked *and*
what turned up. The status history carries the same ("3/4 guests (-1)"), and the
dashboard reports the totals, the variance and the match rate, so a persistent gap
between booked and actual is visible rather than silently distorting capacity.

Guard rails: at least one guest must have arrived (nobody turning up is a no-show,
not a check-in), the count must be a whole number, and more than ten above the
booking is refused as a likely typo.

## Parking tickets (§XXIX)

Tickets are tracked **separately for cars and motorbikes**, at CII - Bình Thạnh only.
A registration can hold several — a party of six may arrive in one car and on two
motorbikes — so each ticket is its own record with its own vehicle type, optional
ticket number, who issued it and who took it back.

The desk gets one counter per vehicle type with a **quantity box**, an optional
ticket-number box and an issue button, plus a list of every ticket showing which are
still out. Entering a quantity hands out that many tickets in one action and says how
many were issued; ticket numbers are typed as a comma-separated list and there must be
exactly one per ticket, so what the desk typed and what the register holds cannot
drift apart. A batch is written in a single transaction — a clash on the fifth number
leaves none of the first four behind. The same physical ticket
number cannot be issued twice while it is out, though cars and motorbikes have separate
number series. The dashboard splits issued / returned / still-held by vehicle type, and
the registration list can be filtered by vehicle type or by whether a ticket is still out.

## Reception search (§XXVI Option 2)

The desk has **one search box**. Whatever the receptionist scans or types is sent
as a single query and the backend decides what it is:

| Input | Resolved as |
| --- | --- |
| A scanned QR payload, or a bare token | QR check-in |
| `OE-XXXXX` | Confirmation code |
| Anything else | Visitor name, phone, CCCD, agency, sales staff, customer short name, or the customer's last four digits |

One match opens the visitor straight away; several open a pick-list showing date,
slot, office, code and status; none says so plainly and names what can be searched.
Every path is office-scoped, so a receptionist never sees another office's visitor —
not even by pasting its confirmation code.

## Calendar

Day, week and month views with **prev / today / next** navigation (arrow keys
work too). Each view steps by its own period, and the header names the period on
screen. Clicking any event opens an **information window right at the event** —
anchored to what was clicked, flipping above when there is no room below, kept
inside the calendar body, and dismissed by its ×, a click away, or Escape. It
shows the slot, date, visitor type, party size, office and status immediately,
then fills in contact, check-in and notes; a button opens the full registration
for anyone who needs it. The calendar remains a projection over `registrations`,
so nothing is duplicated.
