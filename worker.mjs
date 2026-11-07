/** Stateless license service. Cloudflare Web APIs only; no runtime dependencies. */
const TTL_SECONDS = 365 * 24 * 60 * 60;
const REFRESH_WINDOW_SECONDS = 30 * 24 * 60 * 60;
const MAX_BODY_BYTES = 8192;
const MAX_TOKEN_CHARS = 4096;
const PLAN = 'ULTIMATE_EDITION';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const PAYLOAD_KEYS = ['deviceId', 'licenseKey', 'email', 'plan', 'type', 'licenseServerUrl', 'iat', 'exp', 'createdAt', 'updatedAt'];
const POST_ROUTES = new Set(['/api/v2/license/activate', '/api/v2/license/verify', '/api/v2/license/refresh']);

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  });
}
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}
function validDevice(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}
function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[\x21-\x7e]+$/.test(value)
    && /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/.test(value);
}
function validSecret(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);
}
function validatedOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('origin');
  const parsed = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (!(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback))
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.pathname !== '/' || (value !== parsed.origin && value !== `${parsed.origin}/`)) {
    throw new Error('origin');
  }
  return parsed.origin;
}
function config(env, request) {
  if (!validSecret(env?.CONNECT_CODE) || !validSecret(env?.SIGNING_KEY)) throw new Error('configuration');
  const origin = validatedOrigin(env.PUBLIC_ORIGIN === undefined ? new URL(request.url).origin : env.PUBLIC_ORIGIN);
  return { origin, connectCode: env.CONNECT_CODE, signingKey: env.SIGNING_KEY };
}

async function readJson(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type');
  }
  const encoding = request.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') throw new HttpError(415, 'unsupported_media_type');
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) throw new HttpError(400, 'invalid_request');
    if (Number(declared) > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large');
  }
  if (!request.body) throw new HttpError(400, 'invalid_request');
  const reader = request.body.getReader();
  // Fixed allocation bounds retained memory even if a caller sends many tiny chunks.
  const bytes = new Uint8Array(MAX_BODY_BYTES);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new HttpError(413, 'body_too_large');
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    return JSON.parse(decoder.decode(bytes.subarray(0, size)));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_request');
  } finally {
    reader.releaseLock();
  }
}
function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unbase64url(value) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('encoding');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0));
  if (base64url(bytes) !== value) throw new Error('encoding');
  return bytes;
}
function encodeJson(value) { return base64url(encoder.encode(JSON.stringify(value))); }
function decodeJson(value) { return JSON.parse(decoder.decode(unbase64url(value))); }
async function hmacKey(secret, usage) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}
async function matchesCode(candidate, code) {
  if (!validSecret(candidate)) return false;
  // Compare fixed-size digests instead of early-exit plaintext string equality.
  const [provided, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(candidate)),
    crypto.subtle.digest('SHA-256', encoder.encode(code)),
  ]);
  const a = new Uint8Array(provided);
  const b = new Uint8Array(expected);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}
