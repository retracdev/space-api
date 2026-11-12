import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import worker, { type Env } from '../src/worker';
import { ANONYMOUS_ANIMALS, cleanupPresence } from '../src/presence';

let mf: Miniflare;
let env: Env;
const visitorId = '550e8400-e29b-41d4-a716-446655440000';
const otherId = '550e8400-e29b-41d4-a716-446655440001';
const origin = 'https://new-site.retrac.space';
const now = 1_800_000_000_000;
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("test")}}',
    compatibilityDate: '2026-07-30', d1Databases: { DB: 'test-presence' } });
  const db = await mf.getD1Database('DB');
  for (const migration of ['0005_presence.sql', '0006_presence_anonymous.sql']) {
    for (const statement of readFileSync(`migrations/${migration}`, 'utf8').split(';').filter(s => s.trim()))
      await db.prepare(statement).run();
  }
  // Any access to account services or either limiter must fail these public requests.
  const limiter = { limit: vi.fn(async () => { throw new Error('unexpected limiter'); }) };
  env = { DB: db as unknown as D1Database, ALLOWED_ORIGINS: '', ACCOUNTS_API_KEY: '',
    WRITE_LIMITER: limiter, REQUEST_LIMITER: limiter };
}, 30000);
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM presence').run();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected account request'); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => { await mf?.dispose(); });

function request(path: string, method = 'GET', value?: unknown, from: string | null = origin) {
  return worker.fetch(new Request('https://api.retrac.space/v1/presence/' + path, {
    method, headers: { ...(from ? { Origin: from } : {}), ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: value === undefined ? undefined : JSON.stringify(value),
  }), env);
}
async function heartbeat(site = 'soundboard', username?: string, id = visitorId) {
  const response = await request('heartbeat/' + site, 'POST', { visitorId: id, ...(username === undefined ? {} : { username }) });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ site: string; visitorId: string; displayName: string; online: boolean }>;
}

