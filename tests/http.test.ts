import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/index.ts';
import { config } from '../src/config.ts';
import { get, run } from '../src/db.ts';
import { setupDb, teardownDb } from './helpers.ts';

let server: http.Server;
let base = '';

async function post(path: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    body: new URLSearchParams(form),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    redirect: 'manual',
  });
}

async function cookieFor(msisdn: string): Promise<string> {
  const response = await post('/login', { msisdn, pin: config.adminPin });
  assert.equal(response.status, 303, `login should succeed for ${msisdn}`);
  return (response.headers.getSetCookie?.()[0] ?? '').split(';')[0];
}

before(async () => {
  setupDb();
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  teardownDb();
});

describe('gateway webhooks', () => {
  it('answers the health probe', async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ok');
  });

  it('accepts an Africa\u2019s Talking style SMS webhook and replies', async () => {
    const response = await post('/gateway/sms', { from: '0701234567', to: '22888', text: 'CLINIC1 VACCINE NO' });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.status, 'success');
    assert.equal(payload.result.kind, 'REPORT');
    assert.match(payload.response, /RECEIVED #\d+: CLINIC1 Vaccines = UNAVAILABLE/);
  });

  it('accepts WhatsApp text through the shared inbound message handler', async () => {
    const response = await post('/gateway/whatsapp', { from: '0701234567', text: 'HELP' });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.result.kind, 'HELP');
    const inbound = get<{ channel: string; body: string }>(
      `SELECT channel, body FROM messages WHERE direction = 'IN' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(inbound?.channel, 'WHATSAPP');
    assert.equal(inbound?.body, 'HELP');
    const outbound = get<{ channel: string }>(
      `SELECT channel FROM messages WHERE direction = 'OUT' ORDER BY id DESC LIMIT 1`,
    );
    if (!outbound) throw new Error('Outbound message was not recorded');
    assert.equal(outbound.channel, 'WHATSAPP');
  });

  it('drives a pull-mode USSD conversation', async () => {
    const sessionId = `at-${Date.now()}`;
    const first = await post('/gateway/ussd', { text: '', sessionId, phoneNumber: '0709888777' });
    const firstText = await first.text();
    assert.equal(first.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(firstText, /^CON /);
    assert.match(firstText, /English/);

    const second = await post('/gateway/ussd', { text: '1', sessionId, phoneNumber: '0709888777' });
    assert.match(await second.text(), /^CON .*Main menu/s);

    const third = await post('/gateway/ussd', { text: '1*1', sessionId, phoneNumber: '0709888777' });
    assert.match(await third.text(), /^CON .*Health/s);
  });

  it('ends a USSD session using the provider END response prefix', async () => {
    const sessionId = `at-end-${Date.now()}`;
    await post('/gateway/ussd', { text: '', sessionId, phoneNumber: '0709888778' });
    await post('/gateway/ussd', { text: '1', sessionId, phoneNumber: '0709888778' });
    const closed = await post('/gateway/ussd', { text: '1*9', sessionId, phoneNumber: '0709888778' });
    assert.match(await closed.text(), /^END /);
  });

  it('applies a provider delivery report to the matching message ID', async () => {
    await post('/gateway/sms', { from: '0701234567', text: 'CLINIC1 LAB YES' });
    const outbound = get<{ id: number }>(`SELECT id FROM messages WHERE direction = 'OUT' ORDER BY id DESC LIMIT 1`);
    if (!outbound) throw new Error('Outbound message was not recorded');
    run('UPDATE messages SET provider_id = ?, status = ? WHERE id = ?', 'AT-DLR-1', 'SENT', outbound.id);
    const response = await post('/gateway/dlr', { id: 'AT-DLR-1', phoneNumber: '0701234567', status: 'Success' });
    assert.equal((await response.json()).updated, 1);
    const delivered = get<{ status: string }>(
      `SELECT status FROM messages WHERE direction = 'OUT' AND msisdn = '+256701234567' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(delivered?.status, 'DELIVERED');
  });

  it('rejects a webhook with no sender', async () => {
    const response = await post('/gateway/sms', { text: 'CLINIC1 VACCINE YES' });
    assert.equal(response.status, 400);
  });
});

