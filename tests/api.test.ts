import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
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
