# Simple Soundboard notifications

Backend only: the existing Space API Worker and D1 database serve these endpoints.
Apply `migrations/0003_soundboard_notifications.sql` through the normal D1 migration
process before enabling the integration. No production deployment or remote migration
is part of this change. There is no administrative HTTP endpoint.

## Frontend integration

Both endpoints require `Authorization: Bearer <account-issued-token>`. Obtain the
short-lived account token through the existing retrac.space account flow described
in [accounts-integration.md](accounts-integration.md). Space API uses its existing
accounts bridge for JWT and live-session verification. Never send a user ID as
authentication. Use `credentials: 'omit'` for API fetches; cookies alone do not
authenticate. `https://soundboard.retrac.space` is already in the CORS allowlist.

### Retrieve unread notifications

`GET https://api.retrac.space/v1/soundboard/notifications`

```json
{
  "data": {
    "notifications": [
      { "id": 1, "sound_name": "Vine Boom", "status": "added", "reason": null },
      { "id": 2, "sound_name": "Airhorn", "status": "denied", "reason": "This sound already exists." }
    ]
  }
}
```

The existing API success envelope is retained: read `data.notifications`. No unread
rows returns `{"data":{"notifications":[]}}`. Only the authenticated user's unread
rows are returned, oldest first by `created_at`, then `id` for equal timestamps.
Fetching does not acknowledge anything, and unread rows do not expire.

On an authenticated visit, display all returned notifications in order (a list or
queue), using IDs to avoid duplicates across fetches. Display optional reasons as
text, never HTML. Do not acknowledge on fetch: acknowledge after the user dismisses
or confirms each notification. Keep unacknowledged items available. Guests should
wait until signed in before fetching.

### Acknowledge notifications

`POST https://api.retrac.space/v1/soundboard/notifications/ack`

Send the same Authorization header plus `Content-Type: application/json`:

```json
{ "ids": [1, 2] }
```

Success (200): `{"data":{"success":true}}`.

Send at most 50 IDs per request; split larger selections into batches. IDs must be
positive safe JSON integers. The body must contain only `ids`. Empty arrays and
duplicate IDs are accepted. Unknown IDs, other users' IDs, and already-read IDs
are ignored without disclosing ownership or existence. An atomic, user-scoped
update sets `read_at` on matching unread rows and preserves the original timestamp
on retries. Records remain in D1 for history. Remove dismissed items locally only
after success; retry failures without discarding unread notifications.

### Errors

Failures use the existing envelope, for example
`{"error":{"code":"authentication_required"}}`:

| HTTP | Codes / meaning |
| --- | --- |
| 400 | `invalid_json` (malformed JSON), `invalid_body` (wrong envelope/extra keys), `invalid_notification_ids` (non-array, invalid IDs, or more than 50 IDs) |
| 401 | `authentication_required` (missing/malformed bearer header), `invalid_session` (invalid, expired, or revoked token) |
| 403 | `username_required` (finish account onboarding), `origin_not_allowed`, `preflight_denied` |
| 404 | `not_found` (unknown route) |
| 405 | `method_not_allowed` |
| 413 | `body_too_large` (request exceeds the shared 66,560-byte JSON limit) |
| 415 | `json_required` (missing/wrong JSON Content-Type) |
| 429 | `rate_limited` (shared request/write limits; `Retry-After: 60`) |
| 503 | `accounts_unavailable` or `service_unavailable` (temporary service/database failure) |

Refresh an expired token using the existing account flow on 401. Treat 503/network
failures as retryable failures, not an empty notification list. All responses are
`Cache-Control: no-store`.

## Manual D1 administration

Run these SQL statements in the existing **space-api** D1 console after the
migration is applied. Replace placeholders with the stable retrac.space account
ID and desired text. Escape literal apostrophes by doubling them (`It''s`). IDs
are generated automatically; timestamps are Unix epoch milliseconds. Creating a
notification does not add/remove an actual sound: manage the sound separately.

Added:

```sql
INSERT INTO soundboard_notifications (user_id, sound_name, status)
VALUES ('USER_ID_HERE', 'SOUND_NAME_HERE', 'added');
```

Denied with a reason:

```sql
INSERT INTO soundboard_notifications (user_id, sound_name, status, reason)
VALUES ('USER_ID_HERE', 'SOUND_NAME_HERE', 'denied', 'REASON_HERE');
```

All notifications for one user, including acknowledged history:

```sql
SELECT * FROM soundboard_notifications
WHERE user_id = 'USER_ID_HERE'
ORDER BY created_at ASC, id ASC;
```

All unread notifications:

```sql
SELECT * FROM soundboard_notifications
WHERE read_at IS NULL
ORDER BY created_at ASC, id ASC;
```

Delete an accidentally created notification (replace `123` with its numeric ID):

```sql
DELETE FROM soundboard_notifications WHERE id = 123;
```
