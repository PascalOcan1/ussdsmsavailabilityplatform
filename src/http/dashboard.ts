import { all, audit, get, nowIso, run, tx } from '../db.ts';
import { config } from '../config.ts';
import { channelSplit, coverage, kpis, monthly } from '../core/analytics.ts';
import { handleInboundSms } from '../core/inbound.ts';
import { facilityStatusBoard, pendingVerifications } from '../core/status.ts';
import { handleUssd } from '../core/ussd.ts';
import { applyDecision } from '../core/verification.ts';
import { flushQueue, type OutboundMessage } from '../gateway.ts';
import type { Facility, ServiceType, StatusUpdate } from '../types.ts';
import { escape, layout, login, logout, currentSession, json, redirect, send, sessionCookie, type Ctx, type Router } from './util.ts';

const CATEGORY_LABEL: Record<string, string> = {
  HEALTH: 'Health facilities',
  GOVERNMENT: 'Government offices',
};
const FACILITY_CATEGORIES = ['HEALTH', 'GOVERNMENT'] as const;

interface FacilityFormValues {
  code: string;
  name: string;
  district: string;
  parish: string;
  category: string;
  serviceCodes: string[];
}

interface BoardRow extends StatusUpdate {
  facility_code: string;
  facility_name: string;
  district: string;
  parish: string;
  service_name: string;
  minutes_old: number;
  stale: boolean;
}

