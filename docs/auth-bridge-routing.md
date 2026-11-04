# Account bridge routing investigation and deployment

## Findings

The caller in `src/accounts.ts` sends a POST to the fixed URL `https://accounts.retrac.space/api/internal/games/session`, with JSON `{}`, a bearer JWT and `X-Space-Api-Key`. It builds fresh headers; browser Origin and cookies are not forwarded. Redirects are rejected and the five-second deadline covers fetch and JSON consumption. All transport failures, non-401 upstream errors and malformed JSON previously collapsed silently to `503 accounts_unavailable`.

The current accounts implementation was inspected in the sibling repository (`src/server/games.ts` and `worker.ts`, local commit `dd35901`). It has the bridge implemented: the service key is checked before JWT verification, then signature/claims and the live session are checked. A missing or incorrect service key gives 403; a bad/revoked JWT gives 401. The Pages Worker accepts the canonical accounts origin. No accounts code or deployment settings were modified by this fix.

A keyless external POST from the development machine returned **403 in approximately 608 ms**, confirming public reachability without accessing account data or sending credentials. The user's Mac result (~115 ms) corroborates reachability but neither measures a Worker subrequest. A 403 without a service key does not validate the deployed API's secret. Missing internal request logs likewise do not prove which layer failed.

The initial investigation added `global_fetch_strictly_public` to make public routing explicit. The subsequent deployed diagnostic (`fetch_failed`, `elapsedMs: 0`, no upstream status) showed that this did not resolve the failure. The routing hypothesis was insufficient: the request options themselves contain a workerd incompatibility, described below. The public-routing flag is retained; no further compatibility settings need changing for this fix.

**Confirmed runtime defect:** `redirect: "error"` throws a `TypeError` during Request construction in workerd, before network I/O. The exception starts with `Invalid redirect value, must be one of "follow" or "manual"`; the remaining explanation recommends manual mode and inspecting response status. This matches the immediate exception, absence of upstream status and absence of an accounts validation request. Native workerd reproduction passed; authenticated production recovery still requires a check after an approved rollout. The existing Node mocks accepted the standard Fetch `error` mode, which is why the previous tests missed this runtime difference.

Cloudflare's [Request documentation](https://developers.cloudflare.com/workers/runtime-apis/request/#constructor) explicitly documents the limitation, and the [workerd constructor implementation](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/http.c%2B%2B) rejects it unconditionally. The tracked API compatibility date is `2026-11-03`, with `global_fetch_strictly_public`; the account Pages config uses `2026-07-01` and `nodejs_compat`. Neither a newer date, `nodejs_compat`, nor a routing flag makes this redirect mode supported. Deployed dashboard metadata was not independently fetched; the reported deployed error and tracked configuration were used. No production trace containing credentials was requested or collected.

The supported alternative is the **existing canonical HTTPS endpoint**, fetched using `redirect: "manual"`. The bridge rejects every non-2xx status, including all 3xx responses, without reading or logging Location, following a redirect, or forwarding credentials to another destination. No proxy, alternative hostname, Pages migration, DNS change, service binding or credential rotation is required. The five-second deadline, fixed account origin, key validation, bearer/live-session authorization, guest behavior and client-facing error responses remain unchanged.

