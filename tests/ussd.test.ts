import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { get, run } from '../src/db.ts';
import { handleUssd, SESSION_TTL_MS } from '../src/core/ussd.ts';
import { facilityId, setupDb, teardownDb } from './helpers.ts';

let counter = 0;
const newSession = (): string => `sess-${(counter += 1)}-${Date.now()}`;

/** Read the numbered options off a USSD screen so assertions do not depend on row order. */
function options(screen: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of screen.split('\n')) {
    const match = /^(\d+)\.\s+(.*)$/.exec(line.trim());
    if (match) found.set(match[2], match[1]);
  }
  return found;
}

function pickOption(screen: string, label: string): string {
  const letter = [...options(screen).entries()].find(([text]) => text.startsWith(label))?.[1];
  assert.ok(letter, `option "${label}" missing from screen:\n${screen}`);
  return letter;
}

/**
 * Step through menus: a choice is either a literal key ("2") or a label to find on the
 * previous screen. Returns every screen visited, starting with the language picker.
 */
function navigate(sessionId: string, msisdn: string, choices: string[]): string[] {
  const screens: string[] = [];
  screens.push(handleUssd({ sessionId, msisdn, text: '' }).text);
  for (const choice of choices) {
    const input = /^\d+$/.test(choice) ? choice : pickOption(screens[screens.length - 1], choice);
    screens.push(handleUssd({ sessionId, msisdn, text: input }).text);
  }
  return screens;
}

/** language -> main -> category -> district -> facility -> service -> reading */
const vaccinePath = ['1', '1', 'Health', 'Wakiso', 'Kigungu HC II', 'Vaccines'];

function queryVaccine(sessionId: string, msisdn: string): string[] {
  return navigate(sessionId, msisdn, vaccinePath);
}

