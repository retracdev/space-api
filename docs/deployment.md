# Deployment plan — no live resources changed

For the account bridge's runtime routing flag, sanitized diagnostics and the current fix rollout, see [auth-bridge-routing.md](auth-bridge-routing.md). The original launch plan below predates the deployed accounts bridge and dedicated database configuration.

Use a personal Cloudflare account and a dedicated `space-api` D1 database. Do not bind any Retrac Labs resource, the accounts database, or website assets. `wrangler.jsonc` intentionally contains a placeholder database UUID and no routes/custom domains. No production deployment, remote migration, paid provisioning or DNS action is authorized by this implementation.

## Domain decision

Vercel remains authoritative DNS for retrac.space. Do not change nameservers, delegate subdomains or modify the apex website. Cloudflare's documented [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) require an active Cloudflare zone and do not permit a hostname with an existing CNAME. A plain Vercel CNAME to workers.dev does not register the hostname, certificate or Worker routing. Do not assume this works.

Cloudflare [partial CNAME zones](https://developers.cloudflare.com/dns/zone-setups/partial-setup/) retain external authoritative DNS but require Business or Enterprise. That is not the preferred free-tier solution, and must not be provisioned automatically. Cloudflare for SaaS would add unnecessary configuration and is out of scope.

The simplest deployment of the requested Worker uses `https://space-api.<personal-account>.workers.dev`, with no DNS edits. Browser bearer authorization works across sites; the API never depends on receiving the accounts cookie. Keep the access-token audience `https://api.retrac.space` as a stable service identifier even when transport uses workers.dev. Configure games with the actual API base URL.

To obtain the intended `api.retrac.space` hostname while retaining Vercel DNS, a practical alternative is the same module on **Cloudflare Pages advanced mode** (a Worker runtime with D1). [Pages supports externally managed subdomain DNS](https://developers.cloudflare.com/pages/configuration/custom-domains/): first associate `api.retrac.space` with a new, separate Pages project, then add only the Vercel `api` CNAME to that project's pages.dev hostname. Pages association must precede DNS to avoid errors. No website changes are necessary. Bundle `src/worker.ts` to a Pages `_worker.js` in a new output directory and bind only its dedicated DB; see [advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/). Do not publish the Workers dist directory blindly. Pages support for rate-limit bindings must be confirmed in the target environment; if unavailable, use the Pages Worker as a tiny gateway to the standalone API Worker and keep limits there. That gateway must forward Authorization and Origin, never account cookies or a browser-provided CF-Connecting-IP; prevent bypass of any gateway-specific trust. This extra gateway is optional, not shipped or required. Prefer workers.dev until the domain arrangement is approved.

## Image storage rollout

Bind the existing `space-storage` R2 bucket as `SPACE_STORAGE` (also declared in `wrangler.jsonc`; no storage credentials). With explicit approval, apply `migrations/0002_storage_images.sql` remotely before deploying the storage code. Confirm the account service issues tokens to `https://glow.retrac.space`. See [storage.md](storage.md).

## Approval-dependent launch checklist

1. Review and implement the separate account integration described in `accounts-integration.md`. Verify live revocation, deleted users, denied sibling origins and missing-session guest behavior there. Generate a dedicated bridge key through a secure secret-entry mechanism; never paste it into git or logs.
2. With explicit approval, create the dedicated free-tier D1 database and replace the placeholder UUID. Set `ACCOUNTS_API_KEY` via `wrangler secret put ACCOUNTS_API_KEY`. Set the matching secret on accounts. No Better Auth/OAuth secret belongs here.
3. Review seed game definitions and exact browser origins. Remove origins for games whose hosting is not controlled. Add the same approved game origins to the separately reviewed account token/session CORS configuration. Localhost is absent in production.
4. Run `npm ci`, `npm run db:migrate` (local), `npm run typecheck`, `npm test`, and `npm run build`. With explicit approval, apply migrations remotely using `npx wrangler d1 migrations apply space-api --remote`, then deploy with `npx wrangler deploy`. These commands use the personal account selected by the operator; inspect `wrangler whoami` before any remote action.
5. Smoke-check guest reads and live authenticated saves from one approved game. Check sign-out revokes API use, the foreign-origin preflight fails, account deletion hides profile/score data, and the API returns no private fields. No exhaustive integration suite is necessary for this project.

Workers/D1 free-tier quotas and approximate local rate limits are finite. Monitor the personal account dashboard before expanding usage; do not enable paid plans or extra services automatically. Keep observability logs free of headers, tokens and save payloads.
