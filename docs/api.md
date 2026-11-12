# v1 API contract

Base URL: deployment-specific (intended `https://api.retrac.space`). HTTPS only in production. All responses are JSON except successful OPTIONS (204) and public storage files. Success is `{ "data": ... }`, except counters which return `{ "name": string, "count": number }` directly. Failure is `{ "error": { "code": "snake_case_code" } }`, optionally with structured fields beside `code` (e.g. `limit`, `used`). Errors never contain human-readable messages; applications own user-facing text. All responses are no-store except public storage files. Millisecond timestamps are Unix epoch numbers. No endpoint accepts an owner/player ID in a request body.

Protected endpoints require `Authorization: Bearer <short-lived-account-token>`. See `accounts-integration.md`; cookies alone never authenticate this API. CORS permits configured exact origins, methods GET/PUT/POST/DELETE/OPTIONS, and headers Authorization/Content-Type. Counter routes additionally permit HTTPS `retrac.space` and its subdomains (default port only); other routes retain the exact origin allowlist. Browser API requests use `credentials: omit`. Requests without Origin (server clients) still require the same bearer authorization on protected endpoints. CORS is not authentication.

## Public counters

| Method and path | Request | Response (no `data` wrapper) |
| --- | --- | --- |
| GET `/v1/counters/get/{name}` | none | `{ "name": "test", "count": 0 }`; creates a missing counter at 0 |
| POST `/v1/counters/increment/{name}` | no body required | `{ "name": "test", "count": 1 }`; creates a missing counter at 0, then increments by 1 |

Counter names are case-sensitive, nonempty strings of letters, digits, hyphens and underscores (`[a-zA-Z0-9_-]+`). URL-encoded names are decoded before validation. Invalid names return 400 `invalid_counter_name`, unsupported methods return 405 `method_not_allowed`, and unknown counter routes return 404 `not_found`. Errors use the standard error envelope above.

Counters are public and shared globally by name, with no accounts, tokens, or application-level rate limiting. Anyone who can reach these endpoints can increment them. Cloudflare platform limits and protections still apply. Both operations use a single atomic SQL upsert with `RETURNING` in the existing D1 database, preventing lost increments or a separate read racing the response. GET preserves existing counts. Responses use the Worker's shared CORS, preflight, error and no-store handling.

The additive migration is `migrations/0004_counters.sql`. It must be applied before deploying this feature; no remote migration or deployment is part of this implementation.

## Other endpoints

| Method and path | Authentication | Request | `data` response |
| --- | --- | --- | --- |
| GET `/v1/health` | public | none | `{status:"ok"}` (process liveness, not dependency readiness) |
| GET `/v1/session` | optional | none | `{authenticated:boolean,player:null\|{id,username}}` |
| GET `/v1/soundboard/notifications` | required | none | `{notifications:[{id,sound_name,status,reason}]}`; unread, caller only, oldest first |
| POST `/v1/soundboard/notifications/ack` | required | exactly `{ids:number[]}` JSON, at most 50 IDs | `{success:true}`; acknowledges caller's matching unread rows |
| GET `/v1/players/me` | required | none | `{id,username,personalBests:[{gameId,leaderboardId,score}]}` |
| GET `/v1/players/id/{userId}` | public | URL-encoded retrac.space user ID, 1–256 characters after decoding | `{username}` (current account username) |
| GET `/v1/players/{username}` | public | normalized username, 3–20 letters/digits/underscores | `{username,personalBests:[{gameId,leaderboardId,score}]}` |
| GET `/v1/games` | public | none | array of `{id,name,saveSlots}` |
| GET `/v1/games/{game}` | public | none | `{id,name,saveSlots,leaderboards:[Board]}` |
| GET `/v1/games/{game}/saves` | required | none | array of `{slot,updatedAt}` for the caller only |
| GET `/v1/games/{game}/saves/{slot}` | required | none | `{slot,data,updatedAt}` |
| PUT `/v1/games/{game}/saves/{slot}` | required | exactly `{data:object\|array}` JSON | `{slot,data,updatedAt}`; whole-save replacement/upsert |
| DELETE `/v1/games/{game}/saves/{slot}` | required | none | `{deleted:true}`, idempotent even if absent |
| GET `/v1/games/{game}/leaderboards` | public | none | array of Board |
| GET `/v1/games/{game}/leaderboards/{board}` | public | optional `limit` (1–100, default 25), `offset` (0–10000, default 0) | `{entries:[{rank,username,score}],limit,offset,nextOffset:number\|null}` |
| POST `/v1/games/{game}/leaderboards/{board}/scores` | required | exactly `{score:number}` JSON | `{personalBest:number,rank:number}` after atomic best update |
| GET `/v1/games/{game}/leaderboards/{board}/me` | required | none | `{personalBest:number\|null,rank:number\|null}`; nulls before first score |
| POST `/v1/storage/images?category={category}` | required | raw image bytes, ≤ 2 MB | `201` Image; see [storage.md](storage.md) |
| GET `/v1/storage/images` | required | optional `category`, `limit`, `offset` | `{images:[Image],limit,offset,nextOffset,quota?}` |
| GET `/v1/storage/images/{id}` | required | none | Image (owner only) |
| DELETE `/v1/storage/images/{id}` | required | none | `{deleted:true}` (owner only) |
| GET `/v1/storage/files/{id}` | public | none | image bytes, cacheable for 5 minutes |

