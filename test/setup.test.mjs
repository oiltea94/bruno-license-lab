import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSecrets, setupLocal, setupRemote } from '../scripts/setup.mjs';

async function sandbox(t) {
  await mkdir(resolve('.tmp'), { recursive: true });
  const dir = await mkdtemp(resolve('.tmp', 'setup-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('setup generates independent strong secrets without printing them', () => {
  const a = createSecrets();
  const b = createSecrets();
  for (const value of Object.values(a)) assert.match(value, /^[A-Za-z0-9_-]{64}$/);
  assert.notEqual(a.CONNECT_CODE, a.SIGNING_KEY);
  assert.notEqual(a.CONNECT_CODE, b.CONNECT_CODE);
});

test('local setup writes exclusive local files and never overwrites existing credentials', async (t) => {
  const root = await sandbox(t);
  await setupLocal(root);
  const vars = await readFile(join(root, '.dev.vars'), 'utf8');
  const code = (await readFile(join(root, '.secrets', 'local-connection-code.txt'), 'utf8')).trim();
  assert.ok(vars.includes(`CONNECT_CODE=${code}\n`));
  assert.match(vars, /SIGNING_KEY=[A-Za-z0-9_-]{64}/);
  await assert.rejects(() => setupLocal(root));
  assert.equal(await readFile(join(root, '.dev.vars'), 'utf8'), vars);
});

test('remote setup passes secrets only over stdin and persists only the connection code', async (t) => {
  const root = await sandbox(t);
  const calls = [];
  await setupRemote(root, async (args, input) => { calls.push({ args, input }); return 0; });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['secret', 'bulk']);
  const sent = JSON.parse(calls[0].input);
  const stored = (await readFile(join(root, '.secrets', 'remote-connection-code.txt'), 'utf8')).trim();
  assert.equal(stored, sent.CONNECT_CODE);
  assert.match(sent.SIGNING_KEY, /^[A-Za-z0-9_-]{64}$/);
  assert.ok(!calls[0].args.join(' ').includes(sent.SIGNING_KEY));
  await assert.rejects(readFile(join(root, '.dev.vars')));
  await assert.rejects(() => setupRemote(root, async () => { assert.fail('existing code must block remote changes'); }));
});

test('remote setup failure is generic and preserves the code for a possibly partial upload', async (t) => {
  const root = await sandbox(t);
  await assert.rejects(() => setupRemote(root, async () => 1), /Secret upload did not complete/);
  assert.match((await readFile(join(root, '.secrets', 'remote-connection-code.txt'), 'utf8')).trim(), /^[A-Za-z0-9_-]{64}$/);
});

test('local setup refuses an existing vars file before creating a connection code', async (t) => {
  const root = await sandbox(t);
  await writeFile(join(root, '.dev.vars'), 'existing-config\n');
  await assert.rejects(() => setupLocal(root));
  assert.equal(await readFile(join(root, '.dev.vars'), 'utf8'), 'existing-config\n');
  await assert.rejects(readFile(join(root, '.secrets', 'local-connection-code.txt')));
});

test('Wrangler environment keeps configuration, cache and temp paths inside the service', async (t) => {
  const { wranglerEnvironment } = await import('../scripts/wrangler.mjs');
  const root = await sandbox(t);
  const environment = await wranglerEnvironment(root);
  for (const field of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'TMPDIR', 'WRANGLER_LOG_PATH', 'npm_config_cache']) {
    assert.ok(environment[field].startsWith(root), `${field} must stay within the service directory`);
  }
  assert.equal(environment.WRANGLER_SEND_METRICS, 'false');
  assert.equal(environment.WRANGLER_WRITE_LOGS, 'false');
});

test('hosted setup orchestrates login, deploy, stdin secrets and endpoint readiness without an account', async (t) => {
  const { setupHosted } = await import('../scripts/setup.mjs');
  const root = await sandbox(t);
  const events = [];
  const result = await setupHosted(root, {
    runner: async (args, input, options) => {
      events.push(args.join(' '));
      if (args[0] === 'deploy') {
        assert.equal(options.capture, true);
        return { code: 0, stdout: 'Uploaded bruno-license-lab\n  https://bruno-license-lab.test-account.workers.dev\nCurrent Version ID: test\n' };
      }
      if (args[0] === 'secret') assert.match(JSON.parse(input).SIGNING_KEY, /^[A-Za-z0-9_-]{64}$/);
      return 0;
    },
    checkHealth: async (endpoint) => { events.push(`health ${endpoint}`); },
  });
  assert.deepEqual(events, ['login', 'deploy', 'secret bulk', 'health https://bruno-license-lab.test-account.workers.dev']);
  assert.equal(result.endpoint, 'https://bruno-license-lab.test-account.workers.dev');
  assert.equal(result.codePath, join(root, '.secrets', 'remote-connection-code.txt'));
});

