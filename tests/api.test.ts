import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
import worker, { type Env } from '../src/worker';

let mf: Miniflare;
let env: Env;
const origin = 'https://pong.retrac.space';
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("test")}}',
    compatibilityDate: '2026-07-30', d1Databases: { DB: 'test-space-api' } });
  const db = await mf.getD1Database('DB');
  for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(`migrations/${name}`, 'utf8').replaceAll('--> statement-breakpoint', '');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  const limiter = { limit: async () => ({ success: true }) };
  env = { DB: db as unknown as D1Database, ACCOUNTS_API_KEY: 'test-service-key-that-is-at-least-32-characters',
    ALLOWED_ORIGINS: origin, WRITE_LIMITER: limiter, REQUEST_LIMITER: limiter };
}, 30000);
afterAll(async () => { await mf?.dispose(); });
afterEach(() => vi.unstubAllGlobals());

function accounts() {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    expect(input.startsWith('https://accounts.retrac.space/api/internal/games/')).toBe(true);
    expect(new Headers(init.headers).get('Cookie')).toBeNull();
    expect(new Headers(init.headers).get('X-Space-Api-Key')).toBe(env.ACCOUNTS_API_KEY);
    const token = new Headers(init.headers).get('Authorization');
    if (input.endsWith('/session')) return token === 'Bearer revoked' ? new Response(null, { status: 401 }) :
      Response.json({ id: token === 'Bearer bob' ? 'bob-id' : 'alice-id', username: token === 'Bearer bob' ? 'bob' : 'alice' });
    return Response.json([{ id: 'alice-id', username: 'alice_now' }, { id: 'bob-id', username: 'bob' }]
      .filter(u => JSON.parse(init.body as string).ids?.includes(u.id)));
  }));
}
async function request(path: string, method = 'GET', token?: string, value?: unknown) {
  const headers: Record<string, string> = { Origin: origin };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (value !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request('https://api.retrac.space/v1/' + path, {
    method, headers, body: value === undefined ? undefined : JSON.stringify(value),
  }), env);
}
describe('essential v1 behavior with actual local D1', () => {
  it('enforces authentication and keeps optional requests as guests', async () => {
    expect((await request('games/pong/saves')).status).toBe(401);
    expect((await request('games/pong/leaderboards/points/scores', 'POST', undefined, { score: 1 })).status).toBe(401);
    expect(await (await request('session')).json()).toEqual({ data: { authenticated: false, player: null } });
    accounts();
    expect((await request('players/me', 'GET', 'revoked')).status).toBe(401);
  });
  it('isolates save reads, updates and deletion by verified user', async () => {
    accounts(); const path = 'games/pong/saves/0';
    expect((await request(path, 'PUT', 'alice', { data: { level: 3 } })).status).toBe(200);
    expect((await request(path, 'GET', 'bob')).status).toBe(404);
    await request(path, 'PUT', 'bob', { data: { level: 8 } });
    await request(path, 'DELETE', 'bob');
    expect(await (await request(path, 'GET', 'alice')).json()).toMatchObject({ data: { data: { level: 3 } } });
    expect((await request(path, 'PUT', 'bob', { userId: 'alice-id', data: {} })).status).toBe(400);
  });
  it('validates submissions and keeps the highest personal best with current names', async () => {
    accounts(); const path = 'games/pong/leaderboards/points';
    expect((await request(path + '/scores', 'POST', 'alice', { score: -1 })).status).toBe(400);
    expect((await request(path + '/scores', 'POST', 'alice', { score: 2.5 })).status).toBe(400);
    expect((await request(path + '/scores', 'POST', 'alice', { score: 20, userId: 'bob-id' })).status).toBe(400);
    expect((await request(path + '/scores', 'POST', 'alice', { score: 20 })).status).toBe(200);
    await request(path + '/scores', 'POST', 'alice', { score: 10 });
    await request(path + '/scores', 'POST', 'bob', { score: 30 });
    expect(await (await request(path + '/me', 'GET', 'alice')).json()).toEqual({ data: { personalBest: 20, rank: 2 } });
    expect(await (await request(path)).json()).toMatchObject({ data: { entries: [
      { rank: 1, username: 'bob', score: 30 }, { rank: 2, username: 'alice_now', score: 20 },
    ] } });
  });
  it('supports lowest-score boards without changing route code', async () => {
    accounts(); const path = 'games/pong/leaderboards/time';
    await request(path + '/scores', 'POST', 'alice', { score: 10.5 });
    await request(path + '/scores', 'POST', 'alice', { score: 20 });
    expect(await (await request(path + '/me', 'GET', 'alice')).json()).toEqual({ data: { personalBest: 10.5, rank: 1 } });
  });
  it('denies unapproved origins and throttles writes', async () => {
    const denied = await worker.fetch(new Request('https://api.retrac.space/v1/games', { headers: { Origin: 'https://evil.retrac.space' } }), env);
    expect(denied.status).toBe(403);
    expect(denied.headers.has('Access-Control-Allow-Origin')).toBe(false);
    accounts();
    const response = await worker.fetch(new Request('https://api.retrac.space/v1/games/pong/saves/0', {
      method: 'DELETE', headers: { Authorization: 'Bearer alice' },
    }), { ...env, WRITE_LIMITER: { limit: async () => ({ success: false }) } });
    expect(response.status).toBe(429);
  });
});

