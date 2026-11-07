import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import worker from '../worker.mjs';

const ORIGIN = 'https://helper.example';
const TTL = 365 * 24 * 60 * 60;
const env = Object.freeze({ CONNECT_CODE: randomBytes(48).toString('base64url'), SIGNING_KEY: randomBytes(48).toString('base64url') });
const deviceId = 'device-A_123';
const email = 'owner@example.com';
const verifyPath = '/api/v2/license/verify';
const refreshPath = '/api/v2/license/refresh';
const now = () => Math.floor(Date.now() / 1000);
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
function signed(payload, header = { alg: 'HS256', typ: 'JWT' }, key = env.SIGNING_KEY) {
  const content = `${encode(header)}.${encode(payload)}`;
  return `${content}.${createHmac('sha256', key).update(content).digest('base64url')}`;
}
function claims(overrides = {}) {
  const iat = now() - 60;
  return { deviceId, licenseKey: '2ddbe41b-57e7-4c7f-a540-f7cb04789b6c', email,
    plan: 'ULTIMATE_EDITION', type: 'personal', licenseServerUrl: ORIGIN,
    iat, exp: iat + TTL, createdAt: new Date(iat * 1000).toISOString(),
    updatedAt: new Date(iat * 1000).toISOString(), ...overrides };
}
async function call(path, body, options = {}) {
  const headers = { 'content-type': 'application/json', ...options.headers };
  const request = new Request(`${options.origin ?? ORIGIN}${path}`, {
    method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers,
    ...(body === undefined ? {} : { body: options.raw ? body : JSON.stringify(body) }),
  });
  const response = await worker.fetch(request, options.env ?? env);
  const text = await response.text();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(!text.includes(env.CONNECT_CODE), 'connection code must never be returned');
  assert.ok(!text.includes(env.SIGNING_KEY), 'signing key must never be returned');
  return { status: response.status, data: JSON.parse(text), headers: response.headers, text };
}
const activate = (id = deviceId, options = {}) => call('/api/v2/license/activate', { deviceId: id, email, licenseKey: env.CONNECT_CODE }, options);
const verify = (licenseToken, id = deviceId, options = {}) => call(verifyPath, { deviceId: id, licenseToken }, options);
const refresh = (licenseToken, id = deviceId, options = {}) => call(refreshPath, { deviceId: id, licenseToken }, options);

// Removing auth, bounds or any signature/claim check makes the corresponding assertions fail.
test('health is public, versioned and secret-free even when unconfigured', async () => {
  const healthy = await call('/health');
  assert.equal(healthy.status, 200);
  assert.deepEqual(healthy.data, { status: 'ok', protocolVersion: 1, service: 'bruno-helper', configured: true });
  assert.deepEqual((await call('/health', undefined, { env: {} })).data, { status: 'not-configured', protocolVersion: 1, service: 'bruno-helper', configured: false });
});

test('activation returns a standard independently verifiable HS256 JWT with complete claims', async () => {
  const result = await activate();
  assert.equal(result.status, 200);
  const token = result.data.licenseToken;
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  assert.equal(signature, createHmac('sha256', env.SIGNING_KEY).update(`${header}.${payload}`).digest('base64url'));
  const data = decode(token);
  assert.deepEqual(Object.keys(data).sort(), Object.keys(claims()).sort());
  assert.equal(data.deviceId, deviceId);
  assert.equal(data.email, email);
  assert.equal(data.plan, 'ULTIMATE_EDITION');
  assert.equal(data.type, 'personal');
  assert.equal(data.licenseServerUrl, ORIGIN);
  assert.match(data.licenseKey, /^[0-9a-f-]{36}$/);
  assert.equal(data.exp - data.iat, TTL);
  assert.ok(Math.abs(now() - data.iat) <= 2);
  assert.equal(data.createdAt, data.updatedAt);
  assert.equal(Date.parse(data.updatedAt), data.iat * 1000);
  assert.ok(!JSON.stringify(data).includes(env.SIGNING_KEY));
  assert.ok(!JSON.stringify(data).includes(env.CONNECT_CODE));
  assert.deepEqual((await verify(token)).data, {
    verified: true, subscription: { plan: 'ULTIMATE_EDITION' }, needsRefresh: false, trial: null, aiPolicy: null,
  });
});

