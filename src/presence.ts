import { fail, readBytes } from './http';
import type { Env } from './worker';

export const PRESENCE_TTL_MS = 90_000;
export const ANONYMOUS_ANIMALS = [
  'Fox', 'Panda', 'Otter', 'Penguin', 'Koala', 'Dolphin', 'Owl', 'Bear',
  'Tiger', 'Lion', 'Wolf', 'Rabbit', 'Deer', 'Raccoon', 'Hedgehog', 'Squirrel',
  'Badger', 'Beaver', 'Moose', 'Elk', 'Bison', 'Yak', 'Alpaca', 'Llama',
  'Camel', 'Giraffe', 'Zebra', 'Elephant', 'Rhino', 'Hippo', 'Gorilla', 'Lemur',
  'Sloth', 'Armadillo', 'Anteater', 'Capybara', 'Wombat', 'Quokka', 'Kangaroo', 'Platypus',
  'Seal', 'Walrus', 'Whale', 'Orca', 'Narwhal', 'Manatee', 'Shark', 'Stingray',
  'Octopus', 'Squid', 'Seahorse', 'Turtle', 'Tortoise', 'Gecko', 'Iguana', 'Chameleon',
  'Frog', 'Axolotl', 'Flamingo', 'Pelican', 'Puffin', 'Toucan', 'Parrot', 'Swan',
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function payload(request: Request, heartbeat: boolean) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    fail(415, 'json_required');
  const bytes = await readBytes(request, 1024, 'body_too_large');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(400, 'invalid_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_body');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => key !== 'visitorId' && !(heartbeat && key === 'username')))
    fail(400, 'invalid_body');
  if (typeof data.visitorId !== 'string' || !uuid.test(data.visitorId)) fail(400, 'invalid_visitor_id');
  let username: string | null = null;
  if (Object.hasOwn(data, 'username')) {
    if (typeof data.username !== 'string') fail(400, 'invalid_username');
    username = data.username.trim();
    if (!username || [...username].length > 40 || /[\u0000-\u001f\u007f-\u009f]/u.test(username))
      fail(400, 'invalid_username');
  }
  return { visitorId: data.visitorId.toLowerCase(), username };
}

export async function presenceRoute(request: Request, env: Env, path: string[]): Promise<Response> {
  if (path.length === 3 && path[2] === 'summary') {
    if (request.method !== 'GET') fail(405, 'method_not_allowed');
    const { results } = await env.DB.prepare(`SELECT site, COUNT(*) AS count FROM presence
      WHERE last_seen > ? GROUP BY site ORDER BY site`).bind(Date.now() - PRESENCE_TTL_MS)
      .all<{ site: string; count: number }>();
    return Response.json({ totalOnline: results.reduce((sum, row) => sum + row.count, 0),
      sites: Object.fromEntries(results.map(row => [row.site, row.count])) });
  }
  if (path.length !== 4 || !['heartbeat', 'online', 'leave'].includes(path[2])) fail(404, 'not_found');
  const action = path[2];
  if (request.method !== (action === 'online' ? 'GET' : 'POST')) fail(405, 'method_not_allowed');
  let site: string;
  try { site = decodeURIComponent(path[3]); }
  catch { fail(400, 'invalid_site'); }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(site)) fail(400, 'invalid_site');

  if (action === 'online') {
    const { results: users } = await env.DB.prepare(`SELECT display_name AS displayName FROM presence
      WHERE site = ? AND last_seen > ? ORDER BY last_seen DESC, visitor_id`)
      .bind(site, Date.now() - PRESENCE_TTL_MS).all<{ displayName: string }>();
    return Response.json({ site, count: users.length, users });
  }
  const { visitorId, username } = await payload(request, action === 'heartbeat');
  if (action === 'leave') {
    await env.DB.prepare('DELETE FROM presence WHERE site = ? AND visitor_id = ?').bind(site, visitorId).run();
    return Response.json({ success: true });
  }
  const now = Date.now();
  // Choose and claim in one atomic write, so concurrent visitors cannot claim
  // the same unused animal. Ignore expired sessions and this visitor's own row.
  // A zero-use name always wins; once exhausted, reuse the least occupied names.
  const row = await env.DB.prepare(`WITH occupied AS MATERIALIZED (
      SELECT display_name, COUNT(*) AS uses FROM presence
      WHERE site = ? AND visitor_id != ? AND last_seen > ? GROUP BY display_name
    ), candidate AS MATERIALIZED (
      SELECT pool.value AS name, COALESCE(occupied.uses, 0) AS uses FROM json_each(?) AS pool
      LEFT JOIN occupied ON occupied.display_name = pool.value
      ORDER BY COALESCE(occupied.uses, 0), random() LIMIT 1
    )
    INSERT INTO presence (site, visitor_id, display_name, last_seen, is_anonymous)
    VALUES (?, ?, COALESCE(?, (SELECT name FROM candidate)), ?, ?)
    ON CONFLICT (site, visitor_id) DO UPDATE SET
    display_name = CASE WHEN ? IS NOT NULL OR (presence.is_anonymous = 1 AND (SELECT uses FROM candidate) = 0 AND
      EXISTS (SELECT 1 FROM occupied WHERE occupied.display_name = presence.display_name))
      THEN excluded.display_name ELSE presence.display_name END,
    is_anonymous = CASE WHEN ? IS NOT NULL THEN 0 ELSE presence.is_anonymous END,
    last_seen = MAX(presence.last_seen, excluded.last_seen)
    RETURNING display_name AS displayName`)
    .bind(site, visitorId, now - PRESENCE_TTL_MS, JSON.stringify(ANONYMOUS_ANIMALS.map(animal => `Anonymous ${animal}`)),
      site, visitorId, username, now, username === null ? 1 : 0, username, username)
    .first<{ displayName: string }>();
  if (!row) fail(503, 'service_unavailable');
  return Response.json({ site, visitorId, displayName: row.displayName, online: true });
}

export async function cleanupPresence(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare('DELETE FROM presence WHERE last_seen <= ?').bind(now - PRESENCE_TTL_MS).run();
}
