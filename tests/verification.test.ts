import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { all, get, run } from '../src/db.ts';
import { config } from '../src/config.ts';
import { handleInboundSms } from '../src/core/inbound.ts';
import { pendingVerifications, recordUpdate, currentStatus } from '../src/core/status.ts';
import { notifySupervisors, overdueVerifications } from '../src/core/verification.ts';
import { facilityId, setupDb, teardownDb } from './helpers.ts';
import { flushQueue, sendSms, sendWhatsApp } from '../src/gateway.ts';

const SUPERVISOR = '+256700111222';

function queueLength(): number {
  return pendingVerifications().length;
}

describe('supervisor verification', () => {
  before(setupDb);
  after(teardownDb);

  it('notifies every supervisor when a critical report arrives', () => {
    run(`DELETE FROM messages WHERE direction = 'OUT'`);
    recordUpdate({
      facilityId: facilityId('CLINIC2'),
      serviceCode: 'VACCINE',
      state: 'UNAVAILABLE',
      rawMessage: 'CLINIC2 VACCINE NO',
      channel: 'SMS',
      sourceMsisdn: '+256701234567',
      role: 'VOLUNTEER',
    });
    const alerts = all<{ msisdn: string; body: string }>(
      `SELECT msisdn, body FROM messages WHERE direction = 'OUT'`,
    );
    assert.ok(alerts.length >= 1);
    assert.match(alerts[0].body, /VERIFY #\d+: CLINIC2 Vaccines=NOT AVAILABLE/);
    assert.match(alerts[0].body, /Reply OK \d+ or NO \d+/);
  });

  it('accepts OK <id> and marks the report confirmed', () => {
    const update = recordUpdate({
      facilityId: facilityId('CLINIC2'),
      serviceCode: 'MEDICINE',
      state: 'UNAVAILABLE',
      rawMessage: 'CLINIC2 MEDICINE NO',
      channel: 'SMS',
      sourceMsisdn: '+256701234567',
      role: 'VOLUNTEER',
    });
    const before = queueLength();
    const result = handleInboundSms(SUPERVISOR, `OK ${update.id}`);
    assert.equal(result.kind, 'VERIFY');
    assert.match(result.reply, /verified/);
    const stored = get<{ verification: string; verified_by: string }>(
      'SELECT verification, verified_by FROM status_updates WHERE id = ?',
      update.id,
    );
    assert.equal(stored?.verification, 'VERIFIED');
    assert.equal(stored?.verified_by, SUPERVISOR);
    assert.equal(queueLength(), before - 1);
  });

  it('accepts NO <id> <reason> and stops serving the rejected reading', () => {
    const site = facilityId('GOV1');
    const bad = recordUpdate({
      facilityId: site,
      serviceCode: 'PASSPORT',
      state: 'AVAILABLE',
      rawMessage: 'GOV1 PASSPORT YES',
      channel: 'SMS',
      sourceMsisdn: '+256703456789',
      role: 'VOLUNTEER',
    });
    assert.equal(bad.verification, 'PENDING');

    handleInboundSms(SUPERVISOR, `NO ${bad.id} no machine this week`);

    const stored = get<{ verification: string; reject_reason: string }>(
      'SELECT verification, reject_reason FROM status_updates WHERE id = ?',
      bad.id,
    );
    assert.equal(stored?.verification, 'REJECTED');
    assert.equal(stored?.reject_reason, 'no machine this week');

    const current = currentStatus(site, 'PASSPORT');
    assert.notEqual(current?.id, bad.id, 'a rejected reading must not be shown to citizens');
  });

  it('tells the reporter what happened to their submission', () => {
    run(`DELETE FROM messages WHERE direction = 'OUT'`);
    const update = recordUpdate({
      facilityId: facilityId('CLINIC1'),
      serviceCode: 'STAFF',
      state: 'UNAVAILABLE',
      rawMessage: 'CLINIC1 STAFF NO',
      channel: 'SMS',
      sourceMsisdn: '+256701234567',
      role: 'VOLUNTEER',
    });
    handleInboundSms(SUPERVISOR, `OK ${update.id}`);
    const confirmations = all<{ msisdn: string; body: string }>(
      `SELECT msisdn, body FROM messages WHERE direction = 'OUT' ORDER BY id`,
    );
    assert.ok(confirmations.some((m) => m.msisdn === '+256701234567' && /CONFIRMED/.test(m.body)));
  });

  it('returns a WhatsApp report decision over WhatsApp', () => {
    const update = recordUpdate({
      facilityId: facilityId('CLINIC1'),
      serviceCode: 'VACCINE',
      state: 'UNAVAILABLE',
      rawMessage: 'CLINIC1 VACCINE NO',
      channel: 'WHATSAPP',
      sourceMsisdn: '+256701234567',
      role: 'VOLUNTEER',
    });
    handleInboundSms(SUPERVISOR, `OK ${update.id}`);
    const confirmation = get<{ channel: string; body: string }>(
      `SELECT channel, body FROM messages WHERE direction = 'OUT' AND msisdn = ? ORDER BY id DESC LIMIT 1`,
      '+256701234567',
    );
    assert.equal(confirmation?.channel, 'WHATSAPP');
    assert.match(confirmation?.body ?? '', /CONFIRMED/);
  });

  it('refuses verification commands from a citizen handset', () => {
    const update = recordUpdate({
      facilityId: facilityId('CLINIC1'),
      serviceCode: 'LAB',
      state: 'AVAILABLE',
      rawMessage: 'CLINIC1 LAB YES',
      channel: 'SMS',
      sourceMsisdn: '+256701234567',
      role: 'VOLUNTEER',
    });
    const result = handleInboundSms('+256709111111', `OK ${update.id}`);
    assert.equal(result.kind, 'ERROR');
    assert.match(result.reply, /Only supervisors/);
    assert.notEqual(
      get<{ verification: string }>('SELECT verification FROM status_updates WHERE id = ?', update.id)?.verification,
      'VERIFIED',
    );
  });

  it('spaces reminders so a pending report is not chased every pass', () => {
    const update = recordUpdate({
      facilityId: facilityId('HOSP1'),
      serviceCode: 'VACCINE',
      state: 'UNAVAILABLE',
      rawMessage: 'HOSP1 VACCINE NO',
      channel: 'SMS',
      sourceMsisdn: '+256701234567',
      role: 'VOLUNTEER',
    });
    const aged = new Date(Date.now() - 600 * 60000).toISOString();
    run('UPDATE status_updates SET created_at = ?, notified_at = ? WHERE id = ?', aged, aged, update.id);

    assert.equal(overdueVerifications(config.verificationEscalateAfterMinutes).some((u) => u.id === update.id), true);

    run(`DELETE FROM messages WHERE direction = 'OUT'`);
    notifySupervisors(
      {
        updateId: update.id,
        facilityCode: 'HOSP1',
        serviceName: 'Vaccines',
        state: 'UNAVAILABLE',
        sourceMsisdn: '+256701234567',
      },
      { reminder: true },
    );

    const reminder = get<{ body: string }>(`SELECT body FROM messages WHERE direction = 'OUT' ORDER BY id DESC LIMIT 1`);
    assert.match(reminder?.body ?? '', /^REMINDER VERIFY #\d+: HOSP1 Vaccines/);
    assert.equal(overdueVerifications(config.verificationEscalateAfterMinutes).some((u) => u.id === update.id), false);
  });

  it('does not let the same report be re-decided', () => {    const update = recordUpdate({
      facilityId: facilityId('CLINIC1'),
      serviceCode: 'VACCINE',
      state: 'AVAILABLE',
      rawMessage: 'CLINIC1 VACCINE YES',
      channel: 'SMS',
      sourceMsisdn: '+256701234567',
      role: 'STAFF',
    });
    handleInboundSms(SUPERVISOR, `OK ${update.id}`);
    const second = handleInboundSms(SUPERVISOR, `NO ${update.id} changed my mind`);
    assert.match(second.reply, /already/i);
    assert.equal(
      get<{ verification: string }>('SELECT verification FROM status_updates WHERE id = ?', update.id)?.verification,
      'VERIFIED',
    );
  });
});

describe('delivery and fallback', () => {
  before(setupDb);
  after(teardownDb);

  it('retries a queued message until it lands', () => {
    const result = handleInboundSms('+256701234567', 'CLINIC1 VACCINE YES');
    const reply = get<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM messages WHERE direction = 'OUT' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(reply?.status, 'QUEUED');
    assert.equal(result.kind, 'REPORT');

    const first = flushQueue();
    assert.equal(first.retried >= 1, true);
    const after = get<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM messages WHERE direction = 'OUT' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(after?.status, 'DELIVERED');
    assert.equal(after?.attempts, 1);
  });

  it('gives up after three attempts and records why', () => {
    const previous = config.simulatedFailureRate;
    config.simulatedFailureRate = 1;
    handleInboundSms('+256701234567', 'CLINIC1 VACCINE NO');
    for (let pass = 0; pass < 4; pass += 1) flushQueue();
    config.simulatedFailureRate = previous;

    const failed = get<{ status: string; attempts: number; error: string }>(
      `SELECT status, attempts, error FROM messages WHERE direction = 'OUT' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(failed?.status, 'FAILED');
    assert.equal(failed?.attempts, 3);
    assert.match(failed?.error ?? '', /handset switched off/);
  });

  it('records the inbound message itself for the audit trail', () => {
    handleInboundSms('+256706000000', 'HELP');
    const inbound = get<{ direction: string; body: string }>(
      `SELECT direction, body FROM messages WHERE direction = 'IN' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(inbound?.body, 'HELP');
  });

  it('sends SMS and WhatsApp through Africa\'s Talking when enabled', async () => {
    const originalFetch = globalThis.fetch;
    const previous = {
      atMode: config.atMode,
      atUsername: config.atUsername,
      atApiKey: config.atApiKey,
      atSmsSenderId: config.atSmsSenderId,
      atWhatsappNumber: config.atWhatsappNumber,
    };
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    config.atMode = 'africastalking';
    config.atUsername = 'sandbox';
    config.atApiKey = 'test-key';
    config.atSmsSenderId = 'TestSender';
    config.atWhatsappNumber = '+256700000000';
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(input), headers: new Headers(init?.headers), body });
      const response = requests.length === 1
        ? { SMSMessageData: { Recipients: [{ statusCode: 101, status: 'Success', messageId: 'AT-SMS-1' }] } }
        : { status: 'SENT', messageId: 'AT-WA-1' };
      return new Response(JSON.stringify(response), { status: 200 });
    };

    try {
      const smsId = sendSms('+256701234567', 'SMS test');
      const whatsappId = sendWhatsApp('+256701234567', 'WhatsApp test');
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));

      assert.equal(requests.length, 2);
      assert.equal(requests[0].headers.get('apiKey'), 'test-key');
      assert.deepEqual(requests[0].body, {
        username: 'sandbox',
        phoneNumbers: ['+256701234567'],
        message: 'SMS test',
        senderId: 'TestSender',
      });
      assert.deepEqual(requests[1].body, {
        username: 'sandbox',
        waNumber: '+256700000000',
        phoneNumber: '+256701234567',
        body: { message: 'WhatsApp test' },
      });
      assert.equal(get<{ provider_id: string }>('SELECT provider_id FROM messages WHERE id = ?', smsId)?.provider_id, 'AT-SMS-1');
      assert.equal(get<{ provider_id: string }>('SELECT provider_id FROM messages WHERE id = ?', whatsappId)?.provider_id, 'AT-WA-1');
    } finally {
      globalThis.fetch = originalFetch;
      Object.assign(config, previous);
    }
  });
});
