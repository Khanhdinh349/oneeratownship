'use strict';

const path = require('node:path');
const express = require('express');
const QRCode = require('qrcode');

const { openDatabase } = require('./db');
const { seed } = require('./db/seed');
const { MasterDataService } = require('./services/masterdata.service');
const { RegistrationService } = require('./services/registration.service');
const { CheckinService } = require('./services/checkin.service');
const { ParkingService } = require('./services/parking.service');
const { DashboardService } = require('./services/dashboard.service');
const { CalendarService } = require('./services/calendar.service');
const { AuthService } = require('./services/auth.service');
const { AppError, badRequest, notFound } = require('./domain/errors');
const { securityHeaders, rateLimit } = require('./middleware/security');
const { P, assertCan, scopeOfficeFor, can } = require('./domain/permissions');
const { STATUS, ALL_STATUSES } = require('./domain/status');
const { selectableDates, toDateString } = require('./domain/dates');
const { qrPayload } = require('./domain/codes');
const { stripSecrets } = require('./services/mappers');
const { CustomerStatsService } = require('./services/customer-stats.service');
const { ScheduleBlockService } = require('./services/schedule-block.service');
const { AuditService } = require('./services/audit.service');
const {
  buildRegistrationWorkbook, buildCustomerStatsWorkbook, reportFilename,
} = require('./export/reports');
const {
  LANGUAGES, VISITOR_TYPES, ROLES, MAX_ADVANCE_DAYS, AUTO_REFRESH_MS, CHECKIN_METHODS,
  SLOT_CAPACITY, VEHICLE_TYPES, MAX_GUEST_OVERAGE, EARLY_GRACE_MINUTES, LATE_GRACE_MINUTES,
} = require('./config/master-data');
const { MAX_VISITORS_PER_REGISTRATION } = require('./domain/validation');

/**
 * Builds the application. Everything is injectable so tests can pin the clock
 * and use an in-memory database.
 */
const DEV_SECRET = 'kinera-dev-secret-change-me';
const DEV_QR_SECRET = 'kinera-dev-qr-secret-change-me';
const DEV_PUBLIC_URL = 'https://register.kinera.local';

