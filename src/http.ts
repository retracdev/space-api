export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function fail(status: number, code: string): never { throw new ApiError(status, code); }
export function ok(data: unknown, status = 200): Response { return Response.json({ data }, { status }); }
export async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail(415, 'json_required');
  if (Number(request.headers.get('content-length')) > 66560) fail(413, 'body_too_large');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'invalid_json');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    size += next.value.length;
    if (size > 66560) { await reader.cancel(); fail(413, 'body_too_large'); }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { fail(400, 'invalid_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_body');
  return value as Record<string, unknown>;
}
export function only(value: Record<string, unknown>, key: string) {
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, key)) fail(400, 'invalid_body');
}
export function identifier(s: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(s)) fail(400, 'invalid_identifier');
  return s;
}
export function integer(s: string | null, fallback: number, min: number, max: number): number {
  if (s === null) return fallback;
  if (!/^\d+$/.test(s) || Number(s) < min || Number(s) > max) fail(400, 'invalid_pagination_or_slot');
  return Number(s);
}