function validTimestamp(value) {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}
function validClaims(payload, deviceId, origin, now) {
  if (!exactKeys(payload, PAYLOAD_KEYS)) return false;
  if (!validDevice(payload.deviceId) || payload.deviceId !== deviceId || !validEmail(payload.email)
      || payload.plan !== PLAN || payload.type !== 'personal' || payload.licenseServerUrl !== origin
      || typeof payload.licenseKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(payload.licenseKey)) return false;
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
      || payload.iat < 0 || payload.iat > now || payload.exp <= now || payload.exp <= payload.iat
      || payload.exp - payload.iat > TTL_SECONDS) return false;
  return validTimestamp(payload.createdAt) && validTimestamp(payload.updatedAt)
    && Date.parse(payload.createdAt) <= Date.parse(payload.updatedAt)
    && Date.parse(payload.createdAt) >= 0 && Date.parse(payload.updatedAt) === payload.iat * 1000;
}
async function verifyToken(token, deviceId, settings) {
  try {
    const pieces = token.split('.');
    if (pieces.length !== 3 || pieces[0].length > 128) return null;
    const [headerPart, payloadPart, signaturePart] = pieces;
    const header = decodeJson(headerPart);
    if (!exactKeys(header, ['alg', 'typ']) || header.alg !== 'HS256' || header.typ !== 'JWT') return null;
    const signature = unbase64url(signaturePart);
    if (signature.byteLength !== 32) return null;
    const key = await hmacKey(settings.signingKey, 'verify');
    if (!await crypto.subtle.verify('HMAC', key, signature, encoder.encode(`${headerPart}.${payloadPart}`))) return null;
    const payload = decodeJson(payloadPart);
    return validClaims(payload, deviceId, settings.origin, Math.floor(Date.now() / 1000)) ? payload : null;
  } catch {
    return null;
  }
}
async function issueToken(deviceId, email, settings, previous = null) {
  const iat = Math.floor(Date.now() / 1000);
  const timestamp = new Date(iat * 1000).toISOString();
  const payload = {
    deviceId, licenseKey: previous?.licenseKey ?? crypto.randomUUID(), email,
    plan: PLAN, type: 'personal', licenseServerUrl: settings.origin,
    iat, exp: iat + TTL_SECONDS, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp,
  };
  const content = `${encodeJson({ alg: 'HS256', typ: 'JWT' })}.${encodeJson(payload)}`;
  const key = await hmacKey(settings.signingKey, 'sign');
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(content));
  return `${content}.${base64url(new Uint8Array(signature))}`;
}

export default {
  async fetch(request, env) {
    try {
      const path = new URL(request.url).pathname;
      if (path !== '/health' && !POST_ROUTES.has(path)) return json({ error: 'not_found' }, 404);
      const expectedMethod = path === '/health' ? 'GET' : 'POST';
      if (request.method !== expectedMethod) return json({ error: 'method_not_allowed' }, 405, { allow: expectedMethod });
      let settings;
      try { settings = config(env, request); } catch { /* Configuration details stay server-side. */ }
      if (path === '/health') return json({ status: settings ? 'ok' : 'not-configured', protocolVersion: 1, service: 'bruno-helper', configured: Boolean(settings) });
      if (!settings) return json({ error: 'service_unavailable' }, 503);
      const body = await readJson(request);
      const nativeActivation = path === '/api/v2/license/activate';
      const fields = nativeActivation ? ['deviceId', 'email', 'licenseKey'] : ['deviceId', 'licenseToken'];
      const validBody = body !== null && typeof body === 'object' && !Array.isArray(body)
          && fields.every(field => Object.hasOwn(body, field));
      if (!validBody || !validDevice(body.deviceId)) throw new HttpError(400, 'invalid_request');
      if (nativeActivation) {
        if (!await matchesCode(body.licenseKey, settings.connectCode)) throw new HttpError(401, 'invalid_license_key');
        if (!validEmail(body.email)) throw new HttpError(400, 'invalid_request');
        if (body.licenseServerUrl !== undefined) {
          let origin;
          try { origin = validatedOrigin(body.licenseServerUrl); } catch { throw new HttpError(400, 'invalid_request'); }
          if (origin !== settings.origin) throw new HttpError(400, 'invalid_request');
        }
        return json({ licenseToken: await issueToken(body.deviceId, body.email, settings), aiPolicy: null });
      }
      if (typeof body.licenseToken !== 'string' || body.licenseToken.length < 1 || body.licenseToken.length > MAX_TOKEN_CHARS) {
        throw new HttpError(400, 'invalid_request');
      }
      const payload = await verifyToken(body.licenseToken, body.deviceId, settings);
      if (path === '/api/v2/license/verify') {
        return json({
          verified: Boolean(payload), subscription: payload ? { plan: PLAN } : null,
          needsRefresh: Boolean(payload && payload.exp - Math.floor(Date.now() / 1000) <= REFRESH_WINDOW_SECONDS),
          trial: null, aiPolicy: null,
        });
      }
      if (!payload) return json({ error: 'invalid_license' }, 401);
      return json({ licenseToken: await issueToken(body.deviceId, payload.email, settings, payload), aiPolicy: null });
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.code }, error.status);
      // Never return exception text, request headers, body, secrets or tokens.
      return json({ error: 'internal_error' }, 500);
    }
  },
};