test('hosted setup reuses existing credentials and stops after failed login/deploy', async (t) => {
  const { setupHosted } = await import('../scripts/setup.mjs');
  const root = await sandbox(t);
  await mkdir(join(root, '.secrets'), { recursive: true });
  const codePath = join(root, '.secrets', 'remote-connection-code.txt');
  await writeFile(codePath, 'existing-code');
  const events = [];
  const runner = async (args) => {
    events.push(args.join(' '));
    return args[0] === 'deploy' ? { code: 0, stdout: 'https://bruno-license-lab.example.workers.dev' } : 0;
  };
  await setupHosted(root, { runner, checkHealth: async () => {} });
  assert.deepEqual(events, ['login', 'deploy']);
  assert.equal(await readFile(codePath, 'utf8'), 'existing-code');
  await assert.rejects(() => setupHosted(root, { runner: async () => 1 }), /Login did not complete/);
  await assert.rejects(() => setupHosted(root, { runner: async (args) => args[0] === 'deploy' ? { code: 1, stdout: '' } : 0 }), /Deployment did not complete/);
});

test('hosted setup never invents an endpoint when deployment output lacks a workers.dev address', async (t) => {
  const { setupHosted } = await import('../scripts/setup.mjs');
  const root = await sandbox(t);
  await assert.rejects(() => setupHosted(root, {
    runner: async (args) => args[0] === 'deploy' ? { code: 0, stdout: 'no endpoint printed' } : 0,
    checkHealth: async () => assert.fail('must not check a made-up endpoint'),
  }), /No workers.dev endpoint/);
  await assert.rejects(readFile(join(root, '.secrets', 'remote-connection-code.txt')));
});


test('unified setup selects local mode, starts runtime and reuses existing credentials', async (t) => {
  const { runSetup } = await import('../scripts/setup.mjs');
  assert.equal(typeof runSetup, 'function');
  const root = await sandbox(t);
  const calls = [], output = [];
  const options = { root, interactive: true, choose: async () => '1', output: s => output.push(s),
    runner: async args => { calls.push(args); return 0; } };
  assert.equal(await runSetup([], options), 0);
  const original = await readFile(join(root, '.dev.vars'), 'utf8');
  assert.deepEqual(calls, [['dev', '--local', '--ip', '127.0.0.1', '--port', '8787']]);
  assert.ok(output.join(' ').includes('http://127.0.0.1:8787'));
  assert.ok(output.join(' ').includes('License Key'));
  assert.equal(await runSetup(['--local', '--port', '8788'], options), 0);
  assert.equal(await readFile(join(root, '.dev.vars'), 'utf8'), original);
  assert.deepEqual(calls[1], ['dev', '--local', '--ip', '127.0.0.1', '--port', '8788']);
});

test('unified setup uses hosted deployment for cloudflare and never guesses noninteractive mode', async (t) => {
  const { runSetup } = await import('../scripts/setup.mjs');
  assert.equal(typeof runSetup, 'function');
  const root = await sandbox(t), calls = [], output = [];
  const options = { root, interactive: false, output: s => output.push(s),
    runner: async args => { calls.push(args[0]); return args[0] === 'deploy'
      ? {code:0, stdout:'https://bruno-license-lab.account.workers.dev'} : 0; }, checkHealth: async () => {} };
  assert.equal(await runSetup([], options), 2);
  assert.deepEqual(calls, []);
  assert.equal(await runSetup(['--cloudflare'], options), 0);
  assert.deepEqual(calls, ['login','deploy','secret']);
  assert.ok(output.join(' ').includes('https://bruno-license-lab.account.workers.dev'));
});

test('unified local setup refuses partial credentials and invalid arguments before starting a process', async (t) => {
  const { runSetup } = await import('../scripts/setup.mjs');
  assert.equal(typeof runSetup, 'function');
  const root = await sandbox(t);
  const options = {root, interactive:false, output:()=>{}, runner: async () => assert.fail('must not start')};
  assert.equal(await runSetup(['--unknown'], options), 2);
  assert.equal(await runSetup(['--local','--cloudflare'], options), 2);
  assert.equal(await runSetup(['--local','--port','0'], options), 2);
  assert.equal(await runSetup(['--cloudflare','--port','8788'], options), 2);
  await writeFile(join(root, '.dev.vars'), 'CONNECT_CODE=existing\n');
  await assert.rejects(() => runSetup(['--local'], options), /incomplete|match|invalid/i);
  assert.equal(await readFile(join(root, '.dev.vars'), 'utf8'), 'CONNECT_CODE=existing\n');
});


test('Workers Builds retains deployment output paths while local execution strips them', async (t) => {
  const { wranglerEnvironment } = await import('../scripts/wrangler.mjs');
  const root = await sandbox(t);
  const provided = { WORKERS_CI: '1', WRANGLER_OUTPUT_FILE_DIRECTORY: '/opt/buildhome/wrangler-output',
    WRANGLER_OUTPUT_FILE_PATH: '/opt/buildhome/wrangler-output/result.json',
    WRANGLER_CI_OVERRIDE_NAME: 'deployed-worker', CLOUDFLARE_API_TOKEN: 'test-only-token' };
  const hosted = await wranglerEnvironment(root, provided);
  for (const [name, value] of Object.entries(provided)) assert.equal(hosted[name], value, name);
  const local = await wranglerEnvironment(root, { ...provided, WORKERS_CI: '0' });
  assert.equal(local.WRANGLER_OUTPUT_FILE_DIRECTORY, undefined);
  assert.equal(local.WRANGLER_OUTPUT_FILE_PATH, undefined);
});
