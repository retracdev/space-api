# Public presence API

Base URL: `https://api.retrac.space`. Presence is a casual online indicator. All
endpoints are public: no accounts, authentication, API keys, bearer tokens,
cookies, site registration, or application rate limiting. Usernames are
unverified display names, never proof of identity. Platform limits still apply.

Each site is independent and is created implicitly by its first heartbeat.
Site identifiers are case-sensitive lowercase ASCII letters, digits, underscores
or hyphens, 1–64 characters, starting with a letter or digit. Examples:
`soundboard`, `glowstudio`, `toptext`, `basketbros`, `basketsmash`.

Browser access uses the existing API CORS configuration, including HTTPS
`retrac.space` and all its subdomains for presence (matching public counters).
Other explicitly configured `ALLOWED_ORIGINS` also work. Requests without an
Origin header work; CORS is not authentication or protection against spoofing.
Every presence response, including errors, has `Cache-Control: no-store`.

## Heartbeat

`POST /v1/presence/heartbeat/:site`, `Content-Type: application/json`:

```json
{"visitorId":"550e8400-e29b-41d4-a716-446655440000","username":"retrac"}
```

```json
{"site":"soundboard","visitorId":"550e8400-e29b-41d4-a716-446655440000","displayName":"retrac","online":true}
```

`visitorId` must be a standard hyphenated UUID (versions 1–8 with RFC variant
bits); casing is normalized. Generate UUID v4 with `crypto.randomUUID()`.
`username` is optional. When present it must be a string with 1–40 Unicode code
points after trimming, without control characters. Empty strings and null are
rejected. Unknown fields are rejected, including client timestamps.

If omitted on first insertion, the server assigns a name from a pool of 64
animals, such as Anonymous Fox, Capybara, Axolotl or Puffin. It chooses an animal
not used by another active visitor in the same site. Selection and assignment
happen in one atomic D1 upsert, including concurrent arrivals. Expired sessions
do not reserve names. Other sites have independent pools.

Only when all 64 animals are occupied does the server reuse a name, choosing
among the least-used animals. Subsequent heartbeats keep an anonymous name
unless it collides with another active visitor and a free animal is available.
This also repairs existing anonymous duplicates and handles returning sessions
whose animal was reused after expiry. Supplied usernames are preserved when
omitted on later heartbeats; users can deliberately submit duplicate names.
An internal `is_anonymous` flag distinguishes generated names from supplied ones.

## Online visitors

`GET /v1/presence/online/soundboard`:

```json
{"site":"soundboard","count":3,"users":[{"displayName":"retrac"},{"displayName":"Anonymous Fox"},{"displayName":"Anonymous Panda"}]}
```

Only heartbeats newer than 90 seconds are included. At exactly 90 seconds the
session is offline. A missing or inactive room returns `count: 0, users: []`.
Each row represents one site session; duplicate names are not deduplicated.
The list exposes only display names, ordered by most recent heartbeat first.
No visitor IDs, IPs, timestamps, accounts, or fingerprints are exposed. Reads
never write to D1. Render names with `textContent`, never `innerHTML`.

## Leave (optional)

`POST /v1/presence/leave/soundboard`, `Content-Type: application/json`:

```json
{"visitorId":"550e8400-e29b-41d4-a716-446655440000"}
```

```json
{"success":true}
```

Deletes only this site's session. Repeated leave calls succeed. A later heartbeat
recreates the record. Anonymous names can change to resolve collisions, or after
explicit leave or periodic cleanup. Accurate expiration never depends on a
leave request reaching the server.

## Global summary

`GET /v1/presence/summary`:

```json
{"totalOnline":42,"sites":{"soundboard":25,"glowstudio":10,"toptext":7}}
```

Includes only sites with active sessions. An empty summary is
`{"totalOnline":0,"sites":{}}`. `totalOnline` counts active site sessions, not
unique people: one person on multiple sites can be counted multiple times.
Individual sites' lists are never combined.

## Errors

Presence success bodies are the top-level objects shown above, matching the
public counters convention. Errors use the shared API format:

```json
{"error":{"code":"invalid_visitor_id"}}
```

