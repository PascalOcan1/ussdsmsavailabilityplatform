import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { get, run } from '../src/db.ts';
import { config } from '../src/config.ts';
import { facilityCodes, seedIfEmpty } from '../src/seed.ts';
import {
  currentStatus,
  facilityStatusBoard,
  minutesSince,
  pendingVerifications,
  recordUpdate,
  summarizeFacility,
  verificationFor,
} from '../src/core/status.ts';
import { overdueVerifications } from '../src/core/verification.ts';
import { facilityId, setupDb, teardownDb } from './helpers.ts';
import type { Facility } from '../src/types.ts';

const report = (overrides: Partial<Parameters<typeof recordUpdate>[0]> = {}) =>
  recordUpdate({
    facilityId: facilityId('CLINIC1'),
    serviceCode: 'VACCINE',
    state: 'AVAILABLE',
    rawMessage: 'CLINIC1 VACCINE YES',
    channel: 'SMS',
    sourceMsisdn: '+256701234567',
    role: 'STAFF',
    ...overrides,
  });

describe('verification rules', () => {
  before(setupDb);
  after(teardownDb);

  it('sends critical reports from non-supervisors to the verification queue', () => {
    assert.equal(verificationFor('STAFF', true), 'PENDING');
    assert.equal(verificationFor('VOLUNTEER', true), 'PENDING');
    assert.equal(verificationFor('SUPERVISOR', true), 'VERIFIED');
    assert.equal(verificationFor('STAFF', false), 'NOT_REQUIRED');
  });

  it('stores the decision on the update itself', () => {
    assert.equal(report().verification, 'PENDING');
    assert.equal(report({ role: 'VOLUNTEER' }).verification, 'PENDING');
    assert.equal(report({ serviceCode: 'LAB', role: 'STAFF' }).verification, 'NOT_REQUIRED');
  });
});

describe('current status resolution', () => {
  before(setupDb);
  after(teardownDb);

  it('serves the newest report for a facility and service', () => {
    report({ state: 'AVAILABLE' });
    report({ state: 'UNAVAILABLE' });
    assert.equal(currentStatus(facilityId('CLINIC1'), 'VACCINE')?.state, 'UNAVAILABLE');
  });

  it('drops a rejected report and falls back to the previous one', () => {
    const first = report({ state: 'AVAILABLE' });
    const second = report({ state: 'UNAVAILABLE' });
    run(`UPDATE status_updates SET verification = 'REJECTED' WHERE id = ?`, second.id);
    const current = currentStatus(facilityId('CLINIC1'), 'VACCINE');
    assert.equal(current?.id, first.id);
    assert.equal(current?.state, 'AVAILABLE');
  });

  it('marks a report stale once it passes the freshness window', () => {
    const site = facilityId('CLINIC3');
    const fresh = recordUpdate({
      facilityId: site,
      serviceCode: 'LAB',
      state: 'AVAILABLE',
      rawMessage: 'CLINIC3 LAB YES',
      channel: 'SMS',
      sourceMsisdn: '+256705678901',
      role: 'VOLUNTEER',
    });
    assert.equal(currentStatus(site, 'LAB')?.stale, false);
    run(
      `UPDATE status_updates SET created_at = ? WHERE id = ?`,
      new Date(Date.now() - (config.staleAfterMinutes + 30) * 60000).toISOString(),
      fresh.id,
    );
    assert.equal(currentStatus(site, 'LAB')?.stale, true);
  });

  it('keeps the unconfirmed badge visible to citizens', () => {
    report();
    const board = facilityStatusBoard(facilityId('CLINIC1'));
    const vaccine = board.find((row) => row.service_code === 'VACCINE');
    assert.equal(vaccine?.verification, 'PENDING');
    const facility = get<Facility>('SELECT * FROM facilities WHERE code = ?', 'CLINIC1')!;
    const lines = summarizeFacility(facility, 'en');
    assert.match(lines.join(' '), /NOT yet confirmed/);
  });

  it('summarises in the reporter language', () => {
    report({ state: 'UNAVAILABLE' });
    const facility = get<Facility>('SELECT * FROM facilities WHERE code = ?', 'CLINIC1')!;
    assert.match(summarizeFacility(facility, 'lg').join(' '), /TEWALI/);
  });

  it('counts minutes since a report', () => {
    assert.equal(minutesSince(new Date(Date.now() - 90_000).toISOString()), 1);
    assert.equal(minutesSince(new Date().toISOString()), 0);
  });

  it('archives legacy water facilities while retaining their historical reports', () => {
    const facility = run(
      `INSERT INTO facilities (code, name, district, parish, category, created_at)
       VALUES ('LEGACYWATER', 'Old water point', 'Wakiso', 'Old Parish', 'WATER', ?)`,
      new Date().toISOString(),
    );
    run('INSERT INTO facility_services (facility_id, service_code) VALUES (?, ?)', facility.lastInsertRowid, 'VACCINE');
    const update = run(
      `INSERT INTO status_updates
       (facility_id, service_code, state, raw_message, channel, source_msisdn, reporter_role, verification, created_at)
       VALUES (?, 'VACCINE', 'UNAVAILABLE', 'legacy water report', 'SMS', '+256700000099', 'VOLUNTEER', 'PENDING', '2000-01-01T00:00:00.000Z')`,
      facility.lastInsertRowid,
    );

    seedIfEmpty();

    assert.equal(get<{ active: number }>('SELECT active FROM facilities WHERE code = ?', 'LEGACYWATER')?.active, 0);
    assert.equal(facilityCodes().includes('LEGACYWATER'), false);
    assert.ok(get('SELECT id FROM status_updates WHERE id = ?', update.lastInsertRowid));
    assert.equal(pendingVerifications().some((row) => row.id === update.lastInsertRowid), false);
    assert.equal(overdueVerifications(1).some((row) => row.id === update.lastInsertRowid), false);
  });
});
