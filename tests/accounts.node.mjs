// Run on Node 24 without installing the D1/Worker integration-test toolchain.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Native TS execution needs an explicit extension for this bundler-style import.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === new URL('../src/accounts.ts', import.meta.url).href && specifier === './http')
    return nextResolve('./http.ts', context);
  return nextResolve(specifier, context);
} });
const { session, directory } = await import('../src/accounts.ts');
const env = { ACCOUNTS_API_KEY: 'synthetic-service-key-for-tests-only-123456' };
const token = 'synthetic-token-for-tests-only';
const request = () => new Request('https://api.retrac.space/v1/players/me', { headers: {
  Authorization: `Bearer ${token}`, Origin: 'https://pong.retrac.space', Cookie: 'private=test',
} });
afterEach(() => mock.restoreAll());

test('public fetch routing is explicitly enabled in the deployment config', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.ok(config.compatibility_flags.includes('global_fetch_strictly_public'));
});

test('session and directory use canonical HTTPS, bounded fetch, and only bridge headers', async () => {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return Response.json(url.endsWith('/session') ? { id: 'test-id', username: 'tester' } : [{ id: 'test-id', username: 'tester' }]);
  });
  assert.deepEqual(await session(request(), env), { id: 'test-id', username: 'tester' });
  assert.deepEqual(await directory(env, { ids: ['test-id'] }), [{ id: 'test-id', username: 'tester' }]);
  for (const { url, init } of calls) {
    assert.ok(['https://accounts.retrac.space/api/internal/games/session', 'https://accounts.retrac.space/api/internal/games/players'].includes(url));
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('X-Space-Api-Key'), env.ACCOUNTS_API_KEY);
    assert.equal(headers.get('Cookie'), null); assert.equal(headers.get('Origin'), null);
    assert.deepEqual([...headers.keys()].sort(), url.endsWith('/session') ?
      ['authorization', 'content-type', 'x-space-api-key'] : ['content-type', 'x-space-api-key']);
    if (url.endsWith('/session')) {
      assert.equal(headers.get('Authorization'), `Bearer ${token}`);
      assert.equal(init.body, '{}');
    }
  }
});

test('missing optional auth remains a guest; upstream 401 remains invalid_session', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 401 }));
  const warn = mock.method(console, 'warn', () => {});
  assert.equal(await session(new Request('https://api.retrac.space/v1/session'), env, true), null);
  assert.equal(fetch.mock.callCount(), 0);
  await assert.rejects(session(request(), env), { status: 401, code: 'invalid_session' });
  assert.equal(warn.mock.callCount(), 0);
});

test('failures emit only sanitized categories/status/timing and preserve the public 503', async () => {
  const sensitive = `${token} ${env.ACCOUNTS_API_KEY} private=test private-account-data`;
  for (const scenario of [
    { reason: 'upstream_status', status: 403, response: () => new Response(sensitive, { status: 403 }) },
    { reason: 'upstream_status', status: 530, response: () => new Response(sensitive, { status: 530 }) },
    { reason: 'timeout', response: () => { throw new DOMException(sensitive, 'TimeoutError'); } },
    { reason: 'worker_routing', response: () => { throw new Error(`error code: 1042 ${sensitive}`); } },
    { reason: 'fetch_failed', response: () => { throw new Error(sensitive); } },
    { reason: 'invalid_json', status: 200, response: () => new Response(sensitive) },
  ]) {
    const fetch = mock.method(globalThis, 'fetch', scenario.response);
    const warn = mock.method(console, 'warn', () => {});
    await assert.rejects(session(request(), env), { status: 503, code: 'accounts_unavailable' });
    assert.equal(warn.mock.callCount(), 1);
    const args = warn.mock.calls[0].arguments;
    assert.equal(args.length, 1);
    const record = args[0];
    assert.deepEqual(Object.keys(record).sort(), scenario.status === undefined ?
      ['elapsedMs', 'event', 'operation', 'reason'] : ['elapsedMs', 'event', 'operation', 'reason', 'upstreamStatus']);
    assert.equal(record.event, 'accounts_bridge_failure'); assert.equal(record.operation, 'session');
    assert.equal(record.reason, scenario.reason); assert.equal(record.upstreamStatus, scenario.status);
    assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0);
    assert.ok(!JSON.stringify(args).includes(sensitive));
    assert.ok(!JSON.stringify(args).includes(token));
    assert.ok(!JSON.stringify(args).includes(env.ACCOUNTS_API_KEY));
    fetch.mock.restore(); warn.mock.restore();
  }
});

test('missing bridge configuration fails closed without fetching or printing the key', async () => {
  const fetch = mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  const warn = mock.method(console, 'warn', () => {});
  await assert.rejects(session(request(), { ACCOUNTS_API_KEY: '' }), { status: 503, code: 'accounts_unavailable' });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(warn.mock.calls[0].arguments[0].reason, 'configuration');
});
