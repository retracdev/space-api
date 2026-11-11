import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { storageImages } from './schema';
import { session, type AccountEnv } from './accounts';
import { fail, ok, integer, readBytes } from './http';
import { inspectImage, MAX_IMAGE_BYTES } from './images';

// ---- Centralized storage configuration -------------------------------------
// Temporary testing quota for Glow saves. The intended production limit is 50;
// raising it is a one-line change here and needs no migration.
export const GLOW_MAX_SAVED_IMAGES = 10;

export interface StorageCategory {
  app: string; // application identifier recorded with each image
  prefix: string; // server-controlled R2 key prefix (logical, not a directory)
  maxImagesPerUser: number | null; // per-user quota for this category; null = no quota
}
// Approved categories. Clients pick a category by ID; they never supply paths.
// Add future categories here, e.g. 'users/avatars' with prefix 'users/avatars'.
export const STORAGE_CATEGORIES: ReadonlyMap<string, StorageCategory> = new Map([
  ['glow/saves', { app: 'glow', prefix: 'glow/saves', maxImagesPerUser: GLOW_MAX_SAVED_IMAGES }],
]);
// Unfinished upload reservations stop counting toward quota after this long.
export const RESERVATION_TTL_MS = 10 * 60 * 1000;
// Browser cache lifetime for public files. Deleted images can remain visible in
// a viewer's own browser cache for at most this long; revalidation uses ETags.
export const PUBLIC_IMAGE_MAX_AGE_SECONDS = 300;
// -----------------------------------------------------------------------------

export interface StorageEnv extends AccountEnv {
  DB: D1Database;
  SPACE_STORAGE?: R2Bucket;
  WRITE_LIMITER: RateLimit;
}
type Row = typeof storageImages.$inferSelect;
const ID = /^[0-9a-f]{32}$/;
// Images that occupy quota: ready images plus in-flight (non-expired) reservations.
const active = (cutoffParam: string) => `(status = 'ready' OR (status = 'pending' AND created_at >= ${cutoffParam}))`;

