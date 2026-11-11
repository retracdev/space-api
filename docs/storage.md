# Image storage

Reusable, user-owned image storage for retrac.space applications. Bytes live in one Cloudflare R2 bucket accessed through a native Worker binding; ownership and metadata live in the existing D1 database. Applications talk only to this API, authenticate with the existing account bearer token, and never hold storage credentials. Glow is the first application.

## Cloudflare setup (manual)

| Setting | Value |
| --- | --- |
| Binding type | R2 bucket |
| Variable name | `SPACE_STORAGE` |
| Bucket | `space-storage` (already exists) |

No R2 API tokens, S3 credentials, access keys, public bucket domain or `r2.dev` URL are needed or used. The binding is also declared in `wrangler.jsonc` (`r2_buckets`) so a `wrangler deploy` keeps it instead of dropping a dashboard-only binding. If the binding is missing, storage endpoints fail closed with `503 storage_unavailable`; all other endpoints are unaffected.

Apply migration `0002_storage_images.sql` before enabling storage. Locally: `npm run db:migrate`. Remotely, only with explicit approval: `npx wrangler d1 migrations apply space-api --remote`.

Browser applications need their exact origin in `ALLOWED_ORIGINS` (this change adds `https://glow.retrac.space`), and the account service must issue access tokens to that origin.

## Endpoints

All paths are under the existing `/v1` API and use the standard envelopes: success `{ "data": ... }`, failure `{ "error": { "code": "...", ...details } }`.

| Method and path | Authentication | Request | `data` response |
| --- | --- | --- | --- |
| POST `/v1/storage/images?category={category}` | required | raw image bytes as the request body (≤ 2 MB) | `201` Image |
| GET `/v1/storage/images` | required | optional `category`, `limit` (1–100, default 50), `offset` (0–10000) | `{images:[Image],limit,offset,nextOffset,quota?:{limit,used}}` |
| GET `/v1/storage/images/{id}` | required, owner only | none | Image |
| DELETE `/v1/storage/images/{id}` | required, owner only | none | `{deleted:true}` |
| GET `/v1/storage/files/{id}` | public | none | the image bytes (not JSON) |

`Image` is `{id,app,category,mimeType,size,width,height,createdAt,url}`. `url` is the public file URL. `quota` is included in list responses only when a quota-limited `category` is requested; `used` counts ready images plus in-flight uploads. Listing is newest first and returns only the caller's images. Another user's image ID returns `404 image_not_found`, the same as a missing one.

### Uploading

Send the file itself as the body (for example a `Blob` from `canvas.toBlob`). Multipart forms are not accepted. The `Content-Type` header is ignored for validation; the stored type comes from the bytes. Accepted formats: PNG, JPEG, WebP, GIF (static or animated), up to 2,097,152 bytes and 16,384 px per side. The original bytes are stored unchanged; there is no conversion, resizing or metadata stripping, so embedded EXIF data in JPEGs is preserved.

The server builds the object key from the approved category prefix and a 128-bit random ID, with the extension of the detected format, e.g. `glow/saves/3f9c….png`. Clients never send paths, owner IDs or app IDs.

### Categories and quotas

Approved categories are configured in `src/storage.ts` (`STORAGE_CATEGORIES`):

| Category | App | R2 prefix | Per-user limit |
| --- | --- | --- | --- |
| `glow/saves` | `glow` | `glow/saves/` | `GLOW_MAX_SAVED_IMAGES` = **2 (temporary)** |

Glow's limit is intentionally 2 for quota testing. The intended production limit is 50: change `GLOW_MAX_SAVED_IMAGES` and redeploy. No migration is needed. Quotas are per user and per category, so other applications are unaffected. Deleting an image frees its slot immediately.

To add a category (e.g. avatars), add one entry such as `['users/avatars', { app: 'accounts', prefix: 'users/avatars', maxImagesPerUser: 1 }]`. No new bucket, table or route is required.