async function createApp({
  dbLocation = ':memory:',
  clock = () => new Date(),
  secret = process.env.KINERA_SECRET || DEV_SECRET,
  qrSecret = process.env.KINERA_QR_SECRET || DEV_QR_SECRET,
  publicBaseUrl = process.env.KINERA_PUBLIC_URL || DEV_PUBLIC_URL,
  seedData = true,
  production = process.env.NODE_ENV === 'production',
  trustProxy = process.env.KINERA_TRUST_PROXY,
  rateLimits = {},
} = {}) {
  // A public deployment must never run on the development secrets: session tokens
  // and QR tokens would both be forgeable by anyone who has read this repository.
  if (production) {
    const problems = [];
    if (secret === DEV_SECRET) problems.push('KINERA_SECRET');
    if (qrSecret === DEV_QR_SECRET) problems.push('KINERA_QR_SECRET');
    if (publicBaseUrl === DEV_PUBLIC_URL) problems.push('KINERA_PUBLIC_URL');
    if (problems.length) {
      throw new Error(
        `Refusing to start in production without: ${problems.join(', ')}. `
        + 'Set them to strong, unique values (see README → Deploying publicly).',
      );
    }
  }
  const db = await openDatabase(dbLocation);
  const masterData = new MasterDataService(db);
  if (seedData) await seed(db, { now: clock().toISOString() });

  const auth = new AuthService({ db, secret, clock });
  const scheduleBlocks = new ScheduleBlockService({ db, masterData, clock });
  const audit = new AuditService({ db, clock });
  const registrations = new RegistrationService({ db, masterData, qrSecret, blocks: scheduleBlocks, clock });
  const checkins = new CheckinService({ db, registrations, masterData, clock });
  const parking = new ParkingService({ db, registrations, masterData, clock });
  const dashboard = new DashboardService({ db, masterData, clock });
  const customerStats = new CustomerStatsService({ db, masterData, clock });
  const calendar = new CalendarService({ db, registrations, masterData, blocks: scheduleBlocks, clock });

  const app = express();
  app.set('services', {
    db, masterData, auth, registrations, checkins, parking, dashboard, customerStats,
    calendar, scheduleBlocks, audit, clock,
  });

  // Behind a reverse proxy or load balancer, req.ip must come from
  // X-Forwarded-For or every client looks like the proxy to the rate limiter.
  if (trustProxy) app.set('trust proxy', trustProxy === 'true' ? 1 : trustProxy);

  app.use(securityHeaders({ enableHsts: production }));
  app.use(express.json({ limit: '128kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    maxAge: production ? '1h' : 0,
    setHeaders: (res, filePath) => {
      // The two entry pages must not be cached, so a deploy is picked up at once.
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  // --- abuse protection on the two endpoints anyone on the internet can reach ---
  const loginKey = (req) => `${req.ip}|${String(req.body?.username ?? '').toLowerCase()}`;
  const loginLimiter = rateLimit({
    windowMs: rateLimits.loginWindowMs ?? 15 * 60 * 1000,
    max: rateLimits.loginMax ?? 10,
    key: loginKey,
    code: 'TOO_MANY_LOGIN_ATTEMPTS',
    message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
    clock: () => clock().getTime(),
  });
  const registrationLimiter = rateLimit({
    windowMs: rateLimits.registerWindowMs ?? 60 * 60 * 1000,
    max: rateLimits.registerMax ?? 20,
    code: 'TOO_MANY_REGISTRATIONS',
    message: 'Too many registrations from this connection. Please try again later.',
    clock: () => clock().getTime(),
  });

  /** The only things an account may do before it has chosen its own password. */
  const PASSWORD_CHANGE_EXEMPT = new Set(['POST /api/auth/password', 'GET /api/auth/me']);

  const wrap = (fn) => (req, res, next) => {
    try { Promise.resolve(fn(req, res, next)).catch(next); } catch (err) { next(err); }
  };

  // ---------------------------------------------------------------- auth helpers

  function readToken(req) {
    const header = req.get('authorization') || '';
    if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
    return null;
  }

  const authenticate = wrap(async (req, _res, next) => {
    const token = readToken(req);
    if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required.');
    req.user = await auth.verifyToken(token);

    // A password someone else chose has to be replaced before the account does
    // anything at all. Enforced here, for every route, rather than trusted to
    // the sign-in screen — otherwise the token alone would be enough to carry on.
    if (req.user.mustChangePassword && !PASSWORD_CHANGE_EXEMPT.has(`${req.method} ${req.path}`)) {
      throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED',
        'You must change your password before continuing.');
    }
    next();
  });

  const optionalAuth = wrap(async (req, _res, next) => {
    const token = readToken(req);
    if (token) req.user = await auth.verifyToken(token);
    next();
  });

  const requirePermission = (permission) => wrap((req, _res, next) => {
    assertCan(req.user, permission);
    next();
  });

  // ============================================================== PUBLIC / META

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, now: clock().toISOString() });
  });

  /**
   * Bootstrap payload for the registration wizard (§III, §IV, §VIII, §XI).
   * Includes the flagged duplicate slot so the UI can surface it (§XLVII).
   */
  app.get('/api/config', wrap(async (_req, res) => {
    res.json({
      languages: LANGUAGES,
      visitorTypes: Object.values(VISITOR_TYPES),
      salesOffices: await masterData.listOffices(),
      timeSlots: await masterData.listSlots(),
      agencies: await masterData.listAgencies(),
      statuses: ALL_STATUSES,
      rules: {
        maxAdvanceDays: MAX_ADVANCE_DAYS,
        maxVisitorsPerRegistration: MAX_VISITORS_PER_REGISTRATION,
        slotCapacity: SLOT_CAPACITY,
        confirmationCodeFormat: 'OE-XXXXX',
        vehicleTypes: Object.values(VEHICLE_TYPES),
        maxGuestOverage: MAX_GUEST_OVERAGE,
        earlyGraceMinutes: EARLY_GRACE_MINUTES,
        lateGraceMinutes: LATE_GRACE_MINUTES,
        autoRefreshMs: AUTO_REFRESH_MS,
      },
      today: toDateString(clock()),
      selectableDates: selectableDates(toDateString(clock())),
    });
  }));

  /** §VIII — availability per office + date, so full slots render as "Fully Booked". */
  app.get('/api/availability', wrap(async (req, res) => {
    const { salesOfficeId, visitDate } = req.query;
    if (!salesOfficeId) throw badRequest('SALES_OFFICE_REQUIRED', 'salesOfficeId is required.');
    if (!visitDate) throw badRequest('VISIT_DATE_REQUIRED', 'visitDate is required.');
    res.json({
      salesOfficeId,
      visitDate,
      slots: await registrations.getAvailability(String(salesOfficeId), String(visitDate)),
    });
  }));

  // ======================================================= REGISTRATION (public)

  /**
   * §XVIII — create registration. Anonymous visitors may self-register; an
   * authenticated Sales user may also create an Agency registration (§XXXIX Sales).
   */
  app.post('/api/registrations', registrationLimiter, optionalAuth, wrap(async (req, res) => {
    let actor = { id: 'VISITOR', name: 'Visitor (self-service)' };
    if (req.user) {
      if (req.user.role === ROLES.SALES) assertCan(req.user, P.REGISTRATION_CREATE);
      actor = { id: req.user.id, name: req.user.fullName };
    }
    const created = await registrations.createRegistration(req.body, { actor });
    res.status(201).json({
      registrationId: created.id,
      confirmationCode: created.confirmationCode,
      qrToken: created.qrToken,
      qrPayload: qrPayload(publicBaseUrl, created.qrToken),
      qrImageUrl: `/api/registrations/${created.confirmationCode}/qr.png?token=${encodeURIComponent(created.qrToken)}`,
      status: created.status,
      summary: {
        language: created.language,
        salesOffice: created.salesOffice,
        visitorType: created.visitorType,
        visitDate: created.visitDate,
        timeSlot: created.timeSlot,
        numberOfVisitors: created.numberOfVisitors,
        notes: created.notes,
        displayName: created.visitorType === VISITOR_TYPES.VISITOR
          ? created.visitor.fullName
          : created.agency.agencyName,
      },
    });
  }));

  /**
   * §XIX — QR image for the success page. The token must be supplied, so the
   * confirmation code alone is not enough to mint someone else's QR.
   */
  app.get('/api/registrations/:code/qr.png', wrap(async (req, res) => {
    const reg = await registrations.getByConfirmationCode(req.params.code, { includeQrToken: true });
    if (!reg) throw notFound('REGISTRATION_NOT_FOUND', 'Registration not found.');
    if (req.query.token !== reg.qrToken) {
      throw new AppError(403, 'FORBIDDEN', 'A valid QR token is required to render this QR code.');
    }
    const png = await QRCode.toBuffer(qrPayload(publicBaseUrl, reg.qrToken), {
      type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 512,
    });
    res.type('png').set('Cache-Control', 'no-store').send(png);
  }));

  /** §XIX — visitor re-opening their own confirmation (code + token). */
  app.get('/api/registrations/lookup', wrap(async (req, res) => {
    const { code, token } = req.query;
    const reg = await registrations.getByConfirmationCode(String(code ?? ''), { includeQrToken: true });
    if (!reg || reg.qrToken !== token) {
      throw notFound('REGISTRATION_NOT_FOUND', 'No registration matches that code and token.');
    }
    res.json({
      confirmationCode: reg.confirmationCode,
      status: reg.status,
      visitDate: reg.visitDate,
      timeSlot: reg.timeSlot,
      salesOffice: reg.salesOffice,
      numberOfVisitors: reg.numberOfVisitors,
      qrPayload: qrPayload(publicBaseUrl, reg.qrToken),
    });
  }));

  // ==================================================================== AUTH API

  app.post('/api/auth/login', loginLimiter, wrap(async (req, res) => {
    const { username, password } = req.body ?? {};
    const result = await auth.login(username, password);
    // A correct password clears that identity's failed-attempt budget, so one
    // person fumbling their password cannot lock out the desk for the shift.
    loginLimiter.reset(loginKey(req));
    res.json({
      token: result.token,
      expiresIn: result.expiresIn,
      mustChangePassword: result.mustChangePassword,
      user: {
        id: result.user.id,
        username: result.user.username,
        fullName: result.user.fullName,
        role: result.user.role,
        salesOfficeId: result.user.salesOfficeId,
        salesOffice: result.user.salesOfficeId ? await masterData.getOffice(result.user.salesOfficeId) : null,
      },
      permissions: Object.values(P).filter((p) => can(result.user, p)),
    });
  }));

  app.get('/api/auth/me', authenticate, wrap(async (req, res) => {
    res.json({
      user: {
        ...req.user,
        salesOffice: req.user.salesOfficeId ? await masterData.getOffice(req.user.salesOfficeId) : null,
      },
      permissions: Object.values(P).filter((p) => can(req.user, p)),
      scopeOfficeId: scopeOfficeFor(req.user),
    });
  }));

  // ============================================================= STAFF: REG LIST

  /**
   * The list filters, read the same way for the table and for its Excel export —
   * so the file can never cover a different set of rows than the screen.
   * `scopeOfficeId` is always taken from the session (§XXV): a query parameter can
   * narrow the view further but never widen it.
   */
  const registrationFilters = (req) => {
    const q = req.query;
    return {
      scopeOfficeId: scopeOfficeFor(req.user),
      salesOfficeId: q.salesOfficeId || null,
      visitorType: q.visitorType || null,
      status: q.status ? String(q.status).split(',') : null,
      dateFrom: q.dateFrom || null,
      dateTo: q.dateTo || null,
      search: q.search || null,
      parkingTicket: q.parkingTicket || null,
      sortBy: q.sortBy || 'visit_date',
      sortDir: q.sortDir || 'asc',
    };
  };

  const sendWorkbook = (res, buffer, filename) => {
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    // A report is a point-in-time snapshot; nothing downstream should keep it.
    res.setHeader('Cache-Control', 'no-store');
    res.end(buffer);
  };

  /** §XXXVIII — Registration Management. */
  app.get('/api/staff/registrations', authenticate, requirePermission(P.REGISTRATION_VIEW), wrap(async (req, res) => {
    const q = req.query;
    res.json(await registrations.list({
      ...registrationFilters(req),
      page: q.page || 1,
      pageSize: q.pageSize || 20,
    }));
  }));

  /**
   * §XXXVIII — the same list as .xlsx, covering every matching row rather than the
   * page on screen. The columns are the ones the user can already see, so this
   * grants no access the table does not.
   */
  app.get('/api/staff/registrations/export.xlsx', authenticate,
    requirePermission(P.REGISTRATION_EXPORT), wrap(async (req, res) => {
      const filters = registrationFilters(req);
      const result = await registrations.listAll(filters);
      const generatedAt = clock();
      const workbook = buildRegistrationWorkbook(result, {
        filters: { ...filters, salesOfficeId: filters.scopeOfficeId || filters.salesOfficeId },
        generatedBy: `${req.user.fullName} (${req.user.role})`,
        generatedAt,
      });
      sendWorkbook(res, workbook, reportFilename('kinera-dang-ky', { generatedAt, filters }));
    }));

  app.get('/api/staff/registrations/:id', authenticate, requirePermission(P.REGISTRATION_VIEW), wrap(async (req, res) => {
    const reg = await registrations.getById(req.params.id);
    if (!reg) throw notFound('REGISTRATION_NOT_FOUND', 'Registration not found.');
    registrations.assertOfficeAccess(reg, req.user);
    res.json(stripSecrets(reg));
  }));

  // ============================================================ STAFF: CHECK-IN

  /** §XXVI Option 1 — scan. Resolves only; it does not check in. */
  app.post('/api/staff/checkin/scan', authenticate, requirePermission(P.QR_SCAN), wrap(async (req, res) => {
    const token = req.body?.token ?? req.body?.qrToken;
    const { registration, readiness } = await checkins.resolveByQr(String(token ?? ''), req.user);
    res.json({ registration: stripSecrets(registration), readiness, method: CHECKIN_METHODS.QR });
  }));

  /** §XXVI Option 2 — desk search by confirmation code. */
  app.post('/api/staff/checkin/resolve', authenticate, requirePermission(P.REGISTRATION_SEARCH), wrap(async (req, res) => {
    const code = req.body?.confirmationCode;
    const { registration, readiness } = await checkins.resolveByConfirmationCode(String(code ?? ''), req.user);
    res.json({ registration: stripSecrets(registration), readiness, method: CHECKIN_METHODS.SEARCH });
  }));

  /**
   * §XXVI Option 2 — the desk's one search box: confirmation code, QR payload,
   * visitor name, phone, CCCD, agency or sales staff, all through one query.
   */
  app.post('/api/staff/checkin/lookup', authenticate, requirePermission(P.REGISTRATION_SEARCH), wrap(async (req, res) => {
    const result = await checkins.lookup(req.body?.query, req.user, {
      scopeOfficeId: scopeOfficeFor(req.user),
    });
    if (result.registration) result.registration = stripSecrets(result.registration);
    if (result.matches) {
      result.matches = result.matches.map((m) => ({
        registration: stripSecrets(m.registration),
        readiness: m.readiness,
      }));
    }
    res.json(result);
  }));

  /** §XXVIII — perform the check-in. */
  app.post('/api/staff/registrations/:id/checkin', authenticate, requirePermission(P.CHECKIN), wrap(async (req, res) => {
    const result = await checkins.checkIn(req.params.id, {
      user: req.user,
      method: req.body?.method ?? CHECKIN_METHODS.QR,
      notes: req.body?.notes ?? null,
      allowDateOverride: req.body?.allowDateOverride === true,
      allowTimeOverride: req.body?.allowTimeOverride === true,
      actualGuests: req.body?.actualGuests ?? null,
    });
    res.json({
      message: 'Check-in Successful',
      checkin: result.checkin,
      guests: result.guests,
      timing: result.timing,
      registration: stripSecrets(result.registration),
    });
  }));

  /** §XXIII — explicit status changes (Expected, In Visit, Completed, No Show, Cancelled). */
  app.post('/api/staff/registrations/:id/status', authenticate, requirePermission(P.STATUS_UPDATE), wrap(async (req, res) => {
    const reg = await registrations.getById(req.params.id);
    if (!reg) throw notFound('REGISTRATION_NOT_FOUND', 'Registration not found.');
    registrations.assertOfficeAccess(reg, req.user);
    const next = String(req.body?.status ?? '').toUpperCase();
    const updated = await registrations.changeStatus(req.params.id, next, {
      actor: { id: req.user.id, name: req.user.fullName },
      note: req.body?.note ?? null,
    });
    res.json(stripSecrets(updated));
  }));

  /**
   * §XXIX — parking tickets, one per vehicle, typed CAR or MOTORBIKE.
   * Only offices with parking tracking enabled (CII - Bình Thạnh) accept these.
   */
  app.get('/api/staff/registrations/:id/parking-tickets', authenticate,
    requirePermission(P.REGISTRATION_VIEW), wrap(async (req, res) => {
      const reg = await registrations.getById(req.params.id);
      if (!reg) throw notFound('REGISTRATION_NOT_FOUND', 'Registration not found.');
      registrations.assertOfficeAccess(reg, req.user);
      res.json(await parking.summaryFor(req.params.id));
    }));

  app.post('/api/staff/registrations/:id/parking-tickets', authenticate,
    requirePermission(P.PARKING_TICKET_UPDATE), wrap(async (req, res) => {
      const reg = await registrations.getById(req.params.id);
      if (!reg) throw notFound('REGISTRATION_NOT_FOUND', 'Registration not found.');
      registrations.assertOfficeAccess(reg, req.user);
      const ticket = await parking.issue(req.params.id, {
        vehicleType: String(req.body?.vehicleType ?? '').toUpperCase(),
        ticketNumber: req.body?.ticketNumber ?? null,
      }, { actor: { id: req.user.id, name: req.user.fullName } });
      res.status(201).json({ ticket, parking: await parking.summaryFor(req.params.id) });
    }));

  app.post('/api/staff/parking-tickets/:ticketId/return', authenticate,
    requirePermission(P.PARKING_TICKET_UPDATE), wrap(async (req, res) => {
      const ticket = await parking.markReturned(req.params.ticketId,
        { actor: { id: req.user.id, name: req.user.fullName } });
      const reg = await registrations.getById(ticket.registrationId);
      registrations.assertOfficeAccess(reg, req.user);
      res.json({ ticket, parking: await parking.summaryFor(ticket.registrationId) });
    }));

  app.delete('/api/staff/parking-tickets/:ticketId', authenticate,
    requirePermission(P.PARKING_TICKET_UPDATE), wrap(async (req, res) => {
      // The office check has to happen before the delete, so the ticket's own
      // registration is read first (§XXV).
      const row = await db.prepare('SELECT registration_id FROM parking_tickets WHERE id = ?')
        .get(req.params.ticketId);
      if (!row) throw notFound('PARKING_TICKET_NOT_FOUND', 'Parking ticket not found.');
      const reg = await registrations.getById(row.registration_id);
      registrations.assertOfficeAccess(reg, req.user);
      await parking.remove(req.params.ticketId);
      res.json({ parking: await parking.summaryFor(row.registration_id) });
    }));

  // ============================================================ DASHBOARD / CAL

  app.get('/api/staff/dashboard', authenticate, requirePermission(P.DASHBOARD_VIEW), wrap(async (req, res) => {
    const q = req.query;
    res.json({
      refreshIntervalMs: AUTO_REFRESH_MS,
      ...await dashboard.summary({
        scopeOfficeId: scopeOfficeFor(req.user),
        salesOfficeId: q.salesOfficeId || null,
        visitorType: q.visitorType || null,
        dateFrom: q.dateFrom || null,
        dateTo: q.dateTo || null,
      }),
    });
  }));

  /**
   * Customer statistics — management information, restricted to Manager and
   * Administrator by P.CUSTOMER_STATS_VIEW. The filter can only narrow a scoped
   * user's office, and neither of these two roles is scoped anyway.
   */
  const statsFilters = (req) => {
    const q = req.query;
    return {
      scopeOfficeId: scopeOfficeFor(req.user),
      salesOfficeId: q.salesOfficeId || null,
      visitorType: q.visitorType || null,
      agencyId: q.agencyId || null,
      dateFrom: q.dateFrom || null,
      dateTo: q.dateTo || null,
    };
  };

  app.get('/api/staff/customer-stats', authenticate,
    requirePermission(P.CUSTOMER_STATS_VIEW), wrap(async (req, res) => {
      res.json({
        refreshIntervalMs: AUTO_REFRESH_MS,
        ...await customerStats.summary(statsFilters(req)),
      });
    }));

  app.get('/api/staff/customer-stats/export.xlsx', authenticate,
    requirePermission(P.CUSTOMER_STATS_VIEW), wrap(async (req, res) => {
      const filters = statsFilters(req);
      const generatedAt = clock();
      const workbook = buildCustomerStatsWorkbook(await customerStats.summary(filters), {
        generatedBy: `${req.user.fullName} (${req.user.role})`,
        generatedAt,
      });
      sendWorkbook(res, workbook, reportFilename('kinera-thong-ke-khach-hang', { generatedAt, filters }));
    }));

  /** Receptionists get the same live numbers scoped to their own desk. */
  app.get('/api/staff/office-summary', authenticate, requirePermission(P.REGISTRATION_VIEW), wrap(async (req, res) => {
    const scope = scopeOfficeFor(req.user) || req.query.salesOfficeId || null;
    const today = toDateString(clock());
    res.json({
      refreshIntervalMs: AUTO_REFRESH_MS,
      salesOfficeId: scope,
      kpis: await dashboard.kpis({ scopeOfficeId: scope, dateFrom: today, dateTo: today }),
      parkingTickets: await dashboard.parkingTickets({ scopeOfficeId: scope, dateFrom: today, dateTo: today }),
    });
  }));

  app.get('/api/staff/calendar', authenticate, requirePermission(P.CALENDAR_VIEW), wrap(async (req, res) => {
    const q = req.query;
    res.json({
      refreshIntervalMs: AUTO_REFRESH_MS,
      ...await calendar.groupedByDate({
        view: q.view || 'day',
        date: q.date || null,
        scopeOfficeId: scopeOfficeFor(req.user),
        salesOfficeId: q.salesOfficeId || null,
        visitorType: q.visitorType || null,
        status: q.status ? String(q.status).split(',') : null,
      }),
    });
  }));

  // ============================================================ ADMIN / MASTER

  /** Who is making the change, as the audit log records them. */
  const actorOf = (req) => ({ id: req.user.id, name: req.user.fullName, role: req.user.role });

  app.get('/api/admin/users', authenticate, requirePermission(P.USER_MANAGE), wrap(async (req, res) => {
    res.json({ items: await auth.listUsers({ role: req.query.role || null, salesOfficeId: req.query.salesOfficeId || null }) });
  }));

  app.post('/api/admin/users', authenticate, requirePermission(P.USER_MANAGE), wrap(async (req, res) => {
    const user = await auth.createUser(req.body ?? {});
    await audit.record({
      actor: actorOf(req),
      action: 'USER_CREATED',
      entity: 'USER',
      entityId: user.id,
      summary: `Tạo tài khoản ${user.username} (${user.role})`,
      details: { username: user.username, fullName: user.fullName, role: user.role, salesOfficeId: user.salesOfficeId },
    });
    res.status(201).json(user);
  }));

  app.patch('/api/admin/users/:id', authenticate, requirePermission(P.USER_MANAGE), wrap(async (req, res) => {
    const before = await auth.getUserById(req.params.id);
    const user = await auth.updateUser(req.params.id, req.body ?? {});
    // Only what actually moved, so the line reads as a change rather than a dump.
    const changed = {};
    for (const key of ['username', 'fullName', 'role', 'salesOfficeId']) {
      if (before && before[key] !== user[key]) changed[key] = { from: before[key], to: user[key] };
    }
    await audit.record({
      actor: actorOf(req),
      action: 'USER_UPDATED',
      entity: 'USER',
      entityId: user.id,
      summary: Object.keys(changed).length
        ? `Sửa tài khoản ${user.username}: ${Object.keys(changed).join(', ')}`
        : `Lưu tài khoản ${user.username} (không có thay đổi)`,
      details: changed,
    });
    res.json(user);
  }));

  /** Activate or deactivate without deleting — the usual way an account is retired. */
  app.post('/api/admin/users/:id/active', authenticate, requirePermission(P.USER_MANAGE), wrap(async (req, res) => {
    const active = req.body?.active !== false;
    const user = await auth.setUserActive(req.params.id, active);
    await audit.record({
      actor: actorOf(req),
      action: active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
      entity: 'USER',
      entityId: user.id,
      summary: `${active ? 'Mở khoá' : 'Khoá'} tài khoản ${user.username}`,
    });
    res.json(user);
  }));

  /** An administrator sets a new password without knowing the old one. */
  app.post('/api/admin/users/:id/password', authenticate, requirePermission(P.USER_MANAGE), wrap(async (req, res) => {
    const user = await auth.resetPassword(req.params.id, req.body?.password);
    // The fact of the reset, never the password itself.
    await audit.record({
      actor: actorOf(req),
      action: 'USER_PASSWORD_RESET',
      entity: 'USER',
      entityId: user.id,
      summary: `Đặt lại mật khẩu cho ${user.username}`,
    });
    res.json({
      ok: true,
      message: 'Password changed. Any session this account already holds stays valid until it expires.',
    });
  }));

  app.delete('/api/admin/users/:id', authenticate, requirePermission(P.USER_MANAGE), wrap(async (req, res) => {
    const before = await auth.getUserById(req.params.id);
    const result = await auth.deleteUser(req.params.id, { actorId: req.user.id });
    await audit.record({
      actor: actorOf(req),
      action: 'USER_DELETED',
      entity: 'USER',
      entityId: req.params.id,
      summary: `Xoá tài khoản ${result.username}`,
      details: before ? { username: before.username, fullName: before.fullName, role: before.role } : null,
    });
    res.json(result);
  }));

  /** Anyone signed in may change their own password, proving the current one. */
  app.post('/api/auth/password', authenticate, wrap(async (req, res) => {
    await auth.changeOwnPassword(req.user.id, req.body?.currentPassword, req.body?.newPassword);
    await audit.record({
      actor: actorOf(req),
      action: 'PASSWORD_CHANGED_SELF',
      entity: 'USER',
      entityId: req.user.id,
      summary: `${req.user.username} tự đổi mật khẩu`,
    });
    res.json({ ok: true, message: 'Password changed.' });
  }));

  // ------------------------------------------------------------- audit log

  app.get('/api/admin/audit-log', authenticate, requirePermission(P.AUDIT_VIEW), wrap(async (req, res) => {
    const q = req.query;
    res.json({
      ...await audit.list({
        action: q.action || null,
        entity: q.entity || null,
        actorId: q.actorId || null,
        from: q.from || null,
        to: q.to || null,
        page: q.page || 1,
        pageSize: q.pageSize || 50,
      }),
      availableActions: await audit.actions(),
    });
  }));

  // --------------------------------------------------- blocked periods (§admin)

  app.get('/api/admin/blocked-periods', authenticate, requirePermission(P.SCHEDULE_BLOCK), wrap(async (req, res) => {
    res.json({
      items: await scheduleBlocks.list({
        from: req.query.from || null,
        to: req.query.to || null,
        salesOfficeId: req.query.salesOfficeId || null,
      }),
    });
  }));

  app.post('/api/admin/blocked-periods', authenticate, requirePermission(P.SCHEDULE_BLOCK), wrap(async (req, res) => {
    const b = req.body ?? {};
    const block = await scheduleBlocks.create({
      salesOfficeId: b.salesOfficeId || null,
      timeSlotId: b.timeSlotId || null,
      startDate: b.startDate,
      endDate: b.endDate || null,
      reason: b.reason || null,
    }, { actor: { id: req.user.id, name: req.user.fullName } });
    const span = block.startDate === block.endDate
      ? block.startDate : `${block.startDate} → ${block.endDate}`;
    await audit.record({
      actor: actorOf(req),
      action: 'PERIOD_BLOCKED',
      entity: 'BLOCKED_PERIOD',
      entityId: block.id,
      summary: `Khoá lịch ${span}${block.reason ? ` — ${block.reason}` : ''}`,
      details: {
        startDate: block.startDate,
        endDate: block.endDate,
        salesOfficeId: block.salesOfficeId,
        timeSlotId: block.timeSlotId,
        reason: block.reason,
        affectedRegistrations: block.affectedRegistrations,
      },
    });
    res.status(201).json(block);
  }));

  app.delete('/api/admin/blocked-periods/:id', authenticate, requirePermission(P.SCHEDULE_BLOCK), wrap(async (req, res) => {
    const [existing] = await scheduleBlocks.list().then((all) => all.filter((b) => b.id === req.params.id));
    const result = await scheduleBlocks.remove(req.params.id);
    await audit.record({
      actor: actorOf(req),
      action: 'PERIOD_UNBLOCKED',
      entity: 'BLOCKED_PERIOD',
      entityId: req.params.id,
      summary: existing
        ? `Bỏ khoá ${existing.startDate}${existing.endDate !== existing.startDate ? ` → ${existing.endDate}` : ''}`
        : 'Bỏ khoá lịch',
      details: existing,
    });
    res.json(result);
  }));

  app.post('/api/admin/agencies', authenticate, requirePermission(P.MASTER_DATA_MANAGE), wrap(async (req, res) => {
    const { id, name, active } = req.body ?? {};
    if (!id || !name) throw badRequest('MISSING_FIELDS', 'id and name are required.');
    const agency = await masterData.upsertAgency({ id, name, active: active !== false });
    await audit.record({
      actor: actorOf(req),
      action: 'AGENCY_SAVED',
      entity: 'AGENCY',
      entityId: agency.id,
      summary: `Lưu đại lý ${agency.name}${agency.active ? '' : ' (ngưng hoạt động)'}`,
      details: { name: agency.name, active: agency.active },
    });
    res.json(agency);
  }));

  /**
   * Every slot, including the ones taken out of service.
   *
   * /api/config deliberately hides inactive slots from visitors — but the
   * administrator has to see them, or a slot switched off could never be
   * switched back on.
   */
  app.get('/api/admin/time-slots', authenticate, requirePermission(P.MASTER_DATA_MANAGE), wrap(async (_req, res) => {
    res.json({ items: await masterData.listSlots({ includeInactive: true }) });
  }));

  /** §VIII — capacity per slot, and taking a slot out of service. */
  app.patch('/api/admin/time-slots/:id', authenticate, requirePermission(P.MASTER_DATA_MANAGE), wrap(async (req, res) => {
    const slot = await masterData.updateSlot(req.params.id, {
      capacity: req.body?.capacity, active: req.body?.active,
    });
    const moved = slot.previousCapacity !== slot.capacity;
    await audit.record({
      actor: actorOf(req),
      action: moved ? 'SLOT_CAPACITY_CHANGED' : 'SLOT_UPDATED',
      entity: 'TIME_SLOT',
      entityId: slot.id,
      summary: moved
        ? `Sức chứa ${slot.label}: ${slot.previousCapacity} → ${slot.capacity} khách`
        : `Khung giờ ${slot.label}: ${slot.active ? 'mở lại' : 'tạm ngưng'}`,
      details: {
        capacity: { from: slot.previousCapacity, to: slot.capacity },
        active: slot.active,
        overbookedDates: slot.overbookedDates,
      },
    });
    res.json(slot);
  }));

  // =================================================================== FALLBACKS

  app.use('/api', (_req, _res, next) => {
    next(notFound('ENDPOINT_NOT_FOUND', 'No such API endpoint.'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      const body = { error: { code: err.code, message: err.message } };
      if (err.details) body.error.details = err.details;
      return res.status(err.status).json(body);
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' } });
    }
    process.stderr.write(`[unhandled] ${err?.stack || err}\n`);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.' } });
  });

  app.locals.services = {
    db, masterData, auth, registrations, checkins, parking, dashboard, customerStats, calendar,
  };
  let closed = false;
  app.locals.close = async () => {
    if (closed) return;
    closed = true;
    try { await db.close(); } catch { /* already closed elsewhere */ }
  };
  return app;
}

module.exports = { createApp, STATUS };