describe('public presence with actual local D1', () => {
  const sessionId = (n: number) => `550e8400-e29b-41d4-a716-${String(n).padStart(12, '0')}`;

  it('assigns distinct animals to concurrent visitors until the entire pool is occupied', async () => {
    expect(ANONYMOUS_ANIMALS.length).toBe(64);
    expect(new Set(ANONYMOUS_ANIMALS).size).toBe(64);
    const visitors = await Promise.all(ANONYMOUS_ANIMALS.map((_, i) => heartbeat('soundboard', undefined, sessionId(i))));
    expect(new Set(visitors.map(row => row.displayName)).size).toBe(64);
    const overflow = await heartbeat('soundboard', undefined, sessionId(64));
    expect(visitors.map(row => row.displayName)).toContain(overflow.displayName);
    expect(await heartbeat('soundboard', undefined, sessionId(64))).toEqual(overflow);
    // The pool is independent for every site.
    const separate = await heartbeat('glowstudio');
    expect(visitors.map(row => row.displayName)).toContain(separate.displayName);
  });

  it('reuses freed animals instead of duplicating names after leave or expiry', async () => {
    const visitors = await Promise.all(ANONYMOUS_ANIMALS.map((_, i) => heartbeat('soundboard', undefined, sessionId(i))));
    await request('leave/soundboard', 'POST', { visitorId: sessionId(0) });
    expect((await heartbeat('soundboard', undefined, sessionId(64))).displayName).toBe(visitors[0].displayName);
    await env.DB.prepare('UPDATE presence SET last_seen = ? WHERE visitor_id = ?')
      .bind(now - 90_000, sessionId(1)).run();
    expect((await heartbeat('soundboard', undefined, sessionId(65))).displayName).toBe(visitors[1].displayName);
    // A returning expired visitor must not reclaim an animal that has been reused.
    await request('leave/soundboard', 'POST', { visitorId: sessionId(2) });
    expect((await heartbeat('soundboard', undefined, sessionId(1))).displayName).toBe(visitors[2].displayName);
  });

  it('repairs legacy anonymous collisions while preserving supplied usernames', async () => {
    await env.DB.prepare(`INSERT INTO presence (site, visitor_id, display_name, last_seen, is_anonymous)
      VALUES ('soundboard', ?, 'Anonymous Koala', ?, 1), ('soundboard', ?, 'Anonymous Koala', ?, 1)`)
      .bind(visitorId, now, otherId, now).run();
    const fixed = await heartbeat();
    expect(fixed.displayName).not.toBe('Anonymous Koala');
    expect((await heartbeat('soundboard', undefined, otherId)).displayName).toBe('Anonymous Koala');
    expect(await heartbeat()).toEqual(fixed);
    await heartbeat('soundboard', 'Anonymous Koala');
    expect((await heartbeat()).displayName).toBe('Anonymous Koala');
    // The auto-assigned visitor moves aside for an explicitly supplied label.
    expect((await heartbeat('soundboard', undefined, otherId)).displayName).not.toBe('Anonymous Koala');
  });

  it('creates rooms on first use and persists server-generated anonymous names', async () => {
    expect(await (await request('online/brand-new')).json()).toEqual({ site: 'brand-new', count: 0, users: [] });
    const first = await heartbeat('brand-new');
    expect(first).toEqual({ site: 'brand-new', visitorId, online: true,
      displayName: expect.any(String) });
    expect(ANONYMOUS_ANIMALS.map(animal => `Anonymous ${animal}`)).toContain(first.displayName);
    expect(await heartbeat('brand-new')).toEqual(first);
    expect(await (await request('online/brand-new')).json()).toEqual({ site: 'brand-new', count: 1,
      users: [{ displayName: first.displayName }] });
  });

  it('updates usernames and preserves them when omitted, treating names as text', async () => {
    await heartbeat();
    expect((await heartbeat('soundboard', ' retrac ')).displayName).toBe('retrac');
    expect((await heartbeat()).displayName).toBe('retrac');
    const name = "<b>guest</b> '; DROP TABLE presence; --";
    expect((await heartbeat('soundboard', name)).displayName).toBe(name);
    expect(await (await request('online/soundboard')).json()).toEqual({ site: 'soundboard', count: 1, users: [{ displayName: name }] });
  });

  it('refreshes heartbeats and expires exactly at 90 seconds without read-side writes', async () => {
    await heartbeat();
    vi.mocked(Date.now).mockReturnValue(now + 89_999);
    expect(await (await request('online/soundboard')).json()).toMatchObject({ count: 1 });
    await heartbeat();
    vi.mocked(Date.now).mockReturnValue(now + 179_998);
    expect(await (await request('online/soundboard')).json()).toMatchObject({ count: 1 });
    vi.mocked(Date.now).mockReturnValue(now + 179_999);
    expect(await (await request('online/soundboard')).json()).toMatchObject({ count: 0 });
    expect(await (await request('summary')).json()).toEqual({ totalOnline: 0, sites: {} });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM presence').first('n')).toBe(1);
  });

  it('isolates sites and makes leave idempotent', async () => {
    await heartbeat('soundboard', 'Sound'); await heartbeat('glowstudio', 'Glow');
    expect(await (await request('leave/soundboard', 'POST', { visitorId })).json()).toEqual({ success: true });
    expect(await (await request('leave/soundboard', 'POST', { visitorId })).json()).toEqual({ success: true });
    expect(await (await request('online/soundboard')).json()).toMatchObject({ count: 0 });
    expect(await (await request('online/glowstudio')).json()).toEqual({ site: 'glowstudio', count: 1, users: [{ displayName: 'Glow' }] });
  });

  it('summarizes active site sessions, including one visitor on multiple sites', async () => {
    await heartbeat('soundboard'); await heartbeat('soundboard', 'Other', otherId);
    await heartbeat('glowstudio'); await heartbeat('expired');
    await env.DB.prepare('UPDATE presence SET last_seen = ? WHERE site = ?').bind(now - 90_000, 'expired').run();
    expect(await (await request('summary')).json()).toEqual({ totalOnline: 3, sites: { glowstudio: 1, soundboard: 2 } });
  });

  it('uses atomic upserts for concurrent creation and refreshes', async () => {
    const created = await Promise.all(Array.from({ length: 12 }, () => heartbeat()));
    expect(new Set(created.map(row => row.displayName)).size).toBe(1);
    const updated = await Promise.all(Array.from({ length: 12 }, () => heartbeat('soundboard', 'retrac')));
    expect(updated.every(row => row.displayName === 'retrac')).toBe(true);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM presence').first('n')).toBe(1);
    expect(await (await request('online/soundboard')).json()).toEqual({ site: 'soundboard', count: 1, users: [{ displayName: 'retrac' }] });
  });

  it('normalizes UUID casing and never moves last_seen backwards', async () => {
    await heartbeat('soundboard', undefined, visitorId.toUpperCase());
    vi.mocked(Date.now).mockReturnValue(now - 1000);
    await heartbeat();
    expect(await env.DB.prepare('SELECT last_seen FROM presence').first('last_seen')).toBe(now);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM presence').first('n')).toBe(1);
  });

  it('periodically removes only expired records using the Worker scheduled handler', async () => {
    await heartbeat('expired'); await heartbeat('active');
    await env.DB.prepare('UPDATE presence SET last_seen = ? WHERE site = ?').bind(now - 90_000, 'expired').run();
    await worker.scheduled({} as ScheduledController, env);
    expect((await env.DB.prepare('SELECT site FROM presence').all()).results).toEqual([{ site: 'active' }]);
    await cleanupPresence(env.DB, now + 90_000);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM presence').first('n')).toBe(0);
  });

  it('shares public retrac.space CORS, no-store, and allows requests without an Origin', async () => {
    const response = await request('summary');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await request('summary', 'GET', undefined, null)).status).toBe(200);
    for (const from of ['https://retrac.space.evil.com', 'http://soundboard.retrac.space', 'https://example.com'])
      expect((await request('summary', 'GET', undefined, from)).status).toBe(403);
    const preflight = await worker.fetch(new Request('https://api.retrac.space/v1/presence/heartbeat/new', {
      method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    }), env);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  });

  it('rejects invalid sites, UUIDs, usernames and unexpected fields consistently', async () => {
    for (const site of ['UPPER', 'bad%2Fsite', '%ZZ', 'a'.repeat(65), "x%27%3B--"])
      expect(await (await request('heartbeat/' + site, 'POST', { visitorId })).json()).toEqual({ error: { code: 'invalid_site' } });
    for (const id of ['', 'not-a-uuid', 123, null, visitorId.replace('-41d4-', '-01d4-')])
      expect(await (await request('heartbeat/site', 'POST', { visitorId: id })).json()).toEqual({ error: { code: 'invalid_visitor_id' } });
    for (const username of ['', '  ', 'x'.repeat(41), null, 12, 'bad\u0000name'])
      expect(await (await request('heartbeat/site', 'POST', { visitorId, username })).json()).toEqual({ error: { code: 'invalid_username' } });
    for (const value of [[], null, { visitorId, timestamp: now }, { visitorId, ip: '127.0.0.1' }])
      expect((await request('heartbeat/site', 'POST', value)).status).toBe(400);
    expect((await request('leave/site', 'POST', { visitorId, username: 'ignored' })).status).toBe(400);
    expect((await request('leave/site', 'POST', {})).status).toBe(400);
    expect((await request('heartbeat/site')).status).toBe(405);
    expect((await request('summary', 'POST', {})).status).toBe(405);
    expect((await request('unknown/site')).status).toBe(404);
  });

  it('rejects malformed, oversized and non-JSON bodies before writing', async () => {
    for (const [raw, contentType, status] of [
      ['{', 'application/json', 400], ['{}', 'text/plain', 415],
      [JSON.stringify({ visitorId, username: 'x'.repeat(1100) }), 'application/json', 413],
    ] as const) {
      const response = await worker.fetch(new Request('https://api.retrac.space/v1/presence/heartbeat/site', {
        method: 'POST', headers: { 'Content-Type': contentType }, body: raw,
      }), env);
      expect(response.status).toBe(status);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM presence').first('n')).toBe(0);
  });
});