### Public delivery and caching

`GET /v1/storage/files/{id}` looks the ID up in D1, reads the object through the binding and streams it with its stored content type, `Content-Length`, `ETag: "{id}"`, `Cache-Control: public, max-age=300`, a sandboxing `Content-Security-Policy`, `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy: cross-origin`. It exposes no owner, app or bucket information. Plain `<img>` tags work from any site. Requests carrying an `Origin` header must come from an allowed origin, like every endpoint.

IDs are never reused and objects never change, so the ID is a strong ETag. `If-None-Match` revalidation answers `304` after the D1 lookup without reading R2. A deleted image stops being served immediately; a browser that already cached it may show it for up to 5 minutes (`PUBLIC_IMAGE_MAX_AGE_SECONDS`). No shared edge cache is used, so there is nothing to purge.

## Error contract

The API never returns human-readable messages. Each error has a stable `code` and, where useful, structured fields. Applications map codes to their own text and localization.

| Status | Code | Extra fields | When |
| --- | --- | --- | --- |
| 400 | `invalid_category` | | upload without `category`, or an unknown category |
| 400 | `invalid_image` | | empty, truncated, malformed or out-of-range image |
| 400 | `invalid_pagination_or_slot` | | bad `limit`/`offset` |
| 401 | `authentication_required` / `invalid_session` | | missing or invalid bearer token |
| 403 | `username_required` | | account has not finished onboarding |
| 404 | `image_not_found` | | unknown, deleted or not-owned image |
| 409 | `storage_limit_reached` | `limit`, `used` | category quota is full |
| 413 | `image_too_large` | | body exceeds 2 MB |
| 415 | `unsupported_image_type` | | not PNG, JPEG, WebP or GIF |
| 429 | `rate_limited` | | write rate limit (shared 30/min/user) or request limit |
| 503 | `storage_unavailable` | | R2 missing or failing; nothing was stored |

Example quota response:

```json
{ "error": { "code": "storage_limit_reached", "limit": 2, "used": 2 } }
```

## Consistency and failure handling

D1 has no interactive transactions, so uploads use a reservation:

1. Validate the bytes fully before touching storage.
2. Reserve with one conditional `INSERT … SELECT … WHERE (count of active images) < limit`. D1 runs each statement serially, so concurrent uploads cannot both take the last slot. The row starts as `pending` and counts toward quota.
3. Write the object to R2. On failure the reservation is released and `503` returned.
4. Mark the row `ready`. If that fails, the object and reservation are removed and `503` returned.

Reservations older than 10 minutes stop counting toward quota and can never be finalized, so a crashed upload cannot hold a slot. Deletion claims the row as `deleting` (freeing the slot and stopping public delivery), deletes the R2 object, then deletes the row. If R2 fails the client gets `503` and can retry; the claim is repeatable. Each upload also sweeps a few expired reservations and interrupted deletions. Every R2 object is created only after its D1 row exists and is deleted before its row, so no object is ever left without a tracking row.

## Integration example (Glow)

```js
const API = 'https://api.retrac.space';
const auth = { Authorization: `Bearer ${await getAccessToken()}` };

// Save artwork
const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
const res = await fetch(`${API}/v1/storage/images?category=glow/saves`, {
  method: 'POST', headers: { ...auth, 'Content-Type': blob.type }, body: blob, credentials: 'omit',
});
const json = await res.json();
if (json.error?.code === 'storage_limit_reached') showSlotsFull(json.error.used, json.error.limit);
else if (res.ok) addToSaves(json.data); // json.data.url is the public image URL

// Saves page
const { data } = await (await fetch(`${API}/v1/storage/images?category=glow/saves`, { headers: auth })).json();
renderSaves(data.images, data.quota); // <img src={image.url}>

// Delete
await fetch(`${API}/v1/storage/images/${id}`, { method: 'DELETE', headers: auth });
```