| Status | Codes |
| --- | --- |
| 400 | `invalid_site`, `invalid_visitor_id`, `invalid_username`, `invalid_body`, `invalid_json` |
| 403 | `origin_not_allowed`, `preflight_denied` |
| 404 | `not_found` |
| 405 | `method_not_allowed` |
| 413 | `body_too_large` |
| 415 | `json_required` |
| 503 | `service_unavailable` |

POST bodies have a hard 1,024-byte cap, enforced while streaming even without
Content-Length. All SQL values are bound parameters. The API stores only site,
random visitor ID, display name and a server timestamp in milliseconds.

## Minimal JavaScript integration

Run once per page. The UUID survives reloads within a tab via `sessionStorage`.
This example treats a visible page as active, pauses in hidden tabs, and sends
an immediate heartbeat when a page becomes visible again. No account integration
or cookie credentials are needed. Applications may add their own idle detection.

```js
const site = 'glowstudio';
const base = 'https://api.retrac.space/v1/presence';
const key = `presence:${site}:visitorId`;
let visitorId = sessionStorage.getItem(key);
if (!visitorId) {
  visitorId = crypto.randomUUID();
  sessionStorage.setItem(key, visitorId);
}

// Optional unverified label. Set undefined to preserve the current server name.
let username;
let pending = false;
async function heartbeat() {
  if (document.visibilityState !== 'visible' || pending) return;
  pending = true;
  try {
    const response = await fetch(`${base}/heartbeat/${site}`, {
      method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId, username }),
    });
    if (!response.ok) throw new Error(`Presence: ${response.status}`);
    const { displayName } = await response.json();
    // Optional: nameElement.textContent = displayName;
  } catch (error) {
    console.debug('Presence heartbeat unavailable', error);
    // Retry at the next interval; the page continues working offline.
  } finally { pending = false; }
}

void heartbeat();
setInterval(() => void heartbeat(), 30_000);
document.addEventListener('visibilitychange', () => void heartbeat());
window.addEventListener('pageshow', () => void heartbeat()); // bfcache restore

async function online() {
  const response = await fetch(`${base}/online/${site}`, {
    credentials: 'omit', cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Presence: ${response.status}`);
  return response.json(); // { site, count, users: [{ displayName }] }
}
```

Leaving is deliberately omitted from this minimal example: an unload request
can race a new heartbeat on reload. If desired, send the leave JSON with
`fetch(..., { method: 'POST', keepalive: true, credentials: 'omit', ... })`.
Browser delivery is best-effort. Background tabs disappear after 90 seconds
without heartbeats even if they remain open. To change a display name, set
`username` and call `heartbeat()` while the page is visible.

## Migration and deployment

Uses the existing `DB` binding and `space-api` D1 database. No new database,
dependency, WebSocket, Durable Object, or service is required. Migration
`migrations/0005_presence.sql` creates the composite `(site, visitor_id)` primary
key plus `(site, last_seen)` and `(last_seen)` indexes. `src/schema.ts` mirrors it.
An hourly Worker cron (`0 * * * *`) deletes expired records using the global
last-seen index. Inactive rows can remain until that sweep but are immediately
excluded from reads. Scheduled errors propagate for platform reporting.

Migration `0006_presence_anonymous.sql` adds the internal `is_anonymous` flag.
It classifies the original eight Anonymous animal labels as generated names,
since the old schema did not record their source. A legacy user who explicitly
chose one of those exact labels can resend their username to mark it as supplied.
New explicitly supplied labels are never renamed automatically.

Follow the existing migration workflow: `npm run db:migrate` applies migrations
locally. After explicit production approval, apply migrations with
`npx wrangler d1 migrations apply space-api --remote` **before** deploying the
Worker using `npx wrangler deploy`. Both migrations 0005 and 0006 must be applied
before deploying the current code. Deployment installs the hourly cron trigger.
No production migration or deployment was performed for this change.

Tests are in `tests/presence.test.ts` using Vitest and actual local D1 through
Miniflare. They cover rooms, names, refresh, expiry, leave, isolation, summaries,
concurrency, pool exhaustion, name reuse, collision repair, cleanup, CORS, privacy
shapes and invalid inputs. Per the request,
tests were added but not run.
