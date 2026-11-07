import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ROOT, runWrangler } from '../scripts/wrangler.mjs';

// Exercise the installed Wrangler and the actual custom-build hook against a local API.
// No Cloudflare credentials or network access to Cloudflare are used by this fixture.
async function fixture(t) {
  await mkdir(resolve('.tmp'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp', 'build-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(join(ROOT, 'wrangler.jsonc'), 'utf8'));
  await writeFile(join(root, 'wrangler.jsonc'), JSON.stringify({
    ...config, name: 'configured-worker', main: join(ROOT, 'worker.mjs'),
    build: { command: config.build.command.replace('scripts/init-secrets.mjs',
      '"' + join(ROOT, 'scripts', 'init-secrets.mjs') + '"') },
  }));
  const secrets = {}, requests = [], uploads = [], unexpected = [];
  let exists = false;
  const state = { failCodeUpload: false };
  const workerPath = '/accounts/test-account/workers/scripts/selected-worker';
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname.replace('/client/v4', '');
    requests.push(`${request.method} ${path}`);
    const send = (result, code = 200) => {
      response.writeHead(code, { 'content-type': 'application/json' });
      response.end(JSON.stringify(code === 200 ? { success: true, errors: [], messages: [], result }
        : { success: false, errors: [{ code: 10007, message: 'Worker not found' }], result: null }));
    };
    if (request.method === 'GET' && path === `${workerPath}/secrets`) {
      return send(Object.keys(secrets).map(name => ({ name, type: 'secret_text' })), exists ? 200 : 404);
    }
    if (request.method === 'PATCH' && path === `${workerPath}/secrets-bulk`) {
      if (!exists) return send(null, 404);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      for (const secret of Object.values(body.secrets)) secrets[secret.name] = secret.text;
      return send({});
    }
    if ((request.method === 'PUT' && path === workerPath)
        || (request.method === 'POST' && path === workerPath + '/versions')) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const form = await new Response(Buffer.concat(chunks), {
        headers: { 'content-type': request.headers['content-type'] },
      }).formData();
      const metadata = JSON.parse(form.get('metadata'));
      if (request.method === 'POST' && state.failCodeUpload) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: false, errors: [{ code: 10021, message: 'Test upload failure' }] }));
        return;
      }
      uploads.push(metadata);
      exists = true;
      return send({ id: '11111111-1111-4111-8111-111111111111', etag: 'test-etag', handlers: ['fetch'], startup_time_ms: 1,
        metadata: {}, resources: { script: { startup_time_ms: 1 } },
        deployment_id: '11111111-1111-4111-8111-111111111111' });
    }
    if (request.method === 'GET' && path === `${workerPath}/settings`) {
      return send({ bindings: Object.keys(secrets).map(name => ({ name, type: 'secret_text' })) }, exists ? 200 : 404);
    }
    if (request.method === 'GET' && path === '/accounts/test-account/workers/services/selected-worker') {
      return send({ default_environment: { script: { etag: 'test-etag', handlers: ['fetch'] } } });
    }
    if (request.method === 'POST' && path === workerPath + '/deployments') return send({ id: 'test-deployment' });
    if (request.method === 'GET' && path === workerPath + '/deployments') return send({ deployments: [] });
    if (request.method === 'GET' && path === '/accounts/test-account/workers/workers/selected-worker') return send({ id: 'selected-worker', subdomain: { enabled: true, previews_enabled: false } });
    if (request.method === 'GET' && path === '/accounts/test-account/workers/subdomain') return send({ subdomain: 'test-account' });
    if (request.method === 'PATCH' && path === workerPath + '/script-settings') return send({});
    if (path === `${workerPath}/subdomain`) return send({ enabled: true, previews_enabled: false });
    if (path === `${workerPath}/schedules`) return send({ schedules: [] });
    unexpected.push(`${request.method} ${path}`);
    return send(null, 404);
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); }));
  const environment = { ...process.env, CI: 'true', WORKERS_CI: '1',
    WRANGLER_CI_OVERRIDE_NAME: 'selected-worker', CLOUDFLARE_ACCOUNT_ID: 'test-account',
    CLOUDFLARE_API_TOKEN: 'test-only-token', NO_COLOR: '1',
    CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${server.address().port}/client/v4`,
  };
  delete environment.BRUNO_SKIP_SECRET_INIT;
  return { root, environment, secrets, requests, uploads, unexpected, state };
}

test('default Wrangler deployment initializes a new Worker and keeps secrets on redeploy', { timeout: 60000 }, async t => {
  const remote = await fixture(t);
  const options = { root: remote.root, environment: remote.environment, capture: true, quiet: true };
  const first = await runWrangler(['deploy'], undefined, options);
  assert.equal(first.code, 0, `${first.stderr}\nUnexpected API calls: ${remote.unexpected.join(', ')}`);
  assert.deepEqual(remote.unexpected, []);
  assert.match(remote.secrets.CONNECT_CODE, /^[A-Za-z0-9_-]{64}$/);
  assert.match(remote.secrets.SIGNING_KEY, /^[A-Za-z0-9_-]{64}$/);
  assert.ok(first.stdout.includes(remote.secrets.CONNECT_CODE));
  assert.ok(!`${first.stdout}${first.stderr}`.includes(remote.secrets.SIGNING_KEY));
  assert.ok(remote.uploads.at(-1).keep_bindings.includes('secret_text'));
  const original = { ...remote.secrets };
  const writes = remote.requests.filter(value => value.startsWith('PATCH ') && value.endsWith('/secrets-bulk')).length;
  const second = await runWrangler(['deploy'], undefined, options);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(remote.secrets, original);
  assert.equal(remote.requests.filter(value => value.startsWith('PATCH ') && value.endsWith('/secrets-bulk')).length, writes);
  assert.ok(!second.stdout.includes(original.CONNECT_CODE));
  assert.ok(second.stdout.includes('Existing credentials preserved'));
});

test('project dry-run executes the build hook without contacting Cloudflare even in CI', { timeout: 30000 }, async t => {
  const remote = await fixture(t);
  const result = await runWrangler(['deploy', '--dry-run', '--outdir', join(remote.root, 'output')], undefined,
    { root: remote.root, environment: remote.environment, capture: true, quiet: true });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /custom build/);
  assert.deepEqual(remote.requests, []);
});

test('failed code upload retains the initialized Key for the next deployment', { timeout: 60000 }, async t => {
  const remote = await fixture(t);
  const options = { root: remote.root, environment: remote.environment, capture: true, quiet: true };
  remote.state.failCodeUpload = true;
  const failed = await runWrangler(['deploy'], undefined, options);
  assert.equal(failed.code, 1);
  assert.match(remote.secrets.CONNECT_CODE, /^[A-Za-z0-9_-]{64}$/);
  const original = { ...remote.secrets };
  assert.ok(failed.stdout.includes(original.CONNECT_CODE));
  assert.ok(failed.stdout.includes('Credentials stored'));
  assert.ok(!failed.stdout.includes('Credentials ready'));
  assert.ok(!failed.stdout.includes(original.SIGNING_KEY));
  remote.state.failCodeUpload = false;
  const retried = await runWrangler(['deploy'], undefined, options);
  assert.equal(retried.code, 0, retried.stderr);
  assert.deepEqual(remote.secrets, original);
  assert.ok(retried.stdout.includes('Existing credentials preserved'));
  assert.ok(!retried.stdout.includes(original.CONNECT_CODE));
  assert.deepEqual(remote.unexpected, []);
});