References: [global fetch routing semantics](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public), [fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/), [Worker error 1042](https://developers.cloudflare.com/workers/observability/errors/).

## Why no service binding

Accounts is a Pages advanced-mode deployment, not a separately deployed named Worker service. A Pages project is not a supported service-binding target. The [Pages integration](https://developers.cloudflare.com/pages/functions/bindings/#service-bindings) supports the opposite direction: Pages calling a Worker. [Wrangler's configuration controller](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/api/startDevWorker/ConfigController.ts) also explicitly rejects Pages as a secondary service-binding target during development; this was verified in the installed Wrangler code. Advanced mode does not turn the Pages project into a named Workers service target. Do not guess a generated internal Pages Worker name or silently duplicate/migrate the account deployment. Supported public HTTPS with manual redirect handling preserves Vercel DNS and the existing account architecture. A binding would require a separately supported Worker target, which is unnecessary for this defect.

## Safe diagnostics

Failed bridge calls emit one `console.warn` record with only:

- `event`: `accounts_bridge_failure`.
- `operation`: `session` or `players` (no user-controlled path/query).
- `reason`: `configuration`, `upstream_status`, `upstream_redirect`, `unsupported_redirect`, `timeout`, `worker_routing`, `fetch_failed`, or `invalid_json`.
- `elapsedMs`: local elapsed time, and `upstreamStatus` if a response arrived.

No request/response objects, URLs, headers, bodies, raw error messages/stacks, user IDs, usernames, JWTs, cookies or keys are logged. The `worker_routing` category detects the numeric 1042 marker in a thrown error without printing the message. An HTTP error page is **not** parsed or logged: its status is reported as `upstream_status`, not asserted to be 1042. Expected invalid-session 401s remain 401 without warning noise. Client-facing error envelopes and security checks remain unchanged. These are application log guarantees; do not enable tooling that dumps full request headers or payloads.

`unsupported_redirect` recognizes only the known TypeError prefix, emitting a constant category rather than the exception text. `upstream_redirect` records only the 3xx status; Location and response content are never logged.

Interpretation after an operator-approved rollout:

| Diagnostic | Next check |
| --- | --- |
| `configuration` | API environment has no usable key; check secret presence in that exact deployment environment without printing it. |
| `unsupported_redirect` | A deployed artifact still uses the unsupported redirect mode; verify the build includes the manual-mode fix. No DNS/key changes will fix Request construction. |
| `upstream_redirect` | The canonical account route redirected. Fail closed; investigate account routing without following Location or sending credentials to it. |
| `upstream_status`, 403 | Upstream rejected the request. Verify matching secret/environment and accounts policy; do not treat it as a JWT-expiry error or bypass key validation. |
| `upstream_status`, 530 / `worker_routing` | Check deployed compatibility flags and Cloudflare routing/edge errors. HTTP 530 alone does not prove a specific Cloudflare error code. |
| `upstream_status`, 429 or 5xx | Inspect sanitized account-side rate-limit/health diagnostics. Do not mask upstream problems with retries or a longer timeout. |
| `timeout` near 5000 ms | The deadline expired, including possible body-read delay; external laptop timing is not the same path. |
| `fetch_failed` | Transport/redirect failure; no raw exception is logged. Verify canonical hostname and routing without sending credentials to alternative hosts. |
| `invalid_json`, 200 | Response arrived but could not be decoded as JSON; inspect route selection, not secret contents. |

Valid JSON with an invalid identity shape still fails closed in the existing schema guard. It is not automatically a transport failure.

## Deployment instructions (not executed)

1. Review this PR and use the existing **space-api** deployment pipeline after approval. Verify the deployed artifact includes `redirect: "manual"` in the bridge. Keep the existing compatibility date, public-fetch flag and any other deployed flags; no new compatibility setting is required. Applying only a flag to an old artifact will not fix its unsupported Request options. Do not create a Pages project, change DNS, or migrate accounts for this fix.
2. No new secret, key rotation, service binding, D1 migration or timeout increase is needed. Keep `ACCOUNTS_API_KEY` in Cloudflare secrets for the intended API environment and matching accounts environment; do not paste values into commands, logs or PR comments. Do not deploy a preview against production accounts using production credentials merely to reproduce the issue.
3. Run `npm run test:accounts` on Node 24 for the six isolated bridge tests, and `npm run test:accounts:runtime` with installed dependencies for the native workerd reproduction. The latter creates no network requests or sockets. It uses compatibility date `2026-07-30` to match the locally available workerd and retains the public-fetch flag; current upstream workerd source confirms the same unconditional rejection. The Node tests cover manual request options, credentials isolation, 301/302/303/307/308 rejection, guest/401 behavior and sanitized error categories. Native TypeScript transformation uses an experimental Node flag in the Node test command only; production remains Wrangler-bundled TypeScript.
4. After approval and rollout, use a fresh account-issued token through the normal signed-in client and verify `/v1/players/me` returns 200. Verify a revoked/expired token returns 401 and a guest `/v1/session` remains 200 with guest data. Never put a JWT in a shell command/history or request URL. If a 503 remains, inspect only the allowlisted bridge warning fields to select the next check above. Do not assume this PR has confirmed production recovery until that check occurs.
5. Roll back through the normal deployment pipeline if necessary; no data rollback or DNS action is involved. Do not remove authentication checks as a workaround.

Validation for the manual-mode fix: six targeted Node tests and one native workerd test passed; `git diff --check` passed. The runtime test was invoked using the installed Windows workerd binary directly because npm executable shims are absent in the partial local installation. No dependency install, full integration suite, typecheck or production build was run; no live authenticated verification was attempted. README content is unchanged. The older `validation.md` records initial implementation checks, not the outcome of this fix.