test('multiple devices activate independently and cannot cross-verify', async () => {
  const [a, b] = await Promise.all([activate('device-A'), activate('device-B')]);
  assert.notEqual(decode(a.data.licenseToken).licenseKey, decode(b.data.licenseToken).licenseKey);
  assert.equal((await verify(a.data.licenseToken, 'device-A')).data.verified, true);
  assert.equal((await verify(b.data.licenseToken, 'device-B')).data.verified, true);
  assert.equal((await verify(a.data.licenseToken, 'device-B')).data.verified, false);
});

test('refresh preserves identity and creation time, renews TTL and returns a valid token', async () => {
  const old = claims();
  const response = await refresh(signed(old));
  assert.equal(response.status, 200);
  assert.equal(response.data.aiPolicy, null);
  const updated = decode(response.data.licenseToken);
  for (const field of ['deviceId', 'licenseKey', 'email', 'plan', 'type', 'licenseServerUrl', 'createdAt']) {
    assert.equal(updated[field], old[field]);
  }
  assert.ok(updated.iat > old.iat);
  assert.equal(updated.exp - updated.iat, TTL);
  assert.equal(Date.parse(updated.updatedAt), updated.iat * 1000);
  assert.equal((await verify(response.data.licenseToken)).data.verified, true);
});

test('near-expiry valid token requests refresh; expiration is a strict boundary', async () => {
  assert.equal((await verify(signed(claims({ exp: now() + 60 })))).data.needsRefresh, true);
  assert.equal((await verify(signed(claims({ exp: now() })))).data.verified, false);
});

test('rejects tampering, wrong key/device, expired tokens, future issuance and excessive lifetime', async () => {
  const original = signed(claims());
  const pieces = original.split('.');
  pieces[1] = encode(claims({ email: 'changed@example.com' }));
  const cases = [
    pieces.join('.'), signed(claims(), undefined, 'wrong-key'.repeat(8)),
    signed(claims({ deviceId: 'device-B' })), signed(claims({ exp: now() - 1 })),
    signed(claims({ iat: now() + 100 })), signed(claims({ exp: now() + TTL + 1000 })),
    signed(claims({ iat: 1.5 })), signed(claims({ exp: '9999999999' })),
    signed(claims({ exp: null })), signed(claims({ plan: 'OTHER' })),
    signed(claims({ type: 'team' })), signed(claims({ licenseKey: '' })),
    signed(claims({ createdAt: 'invalid' })), signed(claims({ updatedAt: 'invalid' })),
    signed(claims({ email: 'invalid' })), signed(claims({ extra: 'unexpected' })),
  ];
  for (const token of cases) {
    const result = await verify(token);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { verified: false, subscription: null, needsRefresh: false, trial: null, aiPolicy: null });
    assert.equal((await refresh(token)).status, 401);
  }
});

test('strict algorithm/header/base64url/signature parsing rejects confusion and malformed JWTs', async () => {
  const token = signed(claims());
  for (const invalid of [
    'not-a-token', `${token}.extra`, token.slice(0, -4), `${token}=`,
    `${token.split('.').slice(0, 2).join('.')}.`,
    signed(claims(), { alg: 'none', typ: 'JWT' }),
    signed(claims(), { alg: 'HS512', typ: 'JWT' }),
    signed(claims(), { alg: 'HS256', typ: 'JWT', crit: ['exp'] }),
    signed(claims(), { alg: 'HS256', typ: 'JWT', jwk: { k: env.SIGNING_KEY } }),
    signed(claims(), { alg: 'HS256', typ: 'OTHER' }),
    signed(null), signed([]),
  ]) {
    assert.equal((await verify(invalid)).data.verified, false);
  }
});

