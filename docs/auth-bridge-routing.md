# Account bridge routing investigation and deployment

## Findings

The caller in `src/accounts.ts` sends a POST to the fixed URL `https://accounts.retrac.space/api/internal/games/session`, with JSON `{}`, a bearer JWT and `X-Space-Api-Key`. It builds fresh headers; browser Origin and cookies are not forwarded. Redirects are rejected and the five-second deadline covers fetch and JSON consumption. All transport failures, non-401 upstream errors and malformed JSON previously collapsed silently to `503 accounts_unavailable`.

The current accounts implementation was inspected in the sibling repository (`src/server/games.ts` and `worker.ts`, local commit `dd35901`). It has the bridge implemented: the service key is checked before JWT verification, then signature/claims and the live session are checked. A missing or incorrect service key gives 403; a bad/revoked JWT gives 401. The Pages Worker accepts the canonical accounts origin. No accounts code or deployment settings were modified by this fix.

A keyless external POST from the development machine returned **403 in approximately 608 ms**, confirming public reachability without accessing account data or sending credentials. The user's Mac result (~115 ms) corroborates reachability but neither measures a Worker subrequest. A 403 without a service key does not validate the deployed API's secret. Missing internal request logs likewise do not prove which layer failed.

The API's tracked Wrangler config had **no `global_fetch_strictly_public` compatibility flag**. Cloudflare documents that without it, global fetch to the same zone can route directly to an origin, bypassing a Worker; error 1042 is also associated with unsupported Worker-to-Worker requests. Enabling the flag explicitly sends global fetch through public Cloudflare routing, matching the externally reachable accounts URL. This is the smallest supported transport correction and does not alter DNS or require an accounts migration. A recent compatibility date alone does not replace this explicit opt-in in the documented flag entry.

**Diagnosis limit:** routing is the leading hypothesis supported by the configuration and symptoms, not a captured production root cause. No production Worker trace, private account request, or deployment was performed in this investigation. An upstream 403, timeout, or account-side 503 cannot be ruled out from the old generic client error. This change makes routing explicit and adds safe diagnostics to distinguish those cases after an approved deployment; it does not claim live authenticated success has been verified.

References: [global fetch routing semantics](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public), [fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/), [Worker error 1042](https://developers.cloudflare.com/workers/observability/errors/).

## Why no service binding

Accounts is a Pages advanced-mode deployment, not a separately deployed named Worker service. The [documented Pages service-binding integration](https://developers.cloudflare.com/pages/functions/bindings/#service-bindings) describes Pages calling a **Worker**; it does not establish Pages projects as supported binding targets. Do not guess a generated Pages Worker name or silently duplicate/migrate the account deployment. Keeping the canonical HTTPS URL with explicit public routing avoids that dependency. A binding can be reconsidered if accounts later exposes a supported Worker service and runtime evidence justifies it; keep the service-key and live-session checks even then.

## Safe diagnostics

Failed bridge calls emit one `console.warn` record with only:

- `event`: `accounts_bridge_failure`.
- `operation`: `session` or `players` (no user-controlled path/query).
- `reason`: `configuration`, `upstream_status`, `timeout`, `worker_routing`, `fetch_failed`, or `invalid_json`.
- `elapsedMs`: local elapsed time, and `upstreamStatus` if a response arrived.

No request/response objects, URLs, headers, bodies, raw error messages/stacks, user IDs, usernames, JWTs, cookies or keys are logged. The `worker_routing` category detects the numeric 1042 marker in a thrown error without printing the message. An HTTP error page is **not** parsed or logged: its status is reported as `upstream_status`, not asserted to be 1042. Expected invalid-session 401s remain 401 without warning noise. Client-facing error envelopes and security checks remain unchanged. These are application log guarantees; do not enable tooling that dumps full request headers or payloads.

Interpretation after an operator-approved rollout:

| Diagnostic | Next check |
| --- | --- |
| `configuration` | API environment has no usable key; check secret presence in that exact deployment environment without printing it. |
| `upstream_status`, 403 | Upstream rejected the request. Verify matching secret/environment and accounts policy; do not treat it as a JWT-expiry error or bypass key validation. |
| `upstream_status`, 530 / `worker_routing` | Check deployed compatibility flags and Cloudflare routing/edge errors. HTTP 530 alone does not prove a specific Cloudflare error code. |
| `upstream_status`, 429 or 5xx | Inspect sanitized account-side rate-limit/health diagnostics. Do not mask upstream problems with retries or a longer timeout. |
| `timeout` near 5000 ms | The deadline expired, including possible body-read delay; external laptop timing is not the same path. |
| `fetch_failed` | Transport/redirect failure; no raw exception is logged. Verify canonical hostname and routing without sending credentials to alternative hosts. |
| `invalid_json`, 200 | Response arrived but could not be decoded as JSON; inspect route selection, not secret contents. |

Valid JSON with an invalid identity shape still fails closed in the existing schema guard. It is not automatically a transport failure.

## Deployment instructions (not executed)

1. Review this PR and use the existing **space-api** deployment pipeline after approval. The runtime must apply `compatibility_flags: ["global_fetch_strictly_public"]` from `wrangler.jsonc`; dashboard-only builds must explicitly retain the same flag. Preserve any other deployed flags. Applying the flag to accounts alone will not change the API caller's fetch behavior. Do not create a Pages project, change DNS, or migrate accounts for this fix.
2. No new secret, key rotation, service binding, D1 migration or timeout increase is needed. Keep `ACCOUNTS_API_KEY` in Cloudflare secrets for the intended API environment and matching accounts environment; do not paste values into commands, logs or PR comments. Do not deploy a preview against production accounts using production credentials merely to reproduce the issue.
3. Run `npm run test:accounts` on Node 24 for the isolated bridge tests. They require no dependency installation, database or live account. They check routing config, fixed outbound URL/headers, guest/401 behavior, and sanitized diagnostics for upstream status, timeout, 1042, fetch failure and invalid JSON. Native TypeScript transformation uses an experimental Node flag in this test command only; production remains Wrangler-bundled TypeScript.
4. After approval and rollout, use a fresh account-issued token through the normal signed-in client and verify `/v1/players/me` returns 200. Verify a revoked/expired token returns 401 and a guest `/v1/session` remains 200 with guest data. Never put a JWT in a shell command/history or request URL. If a 503 remains, inspect only the allowlisted bridge warning fields to select the next check above. Do not assume this PR has confirmed production recovery until that check occurs.
5. Roll back through the normal deployment pipeline if necessary; no data rollback or DNS action is involved. Do not remove authentication checks as a workaround.

Validation for this fix: five targeted Node tests passed; `git diff --check` passed. No full integration suite, dependency install, typecheck or production build was run for this isolated change; no live authenticated verification was attempted. README content is unchanged. The older `validation.md` records initial implementation checks, not the outcome of this fix.
