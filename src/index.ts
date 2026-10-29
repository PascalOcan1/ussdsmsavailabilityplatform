import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { config, getAtUssdCallbackUrl } from './config.ts';
import { get, openDb } from './db.ts';
import { seedIfEmpty } from './seed.ts';
import { json, readBody, Router, send, type Ctx, type Handler } from './http/util.ts';
import { registerGatewayRoutes } from './http/gateway.ts';
import { registerDashboardRoutes } from './http/dashboard.ts';
import { notifySupervisors, overdueVerifications } from './core/verification.ts';
import { flushQueue } from './gateway.ts';
import type { Facility, ServiceType, State } from './types.ts';

function notFound(ctx: Ctx): void {
  if (ctx.req.method === 'GET' && (ctx.req.headers.accept ?? '').includes('text/html')) {
    send(ctx.res, 404, `<!doctype html><meta charset=utf-8><h2>Not found</h2><p><a href="/">Back to the status board</a>`);
    return;
  }
  json(ctx.res, 404, { status: 'error', error: `no route for ${ctx.req.method} ${ctx.req.url}` });
}

export function createRouter(): Router {
  const router = new Router();
  router.get('/styles.css', (ctx) => {
    send(ctx.res, 200, readFileSync(new URL('./http/styles.css', import.meta.url), 'utf8'), 'text/css; charset=utf-8');
  });
  registerGatewayRoutes(router);
  registerDashboardRoutes(router);
  return router;
}

export function createApp(router = createRouter()): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const match = router.match(req.method ?? 'GET', url.pathname);
    if (!match) return notFound({ req, res, params: {}, query: url.searchParams, body: {} });

    const body = req.method === 'POST' ? await readBody(req) : {};
    const ctx: Ctx = { req, res, params: match.params, query: url.searchParams, body };
    try {
      const outcome = await (match.handler as Handler)(ctx);
      if (typeof outcome === 'string' && !res.headersSent) send(res, 200, outcome);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) json(res, 500, { status: 'error', error: message });
    }
  });
}

/**
 * Keeps the verification loop honest: anything still unconfirmed after the escalation
 * window is chased again, and stalled outbound SMS is retried in the same pass.
 */
export function runEscalation(): { escalated: number; retried: number } {
  const overdue = overdueVerifications(config.verificationEscalateAfterMinutes);
  for (const update of overdue) {
    const facility = get<Facility>('SELECT * FROM facilities WHERE id = ?', update.facility_id);
    const service = get<ServiceType>('SELECT * FROM service_types WHERE code = ?', update.service_code);
    if (!facility || !service) continue;
    notifySupervisors(
      {
        updateId: update.id,
        facilityCode: facility.code,
        serviceName: service.name,
        state: update.state as State,
        sourceMsisdn: update.source_msisdn,
      },
      { reminder: true },
    );
  }
  const queue = flushQueue();
  return { escalated: overdue.length, retried: queue.retried };
}

export function start(): http.Server {
  const atUssdCallbackUrl = getAtUssdCallbackUrl();
  openDb();
  const seeded = seedIfEmpty();
  const server = createApp();
  const timer = setInterval(() => {
    try {
      runEscalation();
    } catch {
      // A failed housekeeping pass must not take the messaging endpoints down.
    }
  }, 5 * 60 * 1000);
  timer.unref();

  server.listen(config.port, config.host, () => {
    const counts = get<{ n: number }>('SELECT COUNT(*) AS n FROM status_updates');
    console.log(`ServiceAlert listening on http://${config.host}:${config.port}`);
    console.log(`  short code: ${config.shortCode}   seeded: ${seeded ? 'yes' : 'no'}   updates: ${counts?.n ?? 0}`);
    console.log(`  dashboard:  http://${config.host}:${config.port}/  (PIN ${config.adminPin} unless ADMIN_PIN is set)`);
    console.log(`  webhooks:   POST /gateway/sms  POST /gateway/ussd  POST /gateway/dlr`);
    console.log(`  AT USSD callback: ${atUssdCallbackUrl ?? 'not configured (set AT_USSD_CALLBACK_URL to a public HTTPS URL)'}`);
  });
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const stop = () => process.exit(0);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  start();
}
