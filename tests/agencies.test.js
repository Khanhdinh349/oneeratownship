'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startServer, buildApp, agencyPayload, CREDS, OFFICE_TG } = require('./helpers');
const {
  AGENCY_SEED, OTHER_AGENCY_ID, RETIRED_AGENCY_IDS, MAX_AGENCY_NAME_LENGTH,
} = require('../src/config/master-data');
const { validateAgency } = require('../src/domain/validation');

test('§XXII the agency list is the real one, and ids are stable', () => {
  const names = AGENCY_SEED.map((a) => a.name);
  assert.equal(AGENCY_SEED.length, 22);
  assert.equal(names[names.length - 1], 'Khác', '"Khác" is the last entry');
  assert.ok(names.includes('KIM OANH REALTY'));
  assert.ok(names.includes('LM: THIÊN PHÁT REALTY - HPR - HAYHOMES'));
  assert.ok(names.includes('NHÀ NHƯ Ý (PROPER HOMES)'));

  assert.equal(new Set(AGENCY_SEED.map((a) => a.id)).size, AGENCY_SEED.length, 'ids are unique');
  assert.equal(new Set(names).size, names.length, 'names are unique');
  for (const a of AGENCY_SEED) {
    assert.match(a.id, /^AG_[A-Z0-9_]+$/, `${a.id} is not a stable ASCII id`);
  }
  // Exactly one entry may stand for an agency that is not on the list.
  assert.deepEqual(AGENCY_SEED.filter((a) => a.allowsCustomName).map((a) => a.id),
    [OTHER_AGENCY_ID]);
});

test('§XXII the list reaches the registration form in display order', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const config = await server.get('/api/config');
  const agencies = config.body.agencies;
  assert.equal(agencies.length, AGENCY_SEED.length);

  const last = agencies[agencies.length - 1];
  assert.equal(last.id, OTHER_AGENCY_ID, '"Khác" must sit at the bottom of the dropdown');
  assert.equal(last.allowsCustomName, true);
  assert.ok(agencies.slice(0, -1).every((a) => a.allowsCustomName === false));

  // Everything above it is in name order, so the list is scannable.
  const named = agencies.slice(0, -1).map((a) => a.name);
  assert.deepEqual(named, [...named].sort((x, y) => x.localeCompare(y, 'vi')));

  await t.test('the old placeholder agencies are gone from it', async () => {
    for (const id of RETIRED_AGENCY_IDS) {
      assert.equal(agencies.some((a) => a.id === id), false, `${id} is still offered`);
    }
  });

  await t.test('but their rows survive, so old registrations keep their key', async () => {
    const rows = await server.services.masterData.listAgencies({ includeInactive: true });
    for (const id of RETIRED_AGENCY_IDS) {
      const row = rows.find((a) => a.id === id);
      // Only present if this database ever had them; a fresh one never did.
      if (row) assert.equal(row.active, false, `${id} should be inactive, not deleted`);
    }
  });
});

test('§XXII a database from the previous release keeps its registrations', async () => {
  // The placeholder ids were real foreign keys. Deactivating must not orphan them.
  const { services } = await buildApp({ seedData: false });
  const { db } = services;
  await db.prepare('INSERT INTO agencies (id, name, active) VALUES (?,?,1)').run('AG_A', 'Agency A');
  await require('../src/db/seed').seed(db, { now: '2026-10-01T00:00:00.000Z' });

  const row = await db.prepare('SELECT * FROM agencies WHERE id = ?').get('AG_A');
  assert.ok(row, 'the row is still there');
  assert.equal(row.active, 0, 'but it is no longer offered');
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM agencies WHERE active = 1').get()).n),
    AGENCY_SEED.length);
});