`Board` is `{gameId:string,id:string,name:string,direction:"asc"|"desc",scoreType:"integer"|"number",minScore:number,maxScore:number}`. Game/board IDs match `[a-z0-9][a-z0-9-]{0,39}`. Saves have zero-based numeric slots less than game.saveSlots. JSON strings, scalars and null are not valid save roots. The encoded data limit is 65,536 bytes and request limit 66,560 bytes; this includes whitespace/envelope overhead for the request. Send compact JSON. No unknown keys are allowed in save/score bodies. Scores must be finite, within the board range and ±Number.MAX_SAFE_INTEGER, and safe integers for integer boards. Ranges are inclusive. `desc` means higher wins; `asc` means lower wins. Repeated/worse submissions succeed with the existing best and rank. Rankings are ordinal, one-based, with stable user-ID tie breaking. Pagination is live rather than a snapshot; `nextOffset` can lead to an empty last page. Deleted/unavailable-name rows are omitted and can create rank gaps; see architecture notes.

Examples (no real tokens or player data):

Look up a current username without an Authorization header or cookies:

```js
const response = await fetch(
  `https://api.retrac.space/v1/players/id/${encodeURIComponent(userId)}`,
  { credentials: 'omit' },
);
// On success: { "data": { "username": "current_name" } }
const result = await response.json();
```

The ID lookup reads the accounts directory on every request and uses the existing request rate limit and CORS origin allowlist. Malformed encoding or IDs longer than 256 characters return 400 `invalid_user_id`. Unknown/deleted users and users without a username return 404 `player_not_found`; an unavailable accounts service returns 503 `accounts_unavailable`. No other account fields are returned.

```http
PUT /v1/games/2048/saves/0
Authorization: Bearer <account-issued-token>
Content-Type: application/json

{"data":{"version":1,"grid":[[2,0],[0,2]],"score":4}}
```

```json
{"data":{"entries":[{"rank":1,"username":"example_player","score":2048}],"limit":25,"offset":0,"nextOffset":null}}
```

Image storage endpoints, categories, quotas and their error codes are documented in [storage.md](storage.md).

Soundboard integration, error codes and manual D1 administration SQL are documented in [soundboard-notifications.md](soundboard-notifications.md).

Status codes: 200 for successful operations (including first save/score); 201 image upload; 204 OPTIONS; 304 public file revalidation; 400 malformed JSON/body, invalid score/identifier/slot/pagination; 401 missing, invalid or expired session; 403 denied origin/preflight or incomplete username onboarding; 404 unknown route/game/board/player/save/image; 405 unsupported method; 409 storage quota reached; 413 oversized request/save/image; 415 missing/wrong JSON Content-Type or unsupported image type; 429 rate limit (Retry-After: 60); 503 unavailable accounts/database/configuration or unexpected internal error. No errors redirect or expose upstream diagnostics. Missing auth only becomes a normal guest result on `/v1/session`; public endpoints do not need tokens. Unknown usernames/deleted accounts return 404; upstream outages return 503. Public profiles never expose the stable ID or private account data; `/me` and `/session` expose only the caller's ID.