function bucket(env: StorageEnv): R2Bucket {
  if (!env.SPACE_STORAGE) fail(503, 'storage_unavailable');
  return env.SPACE_STORAGE;
}
function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
}
function category(url: URL, required: boolean): (StorageCategory & { id: string }) | null {
  const id = url.searchParams.get('category');
  if (id === null) return required ? fail(400, 'invalid_category') : null;
  const config = STORAGE_CATEGORIES.get(id);
  if (!config) fail(400, 'invalid_category');
  return { id, ...config };
}
function present(row: Pick<Row, 'id' | 'appId' | 'category' | 'mimeType' | 'size' | 'width' | 'height' | 'createdAt'>, origin: string) {
  return { id: row.id, app: row.appId, category: row.category, mimeType: row.mimeType, size: row.size,
    width: row.width, height: row.height, createdAt: row.createdAt, url: `${origin}/v1/storage/files/${row.id}` };
}
async function writeLimit(env: StorageEnv, userId: string) {
  if (!(await env.WRITE_LIMITER.limit({ key: userId })).success) fail(429, 'rate_limited');
}
async function usage(env: StorageEnv, ownerId: string, categoryId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM storage_images WHERE owner_id = ?1 AND category = ?2 AND ${active('?3')}`)
    .bind(ownerId, categoryId, Date.now() - RESERVATION_TTL_MS).first<{ n: number }>();
  return row?.n ?? 0;
}

// Removes a row's R2 object then the row. The row is first claimed as `deleting`
// so it never counts toward quota or gets served again. Failures leave the row
// in `deleting` for a later sweep; nothing is orphaned without a tracking row.
async function purge(env: StorageEnv, store: R2Bucket, id: string, key: string) {
  await store.delete(key);
  await env.DB.prepare(`DELETE FROM storage_images WHERE id = ?1 AND status = 'deleting'`).bind(id).run();
}
async function discard(env: StorageEnv, store: R2Bucket, id: string, key: string) {
  try {
    const claimed = await env.DB.prepare(`UPDATE storage_images SET status = 'deleting' WHERE id = ?1 AND status = 'pending'`).bind(id).run();
    if (claimed.meta.changes === 1) await purge(env, store, id, key);
  } catch { /* expired reservation is excluded from quota and swept later */ }
}
// Best-effort cleanup of abandoned reservations and interrupted deletions.
async function sweep(env: StorageEnv, store: R2Bucket) {
  try {
    const cutoff = Date.now() - RESERVATION_TTL_MS;
    const { results } = await env.DB.prepare(`SELECT id, object_key, status FROM storage_images
      WHERE status = 'deleting' OR (status = 'pending' AND created_at < ?1) LIMIT 5`).bind(cutoff)
      .all<{ id: string; object_key: string; status: string }>();
    for (const row of results) {
      if (row.status === 'pending') {
        const claimed = await env.DB.prepare(`UPDATE storage_images SET status = 'deleting'
          WHERE id = ?1 AND status = 'pending' AND created_at < ?2`).bind(row.id, cutoff).run();
        if (claimed.meta.changes !== 1) continue;
      }
      await purge(env, store, row.id, row.object_key);
    }
  } catch { /* retried on a later upload */ }
}

async function upload(request: Request, env: StorageEnv, url: URL): Promise<Response> {
  const target = category(url, true)!;
  if (Number(request.headers.get('content-length')) > MAX_IMAGE_BYTES) fail(413, 'image_too_large');
  const user = (await session(request, env))!;
  await writeLimit(env, user.id);
  const store = bucket(env);
  const bytes = await readBytes(request, MAX_IMAGE_BYTES, 'image_too_large');
  const image = inspectImage(bytes);
  await sweep(env, store);

  const id = newId();
  const key = `${target.prefix}/${id}.${image.extension}`;
  const createdAt = Date.now();
  const limit = target.maxImagesPerUser;
  // Atomic quota reservation: D1 executes each statement serially, so the count
  // and insert cannot interleave with a concurrent upload for the same user.
  const reserved = await env.DB.prepare(`INSERT INTO storage_images
      (id, owner_id, app_id, category, object_key, mime_type, size, width, height, status, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10
    WHERE ?12 IS NULL OR (SELECT count(*) FROM storage_images WHERE owner_id = ?2 AND category = ?4 AND ${active('?11')}) < ?12`)
    .bind(id, user.id, target.app, target.id, key, image.mimeType, bytes.length, image.width, image.height,
      createdAt, createdAt - RESERVATION_TTL_MS, limit).run();
  if (reserved.meta.changes !== 1) {
    fail(409, 'storage_limit_reached', { limit: limit!, used: Math.max(await usage(env, user.id, target.id), limit!) });
  }

  try {
    await store.put(key, bytes, { httpMetadata: { contentType: image.mimeType } });
  } catch {
    await discard(env, store, id, key);
    fail(503, 'storage_unavailable');
  }
  let finalized = false;
  try {
    const result = await env.DB.prepare(`UPDATE storage_images SET status = 'ready'
      WHERE id = ?1 AND status = 'pending' AND created_at >= ?2`).bind(id, Date.now() - RESERVATION_TTL_MS).run();
    finalized = result.meta.changes === 1;
  } catch { /* handled below */ }
  if (!finalized) {
    await discard(env, store, id, key);
    fail(503, 'storage_unavailable');
  }
  return ok(present({ id, appId: target.app, category: target.id, mimeType: image.mimeType, size: bytes.length,
    width: image.width, height: image.height, createdAt }, url.origin), 201);
}

async function list(request: Request, env: StorageEnv, url: URL): Promise<Response> {
  const target = category(url, false);
  const limit = integer(url.searchParams.get('limit'), 50, 1, 100);
  const offset = integer(url.searchParams.get('offset'), 0, 0, 10000);
  const user = (await session(request, env))!;
  const db = drizzle(env.DB);
  const rows = await db.select().from(storageImages)
    .where(and(eq(storageImages.ownerId, user.id), eq(storageImages.status, 'ready'),
      target ? eq(storageImages.category, target.id) : undefined))
    .orderBy(desc(storageImages.createdAt), desc(storageImages.id)).limit(limit).offset(offset);
  const quota = target?.maxImagesPerUser != null ?
    { quota: { limit: target.maxImagesPerUser, used: await usage(env, user.id, target.id) } } : {};
  return ok({ images: rows.map(r => present(r, url.origin)), limit, offset,
    nextOffset: rows.length === limit ? offset + limit : null, ...quota });
}

async function metadata(request: Request, env: StorageEnv, url: URL, id: string): Promise<Response> {
  const user = (await session(request, env))!;
  if (!ID.test(id)) fail(404, 'image_not_found');
  const row = await drizzle(env.DB).select().from(storageImages).where(and(eq(storageImages.id, id),
    eq(storageImages.ownerId, user.id), eq(storageImages.status, 'ready'))).get();
  if (!row) fail(404, 'image_not_found');
  return ok(present(row, url.origin));
}

async function remove(request: Request, env: StorageEnv, id: string): Promise<Response> {
  const user = (await session(request, env))!;
  await writeLimit(env, user.id);
  if (!ID.test(id)) fail(404, 'image_not_found');
  const store = bucket(env);
  // Claim first: the slot is freed and public serving stops immediately. A retry
  // after an R2 failure re-claims the same `deleting` row.
  const { results } = await env.DB.prepare(`UPDATE storage_images SET status = 'deleting'
    WHERE id = ?1 AND owner_id = ?2 AND status IN ('ready', 'deleting') RETURNING object_key`)
    .bind(id, user.id).all<{ object_key: string }>();
  if (!results.length) fail(404, 'image_not_found');
  try { await store.delete(results[0].object_key); } catch { fail(503, 'storage_unavailable'); }
  try {
    await env.DB.prepare(`DELETE FROM storage_images WHERE id = ?1 AND status = 'deleting'`).bind(id).run();
  } catch { /* object is gone; the `deleting` row is swept later */ }
  return ok({ deleted: true });
}

function etagMatches(header: string | null, etag: string): boolean {
  return !!header && (header.trim() === '*' || header.split(',').some(v => v.trim().replace(/^W\//, '') === etag));
}
async function serve(request: Request, env: StorageEnv, id: string): Promise<Response> {
  if (!ID.test(id)) fail(404, 'image_not_found');
  const row = await env.DB.prepare(`SELECT object_key, mime_type FROM storage_images WHERE id = ?1 AND status = 'ready'`)
    .bind(id).first<{ object_key: string; mime_type: string }>();
  if (!row) fail(404, 'image_not_found');
  // IDs are random and never reused and objects are immutable, so the ID is a strong ETag.
  const etag = `"${id}"`;
  const headers = new Headers({
    'Content-Type': row.mime_type, ETag: etag,
    'Cache-Control': `public, max-age=${PUBLIC_IMAGE_MAX_AGE_SECONDS}`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  // Revalidation needs only the D1 lookup above, so deleted images stop
  // revalidating while live ones avoid an R2 read.
  if (etagMatches(request.headers.get('If-None-Match'), etag)) return new Response(null, { status: 304, headers });
  let object: R2ObjectBody | null = null;
  try { object = await bucket(env).get(row.object_key); } catch { fail(503, 'storage_unavailable'); }
  if (!object) fail(404, 'image_not_found');
  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}

// Routes /v1/storage/*. `path` is the split pathname including 'v1' and 'storage'.
export async function storageRoute(request: Request, env: StorageEnv, path: string[], url: URL): Promise<Response> {
  const method = request.method;
  if (path[2] === 'files' && path.length === 4) {
    if (method !== 'GET') fail(405, 'method_not_allowed');
    return serve(request, env, path[3]);
  }
  if (path[2] !== 'images' || path.length > 4) fail(404, 'not_found');
  if (path.length === 3) {
    if (method === 'POST') return upload(request, env, url);
    if (method === 'GET') return list(request, env, url);
  } else {
    if (method === 'GET') return metadata(request, env, url, path[3]);
    if (method === 'DELETE') return remove(request, env, path[3]);
  }
  fail(405, 'method_not_allowed');
}