describe('USSD session machine', () => {
  before(setupDb);
  after(teardownDb);

  it('opens on the language picker for a fresh dial', () => {
    const reply = handleUssd({ sessionId: newSession(), msisdn: '+256709990001', text: '' });
    assert.equal(reply.continues, true);
    assert.ok(options(reply.text).has('English'));
    assert.ok(options(reply.text).has('Swahili'));
  });

  it('translates service names as well as states so menus are not half in English', () => {
    const screens = navigate(newSession(), '+256709990009', ['2', '1', 'Ebyobulamu', 'Wakiso', 'Kigungu HC II']);
    const board = screens[screens.length - 1];
    assert.match(board, /Ekifoza/);
    assert.ok(!board.includes('Vaccines:'), `English service label leaked into a Luganda screen:\n${board}`);
    assert.ok(!board.includes('Essential medicines'), `English service label leaked into a Luganda screen:\n${board}`);
  });

  it('keeps the chosen language for the rest of the session', () => {
    const sessionId = newSession();
    handleUssd({ sessionId, msisdn: '+256709990002', text: '' });
    const luganda = handleUssd({ sessionId, msisdn: '+256709990002', text: '2' });
    assert.match(luganda.text, /Menyu enkulu/);
    const session = get<{ language: string }>('SELECT language FROM ussd_sessions WHERE id = ?', sessionId);
    assert.equal(session?.language, 'lg');
  });

  it('answers a citizen asking about vaccines', () => {
    const transcript = queryVaccine(newSession(), '+256709990003');
    const result = transcript[6];
    assert.match(result, /Vaccines/);
    assert.match(result, /AVAILABLE/);
    assert.match(result, /Updated/);
  });

  it('warns when a reading has not been confirmed by a supervisor', () => {
    const screens = navigate(newSession(), '+256709990004', ['1', '1', 'Health', 'Wakiso', 'Nansana HC III', 'Staff on duty']);
    assert.match(screens[6], /NOT yet confirmed/);
  });

  it('asks the saved-a-trip question only when the service is out of reach', () => {
    const available = navigate(newSession(), '+256709990005', vaccinePath);
    assert.doesNotMatch(available[6], /save you a trip/);

    const msisdn = '+256709990005';
    const sessionId = newSession();
    const out = navigate(sessionId, msisdn, ['1', '1', 'Health', 'Wakiso', 'Nansana HC III', 'Staff on duty']);
    assert.match(out[6], /NOT AVAILABLE/);
    assert.match(out[6], /save you a trip/);

    const answered = handleUssd({ sessionId, msisdn, text: '1' });
    assert.match(answered.text, /Thank you/);
    const trip = get<{ avoided_trip: number }>(
      `SELECT avoided_trip FROM service_queries WHERE msisdn = ? AND avoided_trip IS NOT NULL ORDER BY id DESC LIMIT 1`,
      msisdn,
    );
    assert.equal(trip?.avoided_trip, 1);
  });

  it('records a status report from a facility in-charge', () => {
    const sessionId = newSession();
    const msisdn = '+256701234567';
    handleUssd({ sessionId, msisdn, text: '' });
    const main = handleUssd({ sessionId, msisdn, text: '1' }).text;
    const reportMenu = handleUssd({ sessionId, msisdn, text: pickOption(main, 'Report service status') }).text;
    assert.match(reportMenu, /Kigungu HC II/);

    const before = get<{ n: number }>('SELECT COUNT(*) AS n FROM status_updates')!;
    const services = handleUssd({ sessionId, msisdn, text: pickOption(reportMenu, 'CLINIC1') }).text;
    const states = handleUssd({ sessionId, msisdn, text: pickOption(services, 'Essential medicines') }).text;
    handleUssd({ sessionId, msisdn, text: pickOption(states, 'NOT AVAILABLE') });

    const after = get<{ n: number }>('SELECT COUNT(*) AS n FROM status_updates')!;
    assert.equal(Number(after.n) - Number(before.n), 1);
    const stored = get<{ verification: string; channel: string }>(
      `SELECT verification, channel FROM status_updates ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(stored?.channel, 'USSD');
    assert.equal(stored?.verification, 'PENDING');
  });

  it('only offers a reporter their own facility', () => {
    const sessionId = newSession();
    const msisdn = '+256703456789';
    handleUssd({ sessionId, msisdn, text: '' });
    handleUssd({ sessionId, msisdn, text: '1' });
    const menu = handleUssd({ sessionId, msisdn, text: '2' }).text;
    assert.match(menu, /CLINIC2/);
    assert.doesNotMatch(menu, /CLINIC1/);
  });

  it('closes cleanly on the exit option and on END', () => {
    const sessionId = newSession();
    const msisdn = '+256709990006';
    handleUssd({ sessionId, msisdn, text: '' });
    const main = handleUssd({ sessionId, msisdn, text: '1' });
    assert.equal(options(main.text).get('Exit'), '9');
    const closed = handleUssd({ sessionId, msisdn, text: '9' });
    assert.equal(closed.continues, false);
    const ended = handleUssd({ sessionId: newSession(), msisdn, text: '', action: 'END' });
    assert.equal(ended.continues, false);
  });

  it('restarts instead of dead-ending on an expired session', () => {
    const sessionId = newSession();
    const msisdn = '+256709990007';
    handleUssd({ sessionId, msisdn, text: '' });
    handleUssd({ sessionId, msisdn, text: '1' });
    run('UPDATE ussd_sessions SET updated_at = ? WHERE id = ?', new Date(Date.now() - SESSION_TTL_MS - 5000).toISOString(), sessionId);
    const restarted = handleUssd({ sessionId, msisdn, text: '3' });
    assert.ok(options(restarted.text).has('English'));
  });

  it('re-prompts rather than crashing on an out-of-range choice', () => {
    const sessionId = newSession();
    const msisdn = '+256709990008';
    handleUssd({ sessionId, msisdn, text: '' });
    handleUssd({ sessionId, msisdn, text: '1' });
    const wrong = handleUssd({ sessionId, msisdn, text: '77' });
    assert.equal(wrong.continues, true);
    assert.match(wrong.text, /Main menu|try again/);
  });

  it('walks back with 0', () => {
    const sessionId = newSession();
    const msisdn = '+256709990009';
    const screens = navigate(sessionId, msisdn, ['1', '1', 'Health', 'Wakiso']);
    assert.match(screens[4], /Kigungu HC II/);
    const back = handleUssd({ sessionId, msisdn, text: '0' });
    assert.equal(back.continues, true);
    assert.match(back.text, /Which district\?/);
  });
});
