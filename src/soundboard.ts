import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { session } from './accounts';
import { body, fail, ok, only } from './http';
import { soundboardNotifications as notifications } from './schema';
import type { Env } from './worker';

export async function soundboardRoute(request: Request, env: Env, path: string[]): Promise<Response> {
  const ack = path.length === 4 && path[3] === 'ack';
  if (path[2] !== 'notifications' || !(path.length === 3 || ack)) fail(404, 'not_found');
  if (request.method !== (ack ? 'POST' : 'GET')) fail(405, 'method_not_allowed');
  const user = (await session(request, env))!;
  const db = drizzle(env.DB);
  const ownedUnread = and(eq(notifications.userId, user.id), isNull(notifications.readAt));
  if (!ack) {
    const rows = await db.select({ id: notifications.id, sound_name: notifications.soundName,
      status: notifications.status, reason: notifications.reason }).from(notifications)
      .where(ownedUnread).orderBy(asc(notifications.createdAt), asc(notifications.id));
    return ok({ notifications: rows });
  }
  if (!(await env.WRITE_LIMITER.limit({ key: user.id })).success) fail(429, 'rate_limited');
  const value = await body(request); only(value, 'ids');
  // Bound the batch below D1's SQL parameter limit, including user/timestamp.
  const ids = value.ids;
  if (!Array.isArray(ids) || ids.length > 50 ||
      ids.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0))
    fail(400, 'invalid_notification_ids');
  if (ids.length) await db.update(notifications).set({ readAt: Date.now() })
    .where(and(ownedUnread, inArray(notifications.id, [...new Set(ids)])));
  return ok({ success: true });
}
