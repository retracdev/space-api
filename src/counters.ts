import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { fail } from './http';
import { counters } from './schema';
import type { Env } from './worker';

export async function counterRoute(request: Request, env: Env, path: string[]): Promise<Response> {
  if (path.length !== 4 || !['get', 'increment'].includes(path[2])) fail(404, 'not_found');
  const increment = path[2] === 'increment';
  if (request.method !== (increment ? 'POST' : 'GET')) fail(405, 'method_not_allowed');
  let name: string;
  try { name = decodeURIComponent(path[3]); }
  catch { fail(400, 'invalid_counter_name'); }
  if (!name || /[^a-zA-Z0-9_-]/.test(name)) fail(400, 'invalid_counter_name');

  // One UPSERT ... RETURNING statement creates or updates and reads atomically.
  // Adding zero on GET preserves an existing value, including concurrent increments.
  const delta = increment ? 1 : 0;
  const counter = await drizzle(env.DB).insert(counters).values({ name, count: delta })
    .onConflictDoUpdate({ target: counters.name, set: { count: sql`${counters.count} + ${delta}` } })
    .returning().get();
  if (!counter) fail(503, 'service_unavailable');
  return Response.json(counter);
}
