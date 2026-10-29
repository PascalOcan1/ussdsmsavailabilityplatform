import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';

export interface Session {
  msisdn: string;
  name: string;
  role: string;
}

const sessions = new Map<string, Session>();

export function login(session: Session): string {
  const token = randomUUID();
  sessions.set(token, session);
  return token;
}

export function currentSession(req: IncomingMessage): Session | undefined {
  const cookie = req.headers.cookie ?? '';
  const match = /(?:^|;\s*)sa_session=([0-9a-f-]{36})/.exec(cookie);
  return match ? sessions.get(match[1]) : undefined;
}

export function logout(req: IncomingMessage): void {
  const cookie = req.headers.cookie ?? '';
  const match = /(?:^|;\s*)sa_session=([0-9a-f-]{36})/.exec(cookie);
  if (match) sessions.delete(match[1]);
}

export const escape = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const sessionCookie = (token: string): string =>
  `sa_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;

export function layout(title: string, body: string, opts: { session?: Session; path?: string } = {}): string {
  const { session, path = '/' } = opts;
  const nav = [
    ['/', 'Status board'],
    ['/facilities', 'Facilities'],
    ['/verify', 'Verification queue'],
    ['/messages', 'Message log'],
    ['/analytics', 'Analytics'],
    ['/simulator', 'Phone simulator'],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} - ServiceAlert</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header>
  <h1>ServiceAlert<span class="brand-mark"></span></h1>
  <nav>
    ${nav
      .map(
        ([href, label]) =>
          `<a href="${href}" class="${(href === '/' ? path === '/' : path.startsWith(href)) ? 'on' : ''}">${label}</a>`,
      )
      .join('')}
  </nav>
  <div class="who">
    ${session
      ? `${escape(session.name)} (${escape(session.role)}) &middot; <a href="/logout">Sign out</a>`
      : '<a href="/login">Sign in</a>'}
  </div>
</header>
<main>
<div class="page-topline"><span>Community service network</span><strong>${escape(title)}</strong></div>
${body}
</main>
<footer class="site-footer"><div class="site-footer-inner">
  <div class="footer-brand">ServiceAlert<span></span></div>
  <div class="footer-meta">Offline-first service availability &nbsp; | &nbsp; SMS ${escape(config.shortCode)} &nbsp; | &nbsp; Built for communities</div>
</div></footer>
</body>
</html>`;
}

export type Params = Record<string, string>;

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Params;
  query: URLSearchParams;
  body: Record<string, string>;
  session?: Session;
}

export type Handler = (ctx: Ctx) => void | string | Promise<void | string>;

export interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): void {
    this.routes.push({ method, segments: path.split('/').filter(Boolean), handler });
  }

  get(path: string, handler: Handler): void {
    this.add('GET', path, handler);
  }

  post(path: string, handler: Handler): void {
    this.add('POST', path, handler);
  }

  match(method: string, pathname: string): { handler: Handler; params: Params } | undefined {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Params = {};
      let ok = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const segment = route.segments[index];
        if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(parts[index]);
        else if (segment !== parts[index]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return undefined;
  }
}

export async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 512 * 1024) break;
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/json') && raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]),
      );
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

export function send(res: ServerResponse, status: number, body: string, contentType = 'text/html; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

export function json(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value, null, 2), 'application/json; charset=utf-8');
}

export function redirect(res: ServerResponse, location: string, cookie?: string): void {
  const headers: Record<string, string> = { location };
  if (cookie) headers['set-cookie'] = cookie;
  res.writeHead(303, headers);
  res.end();
}
