import { ApiError } from './http';

export interface Identity { id: string; username: string | null }
export interface AccountEnv { ACCOUNTS_API_KEY: string }
const base = 'https://accounts.retrac.space/api/internal/games/';
type Operation = 'session' | 'players';
type Failure = 'configuration' | 'upstream_status' | 'upstream_redirect' | 'unsupported_redirect' | 'timeout' | 'worker_routing' | 'fetch_failed' | 'invalid_json';

function diagnostic(operation: Operation, reason: Failure, started: number, upstreamStatus?: number) {
  // Construct an allowlisted record. Never pass request/response objects, bodies,
  // headers, URLs, exception messages/stacks or account identities to the logger.
  console.warn({ event: 'accounts_bridge_failure', operation, reason,
    elapsedMs: Math.max(0, Date.now() - started), ...(upstreamStatus === undefined ? {} : { upstreamStatus }) });
}

// Accounts owns all token and live session validation. Never forward cookies.
async function call(env: AccountEnv, path: Operation, body: unknown, token?: string): Promise<unknown> {
  const started = Date.now();
  if (!env.ACCOUNTS_API_KEY || env.ACCOUNTS_API_KEY.length < 32) {
    diagnostic(path, 'configuration', started);
    throw new ApiError(503, 'accounts_unavailable');
  }
  let stage: 'fetch' | 'json' = 'fetch';
  let upstreamStatus: number | undefined;
  const signal = AbortSignal.timeout(5000);
  try {
    const response = await fetch(base + path, {
      // Workers rejects redirect: 'error' during Request construction. Manual
      // mode sends the request but never forwards bridge credentials elsewhere.
      method: 'POST', redirect: 'manual', signal,
      headers: { 'Content-Type': 'application/json', 'X-Space-Api-Key': env.ACCOUNTS_API_KEY,
        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    upstreamStatus = response.status;
    if (response.status === 401 && path === 'session') throw new ApiError(401, 'invalid_session');
    if (!response.ok) {
      diagnostic(path, response.status >= 300 && response.status < 400 ? 'upstream_redirect' : 'upstream_status', started, upstreamStatus);
      throw new ApiError(503, 'accounts_unavailable');
    }
    stage = 'json';
    return await response.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const reason: Failure = signal.aborted || (error instanceof Error && error.name === 'TimeoutError') ? 'timeout' :
      stage === 'json' ? 'invalid_json' :
      error instanceof TypeError && error.message.startsWith('Invalid redirect value, must be one of "follow" or "manual"') ? 'unsupported_redirect' :
      error instanceof Error && /\b1042\b/.test(error.message) ? 'worker_routing' : 'fetch_failed';
    diagnostic(path, reason, started, upstreamStatus);
    throw new ApiError(503, 'accounts_unavailable');
  }
}
function identity(value: unknown): Identity {
  const v = value as Identity | null;
  if (!v || typeof v.id !== 'string' || !v.id || v.id.length > 256 ||
      !(v.username === null || (typeof v.username === 'string' && /^[a-z0-9_]{3,20}$/.test(v.username))))
    throw new ApiError(503, 'accounts_unavailable');
  return { id: v.id, username: v.username };
}
export async function session(request: Request, env: AccountEnv, optional = false): Promise<Identity | null> {
  const auth = request.headers.get('Authorization');
  if (!auth && optional) return null;
  if (!auth || !/^Bearer [^\s]{1,8192}$/.test(auth)) throw new ApiError(401, 'authentication_required');
  const user = identity(await call(env, 'session', {}, auth.slice(7)));
  if (!user.username) throw new ApiError(403, 'username_required');
  return user;
}
export async function directory(env: AccountEnv, query: { ids: string[] } | { username: string }): Promise<Identity[]> {
  const value = await call(env, 'players', query);
  if (!Array.isArray(value) || value.length > 100) throw new ApiError(503, 'accounts_unavailable');
  const result = value.map(identity);
  if (new Set(result.map(u => u.id)).size !== result.length || result.some(u =>
    'ids' in query ? !query.ids.includes(u.id) : u.username !== query.username))
    throw new ApiError(503, 'accounts_unavailable');
  return result;
}