describe('soundboard notifications with actual local D1', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM soundboard_notifications').run();
    accounts();
  });
  async function notification(userId: string, name: string, status = 'added', reason: string | null = null, createdAt = 1000) {
    const result = await env.DB.prepare(`INSERT INTO soundboard_notifications
      (user_id, sound_name, status, reason, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(userId, name, status, reason, createdAt).run();
    return result.meta.last_row_id;
  }
  const path = 'soundboard/notifications';

  it('requires verified sessions for reads and acknowledgments', async () => {
    for (const [route, method, value] of [[path, 'GET', undefined], [path + '/ack', 'POST', { ids: [1] }]] as const) {
      expect((await request(route, method, undefined, value)).status).toBe(401);
      expect(await (await request(route, method, 'revoked', value)).json())
        .toEqual({ error: { code: 'invalid_session' } });
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    expect(await (await request(path, 'GET', 'alice')).json()).toEqual({ error: { code: 'accounts_unavailable' } });
  });

  it('returns only the caller\'s unread rows, in stable oldest-first order, without acknowledging', async () => {
    const later = await notification('alice-id', 'Later', 'added', null, 2000);
    const first = await notification('alice-id', 'Vine Boom');
    const second = await notification('alice-id', 'Airhorn', 'denied', 'Already exists.');
    await notification('bob-id', 'Private');
    const read = await notification('alice-id', 'Previously read');
    await env.DB.prepare('UPDATE soundboard_notifications SET read_at = 500 WHERE id = ?').bind(read).run();
    const expected = { data: { notifications: [
      { id: first, sound_name: 'Vine Boom', status: 'added', reason: null },
      { id: second, sound_name: 'Airhorn', status: 'denied', reason: 'Already exists.' },
      { id: later, sound_name: 'Later', status: 'added', reason: null },
    ] } };
    expect(await (await request(path, 'GET', 'alice')).json()).toEqual(expected);
    expect(await (await request(path, 'GET', 'alice')).json()).toEqual(expected);
    expect(await (await request(path, 'GET', 'bob')).json()).toMatchObject({ data: { notifications: [{ sound_name: 'Private' }] } });
  });

  it('acknowledges only owned rows, retains history, and preserves read timestamps on retries', async () => {
    const alice = await notification('alice-id', 'Mine');
    const pending = await notification('alice-id', 'Still unread');
    const bob = await notification('bob-id', 'Other user');
    expect(await (await request(path + '/ack', 'POST', 'alice', { ids: [alice, bob, alice, 999999] })).json())
      .toEqual({ data: { success: true } });
    const rows = await env.DB.prepare('SELECT id, read_at FROM soundboard_notifications ORDER BY id').all();
    expect(rows.results).toEqual([
      { id: alice, read_at: expect.any(Number) }, { id: pending, read_at: null }, { id: bob, read_at: null },
    ]);
    await request(path + '/ack', 'POST', 'alice', { ids: [alice] });
    expect((await env.DB.prepare('SELECT id, read_at FROM soundboard_notifications ORDER BY id').all()).results)
      .toEqual(rows.results);
    expect(await (await request(path, 'GET', 'alice')).json())
      .toEqual({ data: { notifications: [{ id: pending, sound_name: 'Still unread', status: 'added', reason: null }] } });
    await request(path + '/ack', 'POST', 'alice', { ids: [pending] });
    expect(await (await request(path, 'GET', 'alice')).json()).toEqual({ data: { notifications: [] } });
    expect(await (await request(path + '/ack', 'POST', 'alice', { ids: [] })).json()).toEqual({ data: { success: true } });
  });

  it('rejects invalid bodies before acknowledging any rows', async () => {
    const id = await notification('alice-id', 'Untouched');
    for (const value of [null, [], {}, { ids: [id], user_id: 'bob-id' }, { ids: '1' },
      { ids: [id, 0] }, { ids: [-1] }, { ids: [1.5] }, { ids: ['1'] }, { ids: [null] },
      { ids: [Number.MAX_SAFE_INTEGER + 1] }, { ids: Array(51).fill(id) }]) {
      expect((await request(path + '/ack', 'POST', 'alice', value)).status).toBe(400);
    }
    const raw = (text: string, contentType?: string) => worker.fetch(new Request('https://api.retrac.space/v1/' + path + '/ack', {
      method: 'POST', headers: { Authorization: 'Bearer alice', ...(contentType ? { 'Content-Type': contentType } : {}) }, body: text,
    }), env);
    expect(await (await raw('{', 'application/json')).json()).toEqual({ error: { code: 'invalid_json' } });
    expect((await raw('{"ids":[]}')).status).toBe(415);
    expect((await raw(' '.repeat(66561), 'application/json')).status).toBe(413);
    expect(await env.DB.prepare('SELECT read_at FROM soundboard_notifications WHERE id = ?').bind(id).first())
      .toEqual({ read_at: null });
  });

  it('uses existing Soundboard CORS and write limits', async () => {
    const soundboardOrigin = 'https://soundboard.retrac.space';
    const soundboardEnv = { ...env, ALLOWED_ORIGINS: soundboardOrigin };
    const response = await worker.fetch(new Request('https://api.retrac.space/v1/' + path, {
      headers: { Origin: soundboardOrigin, Authorization: 'Bearer alice' },
    }), soundboardEnv);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(soundboardOrigin);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const preflight = await worker.fetch(new Request('https://api.retrac.space/v1/' + path + '/ack', {
      method: 'OPTIONS', headers: { Origin: soundboardOrigin, 'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type' },
    }), soundboardEnv);
    expect(preflight.status).toBe(204);
    const limited = await worker.fetch(new Request('https://api.retrac.space/v1/' + path + '/ack', {
      method: 'POST', headers: { Authorization: 'Bearer alice', 'Content-Type': 'application/json' }, body: '{"ids":[]}',
    }), { ...env, WRITE_LIMITER: { limit: async () => ({ success: false }) } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect((await request(path, 'POST', 'alice')).status).toBe(405);
    expect((await request(path + '/ack', 'GET', 'alice')).status).toBe(405);
    expect((await request(path + '/create', 'POST', 'alice')).status).toBe(404);
  });
});
