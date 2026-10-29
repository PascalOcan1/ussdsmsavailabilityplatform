import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { normalizeMsisdn, normalizeText, parseReport } from '../src/core/parser.ts';
import { setupDb, teardownDb } from './helpers.ts';

describe('coded message parser', () => {
  before(setupDb);
  after(teardownDb);

  it('reads the canonical form from the proposal', () => {
    const result = parseReport('CLINIC1 VACCINE YES');
    assert.equal(result.ok, true);
    assert.equal(result.facilityCode, 'CLINIC1');
    assert.equal(result.serviceCode, 'VACCINE');
    assert.equal(result.state, 'AVAILABLE');
  });

  it('accepts a facility code split by a space, as in the proposal examples', () => {
    const result = parseReport('CLINIC 1 VACCINE YES');
    assert.equal(result.ok, true);
    assert.equal(result.facilityCode, 'CLINIC1');
  });

  it('is indifferent to case, punctuation and repeated spaces', () => {
    const result = parseReport('  clinic2  staff limited!!  ');
    assert.equal(result.ok, true);
    assert.equal(result.serviceCode, 'STAFF');
    assert.equal(result.state, 'LIMITED');
  });

  it('rejects water points and water-only service aliases', () => {
    assert.equal(parseReport('WATER3 BROKEN').error, 'UNKNOWN_FACILITY');
    assert.equal(parseReport('CLINIC1 PUMP YES').error, 'UNKNOWN_SERVICE');
  });

  it('understands stock-outs, closures and partial supply', () => {
    assert.equal(parseReport('CLINIC1 MEDS OUT').state, 'UNAVAILABLE');
    assert.equal(parseReport('CLINIC1 MEDICINE LIMITED').state, 'LIMITED');
    assert.equal(parseReport('GOV1 PASSPORT CLOSED').state, 'CLOSED');
  });

  it('accepts local-language status words', () => {
    assert.equal(parseReport('CLINIC1 VACCINE TERE').state, 'AVAILABLE');
    assert.equal(parseReport('CLINIC1 VACCINE TEWALI').state, 'UNAVAILABLE');
    assert.equal(parseReport('GOV1 PASSPORT HAPANA').state, 'UNAVAILABLE');
  });

  it('keeps free text after the status as detail', () => {
    const result = parseReport('CLINIC1 VACCINE NO COLD CHAIN FAILED');
    assert.equal(result.state, 'UNAVAILABLE');
    assert.equal(result.detail, 'cold chain failed');
  });

  it('rejects unknown facilities, services and missing status separately', () => {
    assert.equal(parseReport('CLINIC99 VACCINE YES').error, 'UNKNOWN_FACILITY');
    assert.equal(parseReport('CLINIC1 UNICORN YES').error, 'UNKNOWN_SERVICE');
    assert.equal(parseReport('CLINIC1 VACCINE').error, 'MISSING_STATUS');
    assert.match(parseReport('CLINIC1 VACCINE').hint ?? '', /YES/);
  });

  it('normalizes the number formats rural handsets actually send', () => {
    assert.equal(normalizeMsisdn('+256778715187'), '+256778715187');
    assert.equal(normalizeMsisdn('0778715187'), '+256778715187');
    assert.equal(normalizeMsisdn('256778715187'), '+256778715187');
    assert.equal(normalizeMsisdn('00256778715187'), '+256778715187');
  });

  it('strips message-body noise from the gateway', () => {
    assert.equal(normalizeText('Clinic-1, vaccine:  yes!'), 'CLINIC 1 VACCINE YES');
  });
});