test('binds tokens to origin and ignores forwarded host headers', async () => {
  const result = await activate(deviceId, { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', origin: 'https://evil.example' } });
  assert.equal(decode(result.data.licenseToken).licenseServerUrl, ORIGIN);
  assert.equal((await verify(result.data.licenseToken, deviceId, { origin: 'https://other.example' })).data.verified, false);
  assert.equal((await verify(signed(claims({ licenseServerUrl: 'https://evil.example' })))).data.verified, false);
  const configured = { ...env, PUBLIC_ORIGIN: 'https://public.example/' };
  const issued = await activate(deviceId, { env: configured });
  assert.equal(decode(issued.data.licenseToken).licenseServerUrl, 'https://public.example');
  assert.equal((await verify(issued.data.licenseToken, deviceId, { env: configured, origin: 'https://internal.example' })).data.verified, true);
  assert.equal((await verify(issued.data.licenseToken)).data.verified, false);
});

test('bad secret configuration and invalid public origins fail closed without leakage', async () => {
  const badConfigs = [ {}, { ...env, SIGNING_KEY: 'short' }, { ...env, CONNECT_CODE: 'short' },
    { ...env, SIGNING_KEY: ' '.repeat(40) }, { ...env, CONNECT_CODE: 'x'.repeat(513) },
    ...['', 'http://remote.example', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?x=y', 'https://example.com#x', 'file:///tmp', 'not a url'].map(PUBLIC_ORIGIN => ({ ...env, PUBLIC_ORIGIN })),
  ];
  for (const config of badConfigs) {
    assert.equal((await call('/health', undefined, { env: config })).data.configured, false);
    const result = await activate(deviceId, { env: config });
    assert.equal(result.status, 503);
    assert.deepEqual(result.data, { error: 'service_unavailable' });
  }
});

test('supports explicit local HTTP origins for development only', async () => {
  for (const origin of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
    const result = await activate(deviceId, { origin });
    assert.equal(result.status, 200);
    assert.equal(decode(result.data.licenseToken).licenseServerUrl, origin);
  }
  assert.equal((await activate(deviceId, { origin: 'http://remote.example' })).status, 503);
});

test('bounds input fields, token length, JSON shape and content type', async () => {
  for (const body of [null, [], {}, { deviceId, email: 'broken' }, { deviceId: 'x'.repeat(129), email }, { deviceId: 'x\n', email }, { deviceId: '', email }, { deviceId, email: `a@${'x'.repeat(254)}.com` }]) {
    const activationBody = body && !Array.isArray(body) ? { ...body, licenseKey: env.CONNECT_CODE } : body;
    assert.equal((await call('/api/v2/license/activate', activationBody)).status, 400);
  }
  for (const body of [{ deviceId, licenseToken: 'x'.repeat(4097) }, { deviceId, licenseToken: '' }, { deviceId, licenseToken: 1 }]) {
    assert.equal((await call(verifyPath, body)).status, 400);
  }
  assert.equal((await call(verifyPath, '{', { raw: true })).status, 400);
  assert.equal((await call(verifyPath, '{}', { raw: true, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call(verifyPath, {}, { headers: { 'content-encoding': 'gzip' } })).status, 415);
});

test('body byte limit enforced with Content-Length, missing length and streaming chunks', async () => {
  const body = JSON.stringify({ deviceId, licenseToken: 'x'.repeat(9000) });
  assert.equal((await call(verifyPath, body, { raw: true, headers: { 'content-length': String(Buffer.byteLength(body)) } })).status, 413);
  assert.equal((await call(verifyPath, body, { raw: true })).status, 413);
  assert.equal((await call(verifyPath, body, { raw: true, headers: { 'content-length': '1' } })).status, 413);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4096)); controller.enqueue(new Uint8Array(4097)); controller.close(); } });
  const response = await worker.fetch(new Request(`${ORIGIN}${verifyPath}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' }), env);
  assert.equal(response.status, 413);
});

test('routes reject wrong methods and unauthenticated activation', async () => {
  assert.equal((await call('/health', {})).status, 405);
  assert.equal((await call(verifyPath)).status, 405);
  assert.equal((await call('/api/v2/license/activate', { deviceId, email, licenseKey: 'anything' })).status, 401);
  assert.equal((await call('/missing')).status, 404);
});

test('invalid tokens are never reflected and worker makes no console calls', async (t) => {
  const logs = [];
  for (const method of ['log', 'error', 'warn', 'info', 'debug']) t.mock.method(console, method, (...args) => logs.push(args));
  const token = signed(claims(), undefined, 'not-the-right-key'.repeat(3));
  assert.ok(!(await verify(token)).text.includes(token));
  assert.ok(!(await refresh(token)).text.includes(token));
  assert.equal((await activate()).status, 200);
  assert.deepEqual(logs, []);
});

test('verify and refresh accept bounded Bruno client metadata alongside required fields', async () => {
  const { data: { licenseToken } } = await activate();
  const body = { deviceId, licenseToken, appDistinctId: 'installation-123', clientVersion: '3.0.0', platform: 'win32', clientContext: { arch: 'x64' } };
  const verified = await call(verifyPath, body);
  assert.equal(verified.status, 200);
  assert.equal(verified.data.verified, true);
  const renewed = await call(refreshPath, body);
  assert.equal(renewed.status, 200);
  assert.equal((await verify(renewed.data.licenseToken)).data.verified, true);
  assert.equal((await call(verifyPath, { deviceId, appDistinctId: 'installation-123' })).status, 400);
  assert.equal((await call(verifyPath, { ...body, clientContext: 'x'.repeat(8192) })).status, 413);
});


test('native activation supports Bruno metadata and produces a device-bound refreshable token', async () => {
  const result = await call('/api/v2/license/activate', {
    deviceId, email, licenseKey: env.CONNECT_CODE, licenseServerUrl: ORIGIN,
    deviceName: 'test-computer', appDistinctId: 'installation-123', platform: 'darwin',
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.aiPolicy, null);
  const payload = decode(result.data.licenseToken);
  assert.equal(payload.email, email);
  assert.equal(payload.deviceId, deviceId);
  assert.notEqual(payload.licenseKey, env.CONNECT_CODE);
  assert.equal((await verify(result.data.licenseToken)).data.verified, true);
  assert.equal((await verify(result.data.licenseToken, 'other-device')).data.verified, false);
  assert.equal((await refresh(result.data.licenseToken)).status, 200);
});

test('native activation requires the real key and validates identity, origin and body limits', async () => {
  const base = { deviceId, email, licenseKey: env.CONNECT_CODE, licenseServerUrl: ORIGIN };
  for (const licenseKey of ['', 'anything', env.CONNECT_CODE.slice(1), 'x'.repeat(513), null]) {
    assert.equal((await call('/api/v2/license/activate', { ...base, licenseKey })).status, 401);
  }
  for (const changes of [{email:'bad'}, {deviceId:''}, {licenseServerUrl:'https://other.example'}, {licenseServerUrl:'not-url'}]) {
    assert.equal((await call('/api/v2/license/activate', {...base, ...changes})).status, 400);
  }
  assert.equal((await call('/api/v2/license/activate', {...base, context:'x'.repeat(8192)})).status, 413);
  assert.equal((await call('/api/v2/license/activate')).status, 405);
  assert.equal((await call('/api/v2/license/activate', base, {env:{}})).status, 503);
  assert.equal((await call('/api/v2/license/activate', {...base, licenseServerUrl: ORIGIN + '/'})).status, 200);
});


test('standalone service removes the old helper-only enrollment API', async () => {
  const result = await call('/api/client/enroll', {deviceId, email}, {headers:{authorization:`Bearer ${env.CONNECT_CODE}`}});
  assert.equal(result.status, 404);
  assert.deepEqual(result.data, {error:'not_found'});
});