test('§XXII choosing "Khác" requires the agency name', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test('a blank name is refused by the backend, not only the form', async () => {
    const res = await server.post('/api/registrations',
      agencyPayload({ agencyId: OTHER_AGENCY_ID, agencyName: '   ' }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
    assert.ok(res.body.error.details.some((d) => d.field === 'agencyName' && d.code === 'REQUIRED'));
  });

  await t.test('a missing name is refused too', async () => {
    const res = await server.post('/api/registrations', agencyPayload({ agencyId: OTHER_AGENCY_ID }));
    assert.equal(res.status, 400);
    assert.ok(res.body.error.details.some((d) => d.field === 'agencyName'));
  });

  await t.test('an over-long name is refused', async () => {
    const res = await server.post('/api/registrations', agencyPayload({
      agencyId: OTHER_AGENCY_ID, agencyName: 'A'.repeat(MAX_AGENCY_NAME_LENGTH + 1),
    }));
    assert.equal(res.status, 400);
    assert.ok(res.body.error.details.some((d) => d.field === 'agencyName' && d.code === 'TOO_LONG'));
  });

  await t.test('a typed name is accepted and stored', async () => {
    const res = await server.post('/api/registrations', agencyPayload({
      agencyId: OTHER_AGENCY_ID, agencyName: '  Đại lý   Hoàng  Gia  ',
    }));
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const manager = await server.login(...CREDS.manager);
    const found = await server.get(
      `/api/staff/registrations?search=${res.body.confirmationCode}`, { token: manager.token });
    const reg = found.body.items[0];
    assert.equal(reg.agency.agencyId, OTHER_AGENCY_ID);
    // Whitespace is collapsed, as it is for every other name field.
    assert.equal(reg.agency.agencyName, 'Đại lý Hoàng Gia');
  });

  await t.test('a listed agency still needs no typed name', async () => {
    const res = await server.post('/api/registrations',
      agencyPayload({ agencyId: 'AG_IQI', agencyName: 'ignored', visitDate: '2026-10-08' }));
    assert.equal(res.status, 201);
    const manager = await server.login(...CREDS.manager);
    const found = await server.get(
      `/api/staff/registrations?search=${res.body.confirmationCode}`, { token: manager.token });
    // The name on the record is the agency's own, never whatever was posted.
    assert.equal(found.body.items[0].agency.agencyName, 'IQI');
  });
});

test('§Rule 11 a typed name that is already on the list folds back onto it', () => {
  const agencies = [
    { id: 'AG_IQI', name: 'IQI', active: 1 },
    { id: OTHER_AGENCY_ID, name: 'Khác', active: 1 },
  ];
  const errors = [];

  // Case and padding should not create a second "IQI".
  assert.deepEqual(validateAgency(OTHER_AGENCY_ID, agencies, errors, '  iqi '),
    { id: 'AG_IQI', name: 'IQI' });
  assert.deepEqual(errors, []);

  // A genuinely new name stays under "Khác".
  assert.deepEqual(validateAgency(OTHER_AGENCY_ID, agencies, errors, 'Nhà Đất Minh Khang'),
    { id: OTHER_AGENCY_ID, name: 'Nhà Đất Minh Khang' });
  assert.deepEqual(errors, []);
});

test('§XXII custom agencies are counted separately in the statistics', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const book = (agencyName, over = {}) => server.post('/api/registrations', agencyPayload({
    agencyId: OTHER_AGENCY_ID, agencyName, salesOfficeId: OFFICE_TG, ...over,
  }));

  await book('Nhà Đất Minh Khang');
  await book('Nhà Đất Minh Khang', { visitDate: '2026-10-07' });
  await book('Bất Động Sản Sao Mai', { customerShortName: 'L.T.H', customerPhoneLast4: '1111' });

  const manager = await server.login(...CREDS.manager);
  const stats = await server.get('/api/staff/customer-stats', { token: manager.token });
  assert.equal(stats.status, 200);

  const rows = stats.body.byAgency.filter((a) => a.agencyId === OTHER_AGENCY_ID);
  assert.equal(rows.length, 2, 'two different typed names are two rows, not one lump');
  const byName = Object.fromEntries(rows.map((r) => [r.agencyName, r]));
  assert.equal(byName['Nhà Đất Minh Khang'].registrations, 2);
  assert.equal(byName['Bất Động Sản Sao Mai'].registrations, 1);

  await t.test('and their customers are not merged across agencies', async () => {
    // The same customer short name under two different typed agencies must stay
    // two customers, even though every "Khác" row shares one agency id.
    assert.equal(byName['Nhà Đất Minh Khang'].customers, 1, 'one repeat customer');
    assert.equal(stats.body.overview.customers, 2);
  });
});