describe('admin dashboard', () => {
  it('links an external stylesheet and serves it as CSS', async () => {
    const login = await (await fetch(`${base}/login`)).text();
    assert.match(login, /href="\/styles\.css"/);
    assert.doesNotMatch(login, /<style\b/i);

    const stylesheet = await fetch(`${base}/styles.css`);
    assert.match(stylesheet.headers.get('content-type') ?? '', /text\/css/);
    assert.match(await stylesheet.text(), /\.simulator-layout/);
  });

  it('sends anonymous visitors to sign in', async () => {
    const response = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/login');
  });

  it('refuses a wrong PIN', async () => {
    const response = await post('/login', { msisdn: '+256700111222', pin: '0000' });
    assert.equal(response.status, 401);
  });

  it('signs a supervisor in and shows the live board', async () => {
    const cookie = await cookieFor('+256700111222');
    const board = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    assert.match(board, /Kigungu HC II/);
    assert.match(board, /awaiting supervisor confirmation/);

    const verify = await (await fetch(`${base}/verify`, { headers: { cookie } })).text();
    assert.match(verify, /Awaiting confirmation/);
    assert.match(verify, /name="decision" value="approve"/);
  });

  it('blocks the verification queue for a reporter role', async () => {
    const cookie = await cookieFor('+256701234567');
    const response = await post('/verify/1', { decision: 'approve' }, { cookie });
    assert.equal(response.status, 403);
  });

  it('lists facilities with their reporting coverage', async () => {
    const cookie = await cookieFor('+256778715187');
    const page = await (await fetch(`${base}/facilities`, { headers: { cookie } })).text();
    assert.match(page, /Reporting coverage/);
    assert.match(page, /Wakiso General Hospital/);
  });

  it('allows admins to create, edit, and archive a facility', async () => {
    const cookie = await cookieFor('+256778715187');
    const created = await post('/facilities', {
      code: 'TESTCLINIC',
      name: 'Test Health Centre',
      district: 'Wakiso',
      parish: 'Kigungu',
      category: 'HEALTH',
      service_VACCINE: '1',
    }, { cookie });
    assert.equal(created.status, 303);

    const facility = get<{ id: number }>('SELECT id FROM facilities WHERE code = ?', 'TESTCLINIC');
    if (!facility) throw new Error('Created facility was not found');
    assert.equal(
      get<{ service_code: string }>('SELECT service_code FROM facility_services WHERE facility_id = ?', facility.id)?.service_code,
      'VACCINE',
    );

    const edit = await post('/facilities/TESTCLINIC/edit', {
      code: 'TESTCLINIC',
      name: 'Updated Health Centre',
      district: 'Mukono',
      parish: 'Kira',
      category: 'GOVERNMENT',
      service_PASSPORT: '1',
    }, { cookie });
    assert.equal(edit.status, 303);
    assert.equal(get<{ name: string; category: string }>(
      'SELECT name, category FROM facilities WHERE id = ?', facility.id,
    )?.name, 'Updated Health Centre');
    assert.equal(get<{ category: string }>(
      'SELECT category FROM facilities WHERE id = ?', facility.id,
    )?.category, 'GOVERNMENT');
    assert.equal(get<{ service_code: string }>(
      'SELECT service_code FROM facility_services WHERE facility_id = ?', facility.id,
    )?.service_code, 'PASSPORT');

    const report = run(
      `INSERT INTO status_updates
       (facility_id, service_code, state, raw_message, channel, source_msisdn, reporter_role, verification, created_at)
       VALUES (?, 'PASSPORT', 'AVAILABLE', 'TESTCLINIC PASSPORT YES', 'SMS', '+256701234567', 'STAFF', 'NOT_REQUIRED', ?)`,
      facility.id,
      new Date().toISOString(),
    );
    const archived = await post('/facilities/TESTCLINIC/delete', {}, { cookie });
    assert.equal(archived.status, 303);
    assert.equal(get<{ active: number }>('SELECT active FROM facilities WHERE id = ?', facility.id)?.active, 0);
    assert.ok(get('SELECT id FROM status_updates WHERE id = ?', report.lastInsertRowid));
  });

  it('restricts facility management to admins', async () => {
    const cookie = await cookieFor('+256701234567');
    const response = await fetch(`${base}/facilities/new`, { headers: { cookie } });
    assert.equal(response.status, 403);
  });

  it('shows the message log and analytics', async () => {
    const cookie = await cookieFor('+256778715187');
    const messages = await (await fetch(`${base}/messages`, { headers: { cookie } })).text();
    assert.match(messages, /CLINIC1 VACCINE NO/);
    const analytics = await (await fetch(`${base}/analytics`, { headers: { cookie } })).text();
    assert.match(analytics, /Proposal KPIs/);
    assert.match(analytics, /Trips avoided|Users reporting an avoided journey/);
  });

  it('shows the SMS, USSD, and queue controls in the phone simulator', async () => {
    const cookie = await cookieFor('+256778715187');
    const simulator = await (await fetch(`${base}/simulator`, { headers: { cookie } })).text();
    assert.match(simulator, /SMS handset/);
    assert.match(simulator, /USSD session/);
    assert.match(simulator, /Retry queued messages/);
    assert.match(simulator, /simulator-layout/);
  });

  it('serves the public status API', async () => {
    const response = await fetch(`${base}/api/status/CLINIC1`);
    const payload = await response.json();
    assert.equal(payload.code, 'CLINIC1');
    assert.ok(payload.services.length >= 2);
  });

  it('returns JSON for an unknown facility code', async () => {
    const response = await fetch(`${base}/api/status/NOPE9`);
    assert.equal(response.status, 404);
  });
});
