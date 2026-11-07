import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSecrets, setupLocal } from '../scripts/setup.mjs';

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

test('setup starts locally without a menu and reuses existing credentials', async (t) => {
  const { runSetup } = await import('../scripts/setup.mjs');
  assert.equal(typeof runSetup, 'function');
  const root = await sandbox(t);
  const calls = [], output = [];
  const options = { root, interactive: false, choose: async () => assert.fail('setup must not prompt for a deployment mode'), output: s => output.push(s),
    runner: async args => { calls.push(args); return 0; } };
  assert.equal(await runSetup([], options), 0);
  const original = await readFile(join(root, '.dev.vars'), 'utf8');
  assert.deepEqual(calls, [['dev', '--local', '--ip', '127.0.0.1', '--port', '8787']]);
  assert.ok(output.join(' ').includes('http://127.0.0.1:8787'));
  assert.ok(output.join(' ').includes('License Key'));
  assert.equal(await runSetup(['--port', '8788', '--lang', 'zh'], options), 0);
  assert.equal(await readFile(join(root, '.dev.vars'), 'utf8'), original);
  assert.deepEqual(calls[1], ['dev', '--local', '--ip', '127.0.0.1', '--port', '8788']);
  assert.ok(output.at(-1).includes('本地运行'));
  assert.equal(await runSetup(['--local'], options), 0);
  assert.equal(await readFile(join(root, '.dev.vars'), 'utf8'), original);
});

test('setup rejects removed Cloudflare options before making changes', async (t) => {
  const { runSetup } = await import('../scripts/setup.mjs');
  const root = await sandbox(t);
  for (const args of [['--cloudflare'], ['--remote'], ['--cloudflare', '--port', '8788']]) {
    assert.equal(await runSetup(args, {
      root, output() {}, runner: async () => assert.fail('must not start local or remote commands'),
    }), 2);
  }
  await assert.rejects(readFile(join(root, '.dev.vars')), { code: 'ENOENT' });
});

test('setup help describes local startup without running commands', async () => {
  const { runSetup } = await import('../scripts/setup.mjs');
  const output = [];
  assert.equal(await runSetup(['--help'], {
    output: value => output.push(value), runner: async () => assert.fail('help must not start commands'),
  }), 0);
  assert.match(output.join('\n'), /--port/);
  assert.doesNotMatch(output.join('\n'), /Cloudflare|--remote|--cloudflare/i);
});

test('local setup refuses partial credentials and invalid arguments before starting a process', async (t) => {
  const { runSetup } = await import('../scripts/setup.mjs');
  assert.equal(typeof runSetup, 'function');
  const root = await sandbox(t);
  const options = {root, output:()=>{}, runner: async () => assert.fail('must not start')};
  assert.equal(await runSetup(['--unknown'], options), 2);
  assert.equal(await runSetup(['--local','--cloudflare'], options), 2);
  assert.equal(await runSetup(['--local','--port','0'], options), 2);
  assert.equal(await runSetup(['--port','65536'], options), 2);
  assert.equal(await runSetup(['--port'], options), 2);
  assert.equal(await runSetup(['--lang','invalid'], options), 2);
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