export function registerDashboardRoutes(router: Router): void {
  router.get('/health', (ctx) => {
    json(ctx.res, 200, { status: 'ok', uptimeSeconds: Math.round(process.uptime()), shortCode: config.shortCode });
  });

  router.get('/login', (ctx) => {
    send(ctx.res, 200, layout('Sign in', loginPage(), { path: '/login' }));
  });

  router.post('/login', (ctx) => {
    const msisdn = String(ctx.body.msisdn ?? '').trim();
    const pin = String(ctx.body.pin ?? '');
    const user = get<{ msisdn: string; name: string; role: string }>(
      `SELECT msisdn, name, role FROM app_users WHERE msisdn = ? AND active = 1`,
      msisdn,
    );
    if (!user || pin !== config.adminPin) {
      send(ctx.res, 401, layout('Sign in', loginPage('Number not recognised or wrong PIN.')), );
      return;
    }
    redirect(ctx.res, '/', sessionCookie(login({ msisdn: user.msisdn, name: user.name, role: user.role })));
  });

  router.post('/logout', (ctx) => {
    logout(ctx.req);
    redirect(ctx.res, '/');
  });

  router.get('/logout', (ctx) => {
    logout(ctx.req);
    redirect(ctx.res, '/');
  });

  router.get('/', (ctx) => {
    const session = currentSession(ctx.req);
    if (!session) return redirect(ctx.res, '/login');
    send(ctx.res, 200, layout('Status board', boardPage(), { session, path: '/' }));
  });

  router.get('/facilities', (ctx) => {
    const session = currentSession(ctx.req);
    if (!session) return redirect(ctx.res, '/login');
    send(ctx.res, 200, layout('Facilities', facilitiesPage(session.role), { session, path: '/facilities' }));
  });

  router.get('/facilities/new', (ctx) => {
    const session = currentSession(ctx.req);
    if (!session) return redirect(ctx.res, '/login');
    if (session.role !== 'ADMIN') return send(ctx.res, 403, layout('Forbidden', '<div class="notice bad">Only admins can manage facilities.</div>', { session }));
    const values: FacilityFormValues = { code: '', name: '', district: '', parish: '', category: 'HEALTH', serviceCodes: [] };
    send(ctx.res, 200, layout('Add facility', facilityFormPage(values, availableFacilityServices(), '/facilities', 'Add facility'), { session, path: '/facilities' }));
  });

  router.post('/facilities', (ctx) => {
    const session = currentSession(ctx.req);
    if (!session) return redirect(ctx.res, '/login');
    if (session.role !== 'ADMIN') return send(ctx.res, 403, layout('Forbidden', '<div class="notice bad">Only admins can manage facilities.</div>', { session }));

    const values = readFacilityForm(ctx.body);
    const services = availableFacilityServices();
    const error = validateFacilityForm(values, services);
    if (error) return send(ctx.res, 400, layout('Add facility', facilityFormPage(values, services, '/facilities', 'Add facility', error), { session, path: '/facilities' }));

    const timestamp = nowIso();
    tx(() => {
      const inserted = run(
        `INSERT INTO facilities (code, name, district, parish, category, active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
        values.code,
        values.name,
        values.district,
        values.parish,
        values.category,
        timestamp,
      );
      for (const serviceCode of values.serviceCodes) {
        run('INSERT INTO facility_services (facility_id, service_code) VALUES (?, ?)', inserted.lastInsertRowid, serviceCode);
      }
      audit(session.msisdn, 'FACILITY_CREATE', `facility:${values.code}`, `${values.category}; services=${values.serviceCodes.join(',')}`);
    });
    return redirect(ctx.res, '/facilities');
  });

  router.get('/facilities/:code/edit', (ctx) => {
    const session = currentSession(ctx.req);
    if (!session) return redirect(ctx.res, '/login');
    if (session.role !== 'ADMIN') return send(ctx.res, 403, layout('Forbidden', '<div class="notice bad">Only admins can manage facilities.</div>', { session }));
    const facility = get<Facility>('SELECT * FROM facilities WHERE code = ? AND active = 1', ctx.params.code.toUpperCase());
    if (!facility) return send(ctx.res, 404, layout('Not found', '<div class="notice bad">Facility not found.</div>', { session }));
    const serviceCodes = all<{ service_code: string }>('SELECT service_code FROM facility_services WHERE facility_id = ?', facility.id).map((row) => row.service_code);
    const values = { ...facility, serviceCodes };
    send(ctx.res, 200, layout(`Edit ${facility.name}`, facilityFormPage(values, availableFacilityServices(), `/facilities/${encodeURIComponent(facility.code)}/edit`, 'Save changes'), { session, path: '/facilities' }));
  });

  router.post('/facilities/:code/edit', (ctx) => {
    const session = currentSession(ctx.req);
    if (!session) return redirect(ctx.res, '/login');
    if (session.role !== 'ADMIN') return send(ctx.res, 403, layout('Forbidden', '<div class="notice bad">Only admins can manage facilities.</div>', { session }));
    const facility = get<Facility>('SELECT * FROM facilities WHERE code = ? AND active = 1', ctx.params.code.toUpperCase());
    if (!facility) return send(ctx.res, 404, layout('Not found', '<div class="notice bad">Facility not found.</div>', { session }));

    const values = readFacilityForm(ctx.body, facility);
    const services = availableFacilityServices();
    const error = validateFacilityForm(values, services, facility.id);
    if (error) return send(ctx.res, 400, layout(`Edit ${facility.name}`, facilityFormPage(values, services, `/facilities/${encodeURIComponent(facility.code)}/edit`, 'Save changes', error), { session, path: '/facilities' }));

    tx(() => {
      run(
        'UPDATE facilities SET name = ?, district = ?, parish = ?, category = ? WHERE id = ? AND active = 1',
        values.name,
        values.district,
        values.parish,
        values.category,
        facility.id,
      );
      run('DELETE FROM facility_services WHERE facility_id = ?', facility.id);
      for (const serviceCode of values.serviceCodes) {
        run('INSERT INTO facility_services (facility_id, service_code) VALUES (?, ?)', facility.id, serviceCode);
      }
      audit(session.msisdn, 'FACILITY_UPDATE', `facility:${facility.code}`, `${values.category}; services=${values.serviceCodes.join(',')}`);
    });
    return redirect(ctx.res, `/facilities/${encodeURIComponent(facility.code)}`);
  });

  router.get('/facilities/:code/archive', (ctx) => {
    const session = currentSession(ctx.req);
    if (!session) return redirect(ctx.res, '/login');
    if (session.role !== 'ADMIN') return send(ctx.res, 403, layout('Forbidden', '<div class="notice bad">Only admins can manage facilities.</div>', { session }));
    const facility = get<Facility>('SELECT * FROM facilities WHERE code = ? AND active = 1', ctx.params.code.toUpperCase());
    if (!facility) return send(ctx.res, 404, layout('Not found', '<div class="notice bad">Facility not found.</div>', { session }));
    send(ctx.res, 200, layout('Delete facility', archiveFacilityPage(facility), { session, path: '/facilities' }));
  });

  router.post('/facilities/:code/delete', (ctx) => {
    const session = currentSession(ctx.req);
    if (!session) return redirect(ctx.res, '/login');
    if (session.role !== 'ADMIN') return send(ctx.res, 403, layout('Forbidden', '<div class="notice bad">Only admins can manage facilities.</div>', { session }));
    const facility = get<Facility>('SELECT * FROM facilities WHERE code = ? AND active = 1', ctx.params.code.toUpperCase());
    if (!facility) return send(ctx.res, 404, layout('Not found', '<div class="notice bad">Facility not found.</div>', { session }));

    tx(() => {
      run('UPDATE facilities SET active = 0 WHERE id = ?', facility.id);
      run('UPDATE app_users SET active = 0 WHERE facility_id = ?', facility.id);
      run('DELETE FROM facility_services WHERE facility_id = ?', facility.id);
      audit(session.msisdn, 'FACILITY_DELETE', `facility:${facility.code}`, 'Archived; historical reports retained');
    });
    return redirect(ctx.res, '/facilities');
  });

  router.get('/facilities/:code', (ctx) => {
    const session = currentSession(ctx.req);
    if (!session) return redirect(ctx.res, '/login');
    const facility = get<Facility>('SELECT * FROM facilities WHERE code = ? AND active = 1', ctx.params.code.toUpperCase());
    if (!facility) return send(ctx.res, 404, layout('Not found', `<div class="notice bad">No facility ${escape(ctx.params.code)}</div>`, { session }));
    send(ctx.res, 200, layout(facility.name, facilityPage(facility, session.role), { session, path: '/facilities' }));
  });

  router.get('/verify', (ctx) => {
    const session = currentSession(ctx.req);
    if (!session) return redirect(ctx.res, '/login');
    send(ctx.res, 200, layout('Verification queue', verifyPage(session.role), { session, path: '/verify' }));
  });

  router.post('/verify/:id', (ctx) => {
    const session = currentSession(ctx.req);
    if (!session) return redirect(ctx.res, '/login');
    if (session.role !== 'SUPERVISOR' && session.role !== 'ADMIN') {
      return send(ctx.res, 403, layout('Forbidden', `<div class="notice bad">Only supervisors can confirm reports.</div>`, { session }));
    }
    const decision = String(ctx.body.decision ?? '');
    const id = Number(ctx.params.id);
    const result =
      decision === 'reject'
        ? applyDecision({ updateId: id, decision: 'REJECTED', reason: String(ctx.body.reason ?? 'Not specified') }, session.msisdn)
        : applyDecision({ updateId: id, decision: 'VERIFIED' }, session.msisdn);
    send(ctx.res, 200, layout('Verification queue', verifyPage(session.role, result.message), { session, path: '/verify' }));
  });

  router.get('/messages', (ctx) => {
    const session = currentSession(ctx.req);
    if (!session) return redirect(ctx.res, '/login');
    send(ctx.res, 200, layout('Message log', messagesPage(), { session, path: '/messages' }));
  });

  router.get('/analytics', (ctx) => {
    const session = currentSession(ctx.req);
    if (!session) return redirect(ctx.res, '/login');
    send(ctx.res, 200, layout('Analytics', analyticsPage(), { session, path: '/analytics' }));
  });

  router.get('/simulator', (ctx) => {
    const session = currentSession(ctx.req);
    if (!session) return redirect(ctx.res, '/login');
    send(ctx.res, 200, layout('Phone simulator', simulatorPage(ctx.query), { session, path: '/simulator' }));
  });

  router.post('/simulator', (ctx) => {
    const session = currentSession(ctx.req);
    if (!session) return redirect(ctx.res, '/login');
    const mode = ctx.body.mode;
    const msisdn = String(ctx.body.msisdn ?? '+256700000000');

    if (mode === 'ussd') {
      const sessionId = ctx.body.sessionId || `sim-${Date.now()}`;
      const reply = handleUssd({ sessionId, msisdn, text: String(ctx.body.text ?? '') });
      const params = new URLSearchParams({
        msisdn,
        screen: reply.text,
        sessionId: reply.sessionId,
        open: reply.continues ? '1' : '',
        log: `>> dialed ${config.shortCode} | input: ${ctx.body.text ?? ''}`,
      });
      redirect(ctx.res, `/simulator?${params}`);
      return;
    }

    if (mode === 'flush') {
      const result = flushQueue();
      redirect(ctx.res, `/simulator?${new URLSearchParams({ msisdn, log: `Queue retry: ${JSON.stringify(result)}` })}`);
      return;
    }

    const text = String(ctx.body.text ?? '');
    const result = handleInboundSms(msisdn, text);
    const params = new URLSearchParams({
      msisdn,
      log: `>> ${text}\n<< ${result.reply}`,
      kind: result.kind,
    });
    redirect(ctx.res, `/simulator?${params}`);
  });

  router.post('/simulator/sms', (ctx) => {
    const result = handleInboundSms(String(ctx.body.msisdn ?? '+256700000000'), String(ctx.body.text ?? ''));
    json(ctx.res, 200, result);
  });

  router.get('/api/status', (ctx) => {
    const facilities = all<Facility>('SELECT * FROM facilities WHERE active = 1 ORDER BY code');
    json(ctx.res, 200, facilities.map((facility) => ({
      code: facility.code,
      name: facility.name,
      district: facility.district,
      parish: facility.parish,
      category: facility.category,
      services: facilityStatusBoard(facility.id).map(publicView),
    })));
  });

  router.get('/api/status/:code', (ctx) => {
    const facility = get<Facility>('SELECT * FROM facilities WHERE code = ? AND active = 1', ctx.params.code.toUpperCase());
    if (!facility) return json(ctx.res, 404, { error: 'unknown facility' });
    json(ctx.res, 200, {
      code: facility.code,
      name: facility.name,
      district: facility.district,
      parish: facility.parish,
      services: facilityStatusBoard(facility.id).map(publicView),
    });
  });
}

function publicView(row: BoardRow): Record<string, unknown> {
  return {
    service: row.service_code,
    name: row.service_name,
    state: row.state,
    confirmed: row.verification === 'VERIFIED',
    verification: row.verification,
    minutesOld: row.minutes_old,
    stale: row.stale,
    reportedAt: row.created_at,
    reporterRole: row.reporter_role,
  };
}

function loginPage(error?: string): string {
  const numbers = all<{ msisdn: string; name: string; role: string }>(
    `SELECT msisdn, name, role FROM app_users WHERE role IN ('SUPERVISOR','ADMIN') AND active = 1`,
  );
  return `
${error ? `<div class="notice bad">${escape(error)}</div>` : ''}
<div class="login-shell">
  <div class="login-copy">
    <span class="eyebrow">Know before you go</span>
    <h2>Local services.<br>Clearer journeys.</h2>
    <p>One shared view of facility availability, community reports, and supervisor confirmations.</p>
  </div>
  <section class="card login-card">
    <h2>Sign in</h2>
    <form method="post" action="/login">
    <div class="account-field">
      <span class="login-field-label">Phone number</span>
      <details class="account-picker">
        <summary><span data-account-label>${numbers[0] ? `${escape(numbers[0].name)} · ${escape(numbers[0].role)}` : 'Select an account'}</span></summary>
        <div class="account-options">
          ${numbers.map((n, index) => `<label class="account-option"><input type="radio" name="msisdn" value="${escape(n.msisdn)}" ${index === 0 ? 'checked' : ''} required><span class="account-option-copy"><strong>${escape(n.name)}</strong><small>${escape(n.role)} · ${escape(n.msisdn)}</small></span></label>`).join('')}
        </div>
      </details>
    </div>
    <label>PIN <input type="password" name="pin" placeholder="Enter your PIN" required></label>
    <button type="submit">Sign in</button>
  </form>
    <p class="muted">Demo accounts use the configured <code>ADMIN_PIN</code>. Change the default before deployment.</p>
  </section>
</div>
<script>
document.querySelectorAll('.account-picker input[name="msisdn"]').forEach((input) => {
  input.addEventListener('change', () => {
    const picker = input.closest('.account-picker');
    const option = input.closest('.account-option');
    const summary = picker?.querySelector('[data-account-label]');
    const name = option?.querySelector('strong')?.textContent?.trim();
    const role = option?.querySelector('small')?.textContent?.split(' · ')[0]?.trim();
    if (summary && name && role) summary.textContent = name + ' · ' + role;
    if (picker) picker.open = false;
  });
});
</script>`;
}

function kpiStrip(): string {
  const k = kpis();
  const cells: [string, string | number][] = [
    ['Facilities live', k.facilities],
    ['Updates (30 days)', k.updates30d],
    ['Citizen queries', k.queriesTotal],
    ['Query answer rate', `${k.answerRate}%`],
    ['Awaiting verification', k.pendingVerification],
    ['Critical verified', `${k.verifiedRate}%`],
    ['Trips avoided', `${k.avoidedTripRate}%`],
    ['SMS delivered', `${k.delivered}/${k.outbound}`],
    ['Stale updates', k.staleUpdates],
  ];
  return `<div class="grid kpis">${cells
    .map(([label, value]) => `<div class="kpi"><span>${escape(label)}</span><b>${escape(value)}</b></div>`)
    .join('')}</div>`;
}

function boardPage(): string {
  const facilities = all<Facility>('SELECT * FROM facilities WHERE active = 1 ORDER BY category, code');
  const groups = new Map<string, string[]>();
  for (const facility of facilities) {
    const rows = facilityStatusBoard(facility.id) as BoardRow[];
    const line = rows.length
      ? rows
          .map(
            (row) =>
              `<div><span class="pill ${row.state}">${escape(row.state)}</span> ${escape(row.service_name)}` +
              ` <span class="muted">${row.minutes_old}m${row.stale ? ' &middot; may be out of date' : ''}</span>` +
              `${row.verification === 'PENDING' ? ' <span class="pill PENDING">unconfirmed</span>' : ''}</div>`,
          )
          .join('')
      : `<span class="muted">No reports yet</span>`;
    groups.set(facility.category, [
      ...(groups.get(facility.category) ?? []),
      `<tr><td><a href="/facilities/${escape(facility.code)}">${escape(facility.name)}</a><br><span class="muted">${escape(facility.code)} &middot; ${escape(facility.parish)}</span></td><td>${line}</td></tr>`,
    ]);
  }

  const pending = pendingVerifications();
  return `
<section class="board-hero">
  <div>
    <span class="eyebrow">Service availability network</span>
    <h2>Know before<br>you make the trip.</h2>
    <p>Current reports from local health facilities and public offices, all in one place.</p>
    <div class="hero-links"><a href="/facilities">Explore facilities</a><a class="secondary" href="/simulator">Open phone simulator</a></div>
  </div>
  <div class="hero-stat"><strong>${kpis().facilities}</strong><span>active facilities<br>sharing local updates</span></div>
</section>
${kpiStrip()}
${pending.length ? `<div class="notice warn notice-spaced">${pending.length} report(s) awaiting supervisor confirmation. <a href="/verify">Open queue</a></div>` : ''}
${[...groups.entries()]
  .map(
    ([category, rows]) => `<h2>${escape(CATEGORY_LABEL[category] ?? category)}</h2>
<div class="card"><table><thead><tr><th class="facility-name-col">Facility</th><th>Latest status</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`,
  )
  .join('')}
<p class="muted">Citizens dial *${escape(config.shortCode)}# or message ${escape(config.shortCode)}. This board reflects the same status information.</p>`;
}

function facilitiesPage(role: string): string {
  const rows = coverage();
  return `<section class="board-hero">
  <div><span class="eyebrow">Network coverage</span><h2>Every site has a signal.</h2>
  <p>See which facilities are reporting and where fresh updates are still needed.</p></div>
  <div class="hero-stat"><strong>${rows.length}</strong><span>active facilities<br>in the network</span></div>
</section>
<div class="facility-toolbar"><h2>Reporting coverage</h2>${role === 'ADMIN' ? '<a class="button-link" href="/facilities/new">Add facility</a>' : ''}</div>
<div class="card"><table><thead><tr><th>Code</th><th>Facility</th><th>District</th><th>Services tracked</th><th>Services reported</th><th>Last report</th>${role === 'ADMIN' ? '<th>Manage</th>' : ''}</tr></thead><tbody>
${rows
  .map(
    (row) =>
      `<tr><td><a href="/facilities/${escape(row.code)}">${escape(row.code)}</a></td><td>${escape(row.name)}</td><td>${escape(row.district)}</td><td>${row.services}</td><td>${row.reported}</td><td>${
        row.minutes_since_last === null ? '<span class="muted">never</span>' : `${row.minutes_since_last}m ago`
      }</td>${role === 'ADMIN' ? `<td><div class="management-actions"><a href="/facilities/${escape(row.code)}/edit">Edit</a><a href="/facilities/${escape(row.code)}/archive">Delete</a></div></td>` : ''}</tr>`,
  )
  .join('')}
</tbody></table></div>
<p class="muted">"Services reported" below "Services tracked" is the silence signal: those sites need volunteer training.</p>`;
}

function availableFacilityServices(): ServiceType[] {
  return all<ServiceType>(
    `SELECT DISTINCT s.* FROM service_types s
     JOIN facility_services fs ON fs.service_code = s.code
     JOIN facilities f ON f.id = fs.facility_id
     WHERE f.active = 1 ORDER BY s.name`,
  );
}

function readFacilityForm(body: Record<string, string>, facility?: Facility): FacilityFormValues {
  return {
    code: facility?.code ?? String(body.code ?? '').trim().toUpperCase(),
    name: String(body.name ?? facility?.name ?? '').trim(),
    district: String(body.district ?? facility?.district ?? '').trim(),
    parish: String(body.parish ?? facility?.parish ?? '').trim(),
    category: String(body.category ?? facility?.category ?? 'HEALTH').trim().toUpperCase(),
    serviceCodes: Object.entries(body)
      .filter(([key, value]) => key.startsWith('service_') && value === '1')
      .map(([key]) => key.slice('service_'.length)),
  };
}

function validateFacilityForm(values: FacilityFormValues, services: ServiceType[], facilityId?: number): string | undefined {
  if (!/^[A-Z0-9]{2,16}$/.test(values.code)) return 'Use a facility code with 2 to 16 letters or numbers.';
  if (!values.name || !values.district || !values.parish) return 'Name, district, and parish are required.';
  if (!(FACILITY_CATEGORIES as readonly string[]).includes(values.category)) return 'Choose Health or Government office.';
  if (values.serviceCodes.length === 0) return 'Select at least one service.';

  const validServices = new Set(services.map((service) => service.code));
  if (values.serviceCodes.some((code) => !validServices.has(code))) return 'One or more selected services are invalid.';
  const duplicate = get<{ id: number }>('SELECT id FROM facilities WHERE code = ?', values.code);
  if (duplicate && duplicate.id !== facilityId) return 'That facility code is already in use.';
  return undefined;
}

function facilityFormPage(
  values: FacilityFormValues,
  services: ServiceType[],
  action: string,
  submitLabel: string,
  error?: string,
): string {
  return `${error ? `<div class="notice bad notice-spaced">${escape(error)}</div>` : ''}
<section class="facility-form-shell">
  <div class="facility-form-heading"><span class="eyebrow">Facility administration</span><h2>${escape(submitLabel)}</h2>
    <p class="muted">Manage the facility identity, location, category, and tracked services.</p></div>
  <form class="card facility-form" method="post" action="${escape(action)}">
    <div class="facility-form-grid">
      <label>Facility code<input name="code" value="${escape(values.code)}" placeholder="CLINIC4" ${values.code ? 'readonly' : ''} required></label>
      <label>Facility name<input name="name" value="${escape(values.name)}" placeholder="Central Health Centre" required></label>
      <label>District<input name="district" value="${escape(values.district)}" placeholder="Wakiso" required></label>
      <label>Parish<input name="parish" value="${escape(values.parish)}" placeholder="Kigungu" required></label>
      <label>Category<select name="category" required>
        ${FACILITY_CATEGORIES.map((category) => `<option value="${category}" ${values.category === category ? 'selected' : ''}>${escape(CATEGORY_LABEL[category])}</option>`).join('')}
      </select></label>
    </div>
    <fieldset class="service-choices"><legend>Services available here</legend>
      <div class="service-choice-list">${services.map((service) => `<label class="service-choice"><input type="checkbox" name="service_${escape(service.code)}" value="1" ${values.serviceCodes.includes(service.code) ? 'checked' : ''}><span>${escape(service.name)}</span></label>`).join('')}</div>
    </fieldset>
    <div class="facility-form-actions"><a class="button-link button-light" href="/facilities">Cancel</a><button class="button-accent" type="submit">${escape(submitLabel)}</button></div>
  </form>
</section>`;
}

function archiveFacilityPage(facility: Facility): string {
  return `<section class="facility-form-shell">
  <div class="facility-form-heading"><span class="eyebrow">Facility administration</span><h2>Delete ${escape(facility.name)}?</h2>
    <p class="muted">This removes the facility from active dashboards and citizen lookups. Historical reports are retained.</p></div>
  <div class="card archive-panel"><p><strong>${escape(facility.code)}</strong> · ${escape(facility.parish)}, ${escape(facility.district)}</p>
    <div class="facility-form-actions"><a class="button-link button-light" href="/facilities">Cancel</a>
      <form method="post" action="/facilities/${encodeURIComponent(facility.code)}/delete"><button class="button-danger" type="submit">Delete facility</button></form>
    </div>
  </div>
</section>`;
}

function facilityPage(facility: Facility, role: string): string {
  const rows = facilityStatusBoard(facility.id) as BoardRow[];
  const history = all<StatusUpdate & { service_code: string }>(
    `SELECT * FROM status_updates WHERE facility_id = ? ORDER BY created_at DESC, id DESC LIMIT 20`,
    facility.id,
  );
  const services = all<ServiceType>(
    `SELECT s.* FROM service_types s JOIN facility_services fs ON fs.service_code = s.code WHERE fs.facility_id = ?`,
    facility.id,
  );
  const reporters = all<{ name: string; msisdn: string; role: string }>(
    `SELECT name, msisdn, role FROM app_users WHERE facility_id = ?`,
    facility.id,
  );

  const actions = role === 'ADMIN'
    ? `<div class="management-actions"><a href="/facilities/${encodeURIComponent(facility.code)}/edit">Edit</a><a href="/facilities/${encodeURIComponent(facility.code)}/archive">Delete</a></div>`
    : '';
  return `<div class="facility-toolbar"><h2>${escape(facility.name)}</h2>${actions}</div>
<div class="card">
  <p>${escape(facility.code)} &middot; ${escape(facility.parish)}, ${escape(facility.district)} &middot; ${escape(facility.category)}</p>
  <p class="muted">Coded report syntax: <code>${escape(facility.code)} ${escape(services[0]?.code ?? 'VACCINE')} YES</code></p>
  ${reporters.length ? `<p>Registered reporters: ${reporters.map((r) => `${escape(r.name)} (${escape(r.role)}) ${escape(r.msisdn)}`).join(', ')}</p>` : '<p class="muted">No registered reporters linked to this facility.</p>'}
</div>
<h2>Current status</h2>
<div class="card"><table><thead><tr><th>Service</th><th>State</th><th>Verification</th><th>Age</th><th>Source</th></tr></thead><tbody>
${rows
  .map(
    (row) =>
      `<tr><td>${escape(row.service_name)}</td><td><span class="pill ${row.state}">${escape(row.state)}</span>${row.stale ? '<div class="stale">may be out of date</div>' : ''}</td>` +
      `<td><span class="pill ${row.verification}">${escape(row.verification)}</span></td><td>${row.minutes_old}m</td>` +
      `<td class="muted">${escape(row.channel)} ${escape(row.source_msisdn)}</td></tr>`,
  )
  .join('') || '<tr><td colspan="5" class="muted">No status yet</td></tr>'}
</tbody></table></div>
<h2>Recent reports</h2>
<div class="card"><table><thead><tr><th>When</th><th>Service</th><th>State</th><th>Raw message</th><th>Verification</th></tr></thead><tbody>
${history
  .map(
    (row) =>
      `<tr><td class="muted">${escape(row.created_at.replace('T', ' ').slice(0, 16))}</td><td>${escape(row.service_code)}</td>` +
      `<td><span class="pill ${row.state}">${escape(row.state)}</span></td><td><code>${escape(row.raw_message)}</code></td>` +
      `<td><span class="pill ${row.verification}">${escape(row.verification)}</span>${row.reject_reason ? `<div class="stale">${escape(row.reject_reason)}</div>` : ''}</td></tr>`,
  )
  .join('') || '<tr><td colspan="5" class="muted">Nothing recorded</td></tr>'}
</tbody></table></div>`;
}

function verifyPage(role: string, notice?: string): string {
  if (role !== 'SUPERVISOR' && role !== 'ADMIN') {
    return `<div class="notice warn">Signed in as ${escape(role)}. Verification needs a supervisor account.</div>`;
  }
  const pending = pendingVerifications() as BoardRow[];
  return `
${notice ? `<div class="notice">${escape(notice)}</div>` : ''}
<section class="board-hero">
  <div><span class="eyebrow">Trust & confirmation</span><h2>Reports, checked<br>by local supervisors.</h2>
  <p>Confirm critical service updates or reject a report with a reason for the reporter.</p></div>
  <div class="hero-stat"><strong>${pending.length}</strong><span>reports waiting<br>for confirmation</span></div>
</section>
<h2>Awaiting confirmation</h2>
<div class="card"><table><thead><tr><th>#</th><th>Facility</th><th>Service</th><th>Claimed</th><th>Reporter</th><th>Age</th><th>Decision</th></tr></thead><tbody>
${pending
  .map(
    (row) =>
      `<tr><td>${row.id}</td><td>${escape(row.facility_name)} (${escape(row.facility_code)})</td><td>${escape(row.service_name)}</td>` +
      `<td><span class="pill ${row.state}">${escape(row.state)}</span></td>` +
      `<td class="muted">${escape(row.reporter_role)}<br>${escape(row.source_msisdn)}</td><td>${row.minutes_old}m</td>` +
      `<td><form method="post" action="/verify/${row.id}" class="inline">
           <button name="decision" value="approve" type="submit">Confirm</button>
           <input name="reason" placeholder="reason if rejecting" size="14">
           <button name="decision" value="reject" type="submit">Reject</button>
         </form></td></tr>`,
  )
  .join('') || '<tr><td colspan="7" class="muted">Queue is clear</td></tr>'}
</tbody></table></div>
<p class="muted">Supervisors can also reply by SMS from their own handset: <code>OK ${pending[0]?.id ?? '{id}'}</code> or <code>NO ${pending[0]?.id ?? '{id}'} staff on training</code>.</p>`;
}

function messagesPage(): string {
  const messages = all<OutboundMessage & { raw?: string }>(
    `SELECT * FROM messages ORDER BY id DESC LIMIT 120`,
  );
  return `<section class="board-hero">
  <div><span class="eyebrow">Message activity</span><h2>Every update,<br>accounted for.</h2>
  <p>Review incoming reports, outbound replies, delivery state, and retry history.</p></div>
  <div class="hero-stat"><strong>${messages.length}</strong><span>recent messages<br>in this log</span></div>
</section>
<h2>Inbound and outbound traffic</h2>
<div class="card"><table><thead><tr><th>When</th><th>Dir</th><th>Number</th><th>Body</th><th>Status</th><th>Try</th></tr></thead><tbody>
${messages
  .map(
    (row) =>
      `<tr><td class="muted">${escape(row.created_at.replace('T', ' ').slice(0, 19))}</td><td>${escape(row.direction)}</td>` +
      `<td>${escape(row.msisdn)}</td><td><code>${escape(row.body.slice(0, 120))}</code></td>` +
      `<td><span class="pill ${row.status}">${escape(row.status)}</span>${row.error ? `<div class="stale">${escape(row.error)}</div>` : ''}</td>` +
      `<td>${row.attempts}</td></tr>`,
  )
  .join('') || '<tr><td colspan="6" class="muted">No traffic yet. Use the simulator.</td></tr>'}
</tbody></table></div>`;
}

function analyticsPage(): string {
  const k = kpis();
  const months = monthly();
  const split = channelSplit();
  return `<section class="board-hero">
  <div><span class="eyebrow">Service network insights</span><h2>Small signals.<br>Better decisions.</h2>
  <p>Coverage, response, and trust indicators from the activity recorded across the network.</p></div>
  <div class="hero-stat"><strong>${k.updates30d}</strong><span>updates in the<br>last 30 days</span></div>
</section>
${kpiStrip()}
<h2>Proposal KPIs</h2>
<div class="card"><table><tbody>
<tr><td>Updates submitted per month</td><td><b>${k.updates30d}</b></td></tr>
<tr><td>Successful status queries</td><td><b>${k.queriesAnswered}</b> of ${k.queriesTotal} (${k.answerRate}%)</td></tr>
<tr><td>Users reporting an avoided journey</td><td><b>${k.avoidedTrips}</b> of ${k.tripResponses} answers (${k.avoidedTripRate}%)</td></tr>
<tr><td>Critical updates verified by supervisor</td><td><b>${k.verifiedRate}%</b>, ${k.pendingVerification} pending</td></tr>
<tr><td>Outbound confirmations delivered</td><td><b>${k.delivered}</b> of ${k.outbound}, ${k.failed} failed</td></tr>
</tbody></table></div>
<h2>By month</h2>
<div class="card"><table><thead><tr><th>Month</th><th>Updates</th><th>Queries</th></tr></thead><tbody>
${months.map((row) => `<tr><td>${escape(row.month)}</td><td>${row.updates}</td><td>${row.queries}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No activity</td></tr>'}
</tbody></table></div>
<h2>Channel mix</h2>
<div class="card"><table><thead><tr><th>Channel</th><th>Queries</th></tr></thead><tbody>
${split.map((row) => `<tr><td>${escape(row.channel)}</td><td>${row.count}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">None</td></tr>'}
</tbody></table></div>
<p class="muted">Trust/satisfaction scores from the proposal need the pilot survey; this MVP records the behavioural proxies only.</p>`;
}

function simulatorPage(query: URLSearchParams): string {
  const numbers = all<{ msisdn: string; name: string; role: string }>(
    `SELECT msisdn, name, role FROM app_users WHERE active = 1 ORDER BY role, name`,
  );
  const screen = query.get('screen') ?? `Dial *${config.shortCode}# and press Send to start a USSD session.`;
  const log = query.get('log') ?? '';
  const kind = query.get('kind');
  const msisdn = query.get('msisdn') ?? '+256701234567';
  const sessionOpen = Boolean(query.get('open'));
  return `
<section class="board-hero">
  <div><span class="eyebrow">Test the citizen experience</span><h2>Try the service<br>from a handset.</h2>
  <p>SMS reports and USSD menus, shown as citizens receive them.</p></div>
  <div class="hero-stat"><strong>*${escape(config.shortCode)}#</strong><span>USSD short code<br>configured here</span></div>
</section>
<div class="simulator-layout">
<section class="card simulator-panel">
  <div class="simulator-panel-head"><div><span class="simulator-overline">Message channel</span><h2>SMS handset</h2></div>
    <span class="simulator-badge">${escape(kind ?? 'READY')}</span></div>
  <form method="post" action="/simulator" class="simulator-form">
    <input type="hidden" name="mode" value="sms">
    <label>From
      <select name="msisdn">
        ${numbers.map((n) => `<option value="${escape(n.msisdn)}" ${n.msisdn === msisdn ? 'selected' : ''}>${escape(n.name)} (${escape(n.role)})</option>`).join('')}
      </select>
    </label>
    <label>Message <input name="text" placeholder="CLINIC1 VACCINE YES" value="${escape(query.get('text') ?? 'CLINIC1 VACCINE YES')}"></label>
    <div class="quick-actions">
      <button type="submit" class="button-accent">Send SMS</button>
      <button type="submit" class="button-light" name="text" value="HELP">Try HELP</button>
      <button type="submit" class="button-light" name="text" value="CHECK CLINIC1">Check CLINIC1</button>
    </div>
  </form>
  ${log ? `<pre class="phone">${escape(log)}</pre>` : '<p class="simulator-note">The SMS reply will appear here after you send a message.</p>'}
  ${kind ? `<p class="simulator-note">Classified as <span class="pill VERIFIED">${escape(kind)}</span>; reply queued through the gateway.</p>` : ''}
</section>

<section class="card simulator-panel">
  <div class="simulator-panel-head"><div><span class="simulator-overline">Interactive channel</span><h2>USSD session</h2></div>
    <span class="simulator-badge">${sessionOpen ? 'SESSION OPEN' : 'NEW SESSION'}</span></div>
  <div class="ussd-device">
    <div class="ussd-device-head"><span>ServiceAlert</span><span>*${escape(config.shortCode)}#</span></div>
    <pre class="phone">${escape(screen)}</pre>
  </div>
  <form method="post" action="/simulator" class="simulator-form ussd-controls">
    <input type="hidden" name="mode" value="ussd">
    <input type="hidden" name="sessionId" value="${escape(query.get('sessionId') ?? '')}">
    <input type="hidden" name="open" value="${escape(query.get('open') ?? '')}">
    <select name="msisdn">
      ${numbers.map((n) => `<option value="${escape(n.msisdn)}" ${n.msisdn === msisdn ? 'selected' : ''}>${escape(n.name)}</option>`).join('')}
    </select>
    <input name="text" inputmode="numeric" aria-label="USSD menu choice" placeholder="1" value="${escape(query.get('input') ?? '1')}">
    <button type="submit" class="button-accent wide">Send menu choice</button>
    ${sessionOpen ? '<button type="submit" class="button-light wide" name="text" value="###">End session</button>' : ''}
  </form>
</section>
</div>

<section class="gateway-bar">
  <div><h2>Outbound queue</h2>
  <p>Retry queued messages. Simulated failures can be set with <code>SIM_FAILURE_RATE</code>.</p></div>
  <form method="post" action="/simulator">
    <input type="hidden" name="mode" value="flush">
    <input type="hidden" name="msisdn" value="${escape(msisdn)}">
    <button type="submit" class="button-accent">Retry queued messages</button>
  </form>
</section>`;
}
