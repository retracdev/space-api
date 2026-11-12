import { and, eq, sql, asc, desc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { games, boards, saves, scores } from './schema';
import { session, directory, type AccountEnv } from './accounts';
import { ApiError, fail, ok, body, only, identifier, integer } from './http';
import { storageRoute } from './storage';
import { soundboardRoute } from './soundboard';
import { counterRoute } from './counters';
import { presenceRoute, cleanupPresence } from './presence';

export interface Env extends AccountEnv {
  DB: D1Database;
  ALLOWED_ORIGINS: string;
  WRITE_LIMITER: RateLimit;
  REQUEST_LIMITER: RateLimit;
  // R2 bucket `space-storage`, bound manually in Cloudflare. See docs/storage.md.
  SPACE_STORAGE?: R2Bucket;
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.split('/').filter(Boolean);
  const method = request.method;
  if (path[0] !== 'v1') fail(404, 'not_found');
  if (!['GET', 'PUT', 'POST', 'DELETE'].includes(method)) fail(405, 'method_not_allowed');
  // Public counters intentionally bypass both application rate-limit bindings.
  if (path[1] === 'counters') return counterRoute(request, env, path);
  // Public presence never uses account services, IP addresses, or rate-limit bindings.
  if (path[1] === 'presence') return presenceRoute(request, env, path);
  if (!(await env.REQUEST_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' })).success)
    fail(429, 'rate_limited');
  const db = drizzle(env.DB);
  if (path.length === 2 && path[1] === 'health' && method === 'GET') return ok({ status: 'ok' });
  if (path.length === 2 && path[1] === 'session' && method === 'GET') {
    const user = await session(request, env, true);
    return ok({ authenticated: !!user, player: user });
  }
  if (path.length === 4 && path[1] === 'players' && path[2] === 'id') {
    if (method !== 'GET') fail(405, 'method_not_allowed');
    let userId: string;
    try { userId = decodeURIComponent(path[3]); }
    catch { fail(400, 'invalid_user_id'); }
    if (!userId || userId.length > 256) fail(400, 'invalid_user_id');
    const user = (await directory(env, { ids: [userId] }))[0];
    if (!user?.username) fail(404, 'player_not_found');
    return ok({ username: user.username });
  }
  if (path.length === 3 && path[1] === 'players' && method === 'GET') {
    if (path[2] !== 'me' && !/^[a-zA-Z0-9_]{3,20}$/.test(path[2])) fail(400, 'invalid_username');
    const user = path[2] === 'me' ? await session(request, env) :
      (await directory(env, { username: path[2].toLowerCase() }))[0];
    if (!user?.username) fail(404, 'player_not_found');
    const bests = await db.select({ gameId: scores.gameId, leaderboardId: scores.boardId, score: scores.score })
      .from(scores).where(eq(scores.userId, user.id));
    return ok(path[2] === 'me' ? { id: user.id, username: user.username, personalBests: bests } :
      { username: user.username, personalBests: bests });
  }
  if (path[1] === 'storage') return storageRoute(request, env, path, url);
  if (path[1] === 'soundboard') return soundboardRoute(request, env, path);
  if (path[1] !== 'games') fail(404, 'not_found');
  if (path.length === 2 && method === 'GET') return ok(await db.select().from(games));
  if (!path[2]) fail(404, 'not_found');
  const gameId = identifier(path[2]);
  const game = await db.select().from(games).where(eq(games.id, gameId)).get();
  if (!game) fail(404, 'game_not_found');
  if (path.length === 3 && method === 'GET') {
    return ok({ ...game, leaderboards: await db.select().from(boards).where(eq(boards.gameId, gameId)) });
  }
  if (path[3] === 'saves' && (path.length === 4 || path.length === 5)) {
    const user = (await session(request, env))!;
    const owned = and(eq(saves.userId, user.id), eq(saves.gameId, gameId));
    if (path.length === 4 && method === 'GET') return ok(await db.select({ slot: saves.slot, updatedAt: saves.updatedAt })
      .from(saves).where(owned).orderBy(asc(saves.slot)));
    if (path.length !== 5 || !['GET', 'PUT', 'DELETE'].includes(method)) fail(405, 'method_not_allowed');
    const slot = integer(path[4], 0, 0, game.saveSlots - 1);
    const where = and(owned, eq(saves.slot, slot));
    if (method === 'GET') {
      const save = await db.select({ slot: saves.slot, data: saves.data, updatedAt: saves.updatedAt }).from(saves).where(where).get();
      if (!save) fail(404, 'save_not_found');
      return ok(save);
    }
    await writeLimit(env, user.id);
    if (method === 'DELETE') { await db.delete(saves).where(where); return ok({ deleted: true }); }
    const value = await body(request); only(value, 'data');
    if (value.data === null || typeof value.data !== 'object') fail(400, 'structured_data_required');
    if (new TextEncoder().encode(JSON.stringify(value.data)).length > 65536) fail(413, 'save_too_large');
    const updatedAt = Date.now();
    await db.insert(saves).values({ userId: user.id, gameId, slot, data: value.data, updatedAt })
      .onConflictDoUpdate({ target: [saves.userId, saves.gameId, saves.slot], set: { data: value.data, updatedAt } });
    return ok({ slot, data: value.data, updatedAt });
  }
  if (path[3] !== 'leaderboards') fail(404, 'not_found');
  if (path.length === 4 && method === 'GET') return ok(await db.select().from(boards).where(eq(boards.gameId, gameId)));
  if (!path[4]) fail(404, 'not_found');
  const boardId = identifier(path[4]);
  const board = await db.select().from(boards).where(and(eq(boards.gameId, gameId), eq(boards.id, boardId))).get();
  if (!board) fail(404, 'leaderboard_not_found');
  const scope = and(eq(scores.gameId, gameId), eq(scores.boardId, boardId));
  // Immutable ID breaks equal-score ties consistently in both query and indexes.
  const rank = async (userId: string, score: number) => {
    const better = board.direction === 'desc' ? sql`${scores.score} > ${score}` : sql`${scores.score} < ${score}`;
    const row = await db.select({ n: sql<number>`count(*)` }).from(scores).where(and(scope,
      sql`(${better} OR (${scores.score} = ${score} AND ${scores.userId} < ${userId}))`)).get();
    return (row?.n ?? 0) + 1;
  };
  if (path.length === 6 && path[5] === 'scores' && method === 'POST') {
    const user = (await session(request, env))!;
    await writeLimit(env, user.id);
    const value = await body(request); only(value, 'score');
    const score = value.score;
    if (typeof score !== 'number' || !Number.isFinite(score) || Math.abs(score) > Number.MAX_SAFE_INTEGER ||
      (board.scoreType === 'integer' && !Number.isSafeInteger(score)) || score < board.minScore || score > board.maxScore)
      fail(400, 'invalid_score');
    const improvement = board.direction === 'desc' ? sql`excluded.score > ${scores.score}` : sql`excluded.score < ${scores.score}`;
    await db.insert(scores).values({ userId: user.id, gameId, boardId, score, achievedAt: Date.now() })
      .onConflictDoUpdate({ target: [scores.gameId, scores.boardId, scores.userId],
        set: { score, achievedAt: Date.now() }, setWhere: improvement });
    const best = (await db.select().from(scores).where(and(scope, eq(scores.userId, user.id))).get())!;
    return ok({ personalBest: best.score, rank: await rank(user.id, best.score) });
  }
  if (path.length === 6 && path[5] === 'me' && method === 'GET') {
    const user = (await session(request, env))!;
    const best = await db.select().from(scores).where(and(scope, eq(scores.userId, user.id))).get();
    return ok(best ? { personalBest: best.score, rank: await rank(user.id, best.score) } : { personalBest: null, rank: null });
  }
  if (path.length === 5 && method === 'GET') {
    const limit = integer(url.searchParams.get('limit'), 25, 1, 100);
    const offset = integer(url.searchParams.get('offset'), 0, 0, 10000);
    const rows = await db.select().from(scores).where(scope)
      .orderBy(board.direction === 'desc' ? desc(scores.score) : asc(scores.score), asc(scores.userId)).limit(limit).offset(offset);
    const users = rows.length ? await directory(env, { ids: rows.map(r => r.userId) }) : [];
    const names = new Map(users.map(u => [u.id, u.username]));
    const entries = rows.flatMap((r, i) => names.get(r.userId) ? [{ rank: offset + i + 1,
      username: names.get(r.userId), score: r.score }] : []);
    return ok({ entries, limit, offset, nextOffset: rows.length === limit ? offset + limit : null });
  }
  fail(404, 'not_found');
}
async function writeLimit(env: Env, userId: string) {
  if (!(await env.WRITE_LIMITER.limit({ key: userId })).success) fail(429, 'rate_limited');
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await cleanupPresence(env.DB);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const path = new URL(request.url).pathname.split('/').filter(Boolean);
    const publicSiteOrigin = path[0] === 'v1' && ['counters', 'presence'].includes(path[1]) &&
      /^https:\/\/(?:[a-z0-9-]+\.)*retrac\.space$/i.test(origin ?? '');
    const allowed = publicSiteOrigin || env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).includes(origin ?? '');
    let response: Response;
    try {
      if (origin && !allowed) fail(403, 'origin_not_allowed');
      if (request.method === 'OPTIONS') {
        if (!allowed) fail(403, 'origin_not_allowed');
        const headers = (request.headers.get('Access-Control-Request-Headers') ?? '').toLowerCase().split(',').map(h => h.trim()).filter(Boolean);
        if (headers.some(h => !['authorization', 'content-type'].includes(h)) ||
          !['GET', 'PUT', 'POST', 'DELETE'].includes(request.headers.get('Access-Control-Request-Method') ?? '')) fail(403, 'preflight_denied');
        response = new Response(null, { status: 204 });
      } else response = await route(request, env);
    } catch (error) {
      response = Response.json({ error: error instanceof ApiError ? { ...error.details, code: error.code } : { code: 'service_unavailable' } },
        { status: error instanceof ApiError ? error.status : 503 });
    }
    // Only public storage files opt into caching; everything else stays no-store.
    if (!response.headers.has('Cache-Control')) response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Vary', 'Origin');
    if (response.status === 429) response.headers.set('Retry-After', '60');
    if (allowed) {
      response.headers.set('Access-Control-Allow-Origin', origin!);
      response.headers.set('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.headers.set('Access-Control-Max-Age', '600');
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
