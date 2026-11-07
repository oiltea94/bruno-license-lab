import test from 'node:test';
import assert from 'node:assert/strict';
import { deploy } from '../scripts/deploy.mjs';
import worker from '../worker.mjs';

// Only the external Wrangler/Cloudflare boundary is simulated.
function cloud(initial = {}) {
  const secrets = { ...initial };
  const calls = [];
  const runner = async (args, input, options = {}) => {
    calls.push({ args, input, options });
    if (args.join(' ') === 'deploy') return 0;
    if (args.join(' ') === 'secret list --format json') {
      return { code: 0, stdout: JSON.stringify(Object.keys(secrets).map(name => ({ name, type: 'secret_text' }))) };
    }
    if (args.join(' ') === 'secret bulk') {
      Object.assign(secrets, JSON.parse(input));
      return 0;
    }
    throw new Error('Unexpected Wrangler operation');
  };
  return { secrets, calls, runner };
}

test('first deployment generates usable credentials and displays only the activation key', async () => {
  const remote = cloud({ OTHER_SECRET: 'preserve-me' });
  const output = [];
  await deploy({ environment: {}, runner: remote.runner, output: value => output.push(value) });
  const { CONNECT_CODE, SIGNING_KEY } = remote.secrets;
  assert.match(CONNECT_CODE, /^[A-Za-z0-9_-]{64}$/);
  assert.match(SIGNING_KEY, /^[A-Za-z0-9_-]{64}$/);
  assert.notEqual(CONNECT_CODE, SIGNING_KEY);
  assert.equal(remote.secrets.OTHER_SECRET, 'preserve-me');
  assert.ok(output.join('\n').includes(CONNECT_CODE));
  assert.ok(!output.join('\n').includes(SIGNING_KEY));
  for (const call of remote.calls) {
    assert.ok(!call.args.join(' ').includes(CONNECT_CODE));
    assert.ok(!call.args.join(' ').includes(SIGNING_KEY));
    if (call.input !== undefined) assert.equal(call.options.quiet, true);
  }
  const activation = await worker.fetch(new Request('https://helper.example/api/v2/license/activate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'auto-deploy-device', email: 'owner@example.com', licenseKey: CONNECT_CODE }),
  }), remote.secrets);
  assert.equal(activation.status, 200);
  const { licenseToken } = await activation.json();
  const verification = await worker.fetch(new Request('https://helper.example/api/v2/license/verify', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'auto-deploy-device', licenseToken }),
  }), remote.secrets);
  assert.equal((await verification.json()).verified, true);
});

test('redeploying preserves both existing secrets and does not upload or print replacements', async () => {
  const original = { CONNECT_CODE: 'a'.repeat(64), SIGNING_KEY: 'b'.repeat(64) };
  const remote = cloud(original);
  const output = [];
  await deploy({ environment: {}, runner: remote.runner, output: value => output.push(value) });
  await deploy({ environment: {}, runner: remote.runner, output: value => output.push(value) });
  assert.deepEqual(remote.secrets, original);
  assert.ok(remote.calls.every(call => call.input === undefined));
  assert.ok(!output.join('\n').includes(original.CONNECT_CODE));
  assert.ok(!output.join('\n').includes(original.SIGNING_KEY));
});

for (const name of ['CONNECT_CODE', 'SIGNING_KEY']) {
  test(`partial configuration (${name} only) stops without overwriting secrets`, async () => {
    const original = { [name]: 'a'.repeat(64) };
    const remote = cloud(original);
    await assert.rejects(deploy({ environment: {}, runner: remote.runner, output() {} }), /incomplete/i);
    assert.deepEqual(remote.secrets, original);
    assert.ok(remote.calls.every(call => call.input === undefined));
  });
}

test('failed deployment stops before reading or writing remote secrets', async () => {
  let count = 0;
  await assert.rejects(deploy({ environment: {}, runner: async () => { count++; return 1; }, output() {} }), /deploy/i);
  assert.equal(count, 1);
});

for (const listing of [
  { code: 1, stdout: 'Access denied' },
  { code: 0, stdout: 'not JSON' },
  { code: 0, stdout: '{}' },
  { code: 0, stdout: '[null]' },
  { code: 0, stdout: '[{"name":"CONNECT_CODE"}]' },
]) {
  test(`unreadable secret listing stops initialization: ${listing.stdout}`, async () => {
    let count = 0;
    const runner = async () => {
      count++;
      if (count === 1) return 0;
      if (count === 2) return listing;
      assert.fail('must not write secrets after an invalid listing');
    };
    await assert.rejects(deploy({ environment: {}, runner, output() {} }), /secret/i);
    assert.equal(count, 2);
  });
}

test('upload failure retains the generated activation key in output without exposing signing material', async () => {
  const remote = cloud();
  const output = [];
  let uploaded;
  const runner = async (args, input, options) => {
    if (args[1] === 'bulk') {
      uploaded = JSON.parse(input);
      throw new Error(input); // even an upstream error echoing the payload must be sanitized
    }
    return remote.runner(args, input, options);
  };
  await assert.rejects(deploy({ environment: {}, runner, output: value => output.push(value) }), error => {
    assert.ok(!error.message.includes(uploaded.SIGNING_KEY));
    assert.match(error.message, /upload/i);
    return true;
  });
  assert.ok(output.join('\n').includes(uploaded.CONNECT_CODE));
  assert.ok(!output.join('\n').includes(uploaded.SIGNING_KEY));
});

test('nonzero upload exit and missing uploaded secret names never report success', async () => {
  for (const uploadExit of [1, 0]) {
    const remote = cloud();
    const output = [];
    const runner = async (args, input, options) => args[1] === 'bulk' ? uploadExit : remote.runner(args, input, options);
    await assert.rejects(deploy({ environment: {}, runner, output: value => output.push(value) }), /upload|confirm/i);
    assert.ok(!output.join('\n').includes('Credentials ready'));
  }
});


test('Cloudflare CI worker rename initializes only the worker selected in the deployment page', async () => {
  const configured = cloud({ CONNECT_CODE: 'a'.repeat(64), SIGNING_KEY: 'b'.repeat(64) });
  const selected = cloud();
  const runner = (args, input, options) => {
    const nameIndex = args.indexOf('--name');
    const name = nameIndex === -1 ? 'bruno-helper' : args[nameIndex + 1];
    const baseArgs = nameIndex === -1 ? args : args.slice(0, nameIndex);
    return (name === 'my-bruno-lab' ? selected : configured).runner(baseArgs, input, options);
  };
  await deploy({ runner, output() {}, environment: { WRANGLER_CI_OVERRIDE_NAME: 'my-bruno-lab' } });
  assert.match(selected.secrets.CONNECT_CODE ?? '', /^[A-Za-z0-9_-]{64}$/);
  assert.match(selected.secrets.SIGNING_KEY ?? '', /^[A-Za-z0-9_-]{64}$/);
  assert.deepEqual(configured.secrets, { CONNECT_CODE: 'a'.repeat(64), SIGNING_KEY: 'b'.repeat(64) });
  assert.equal(configured.calls.length, 0);
});


test('retry after an upload that stored nothing generates and displays a new usable key', async () => {
  const remote = cloud();
  const failedOutput = [];
  const failedRunner = async (args, input, options) => args[1] === 'bulk' ? 1 : remote.runner(args, input, options);
  await assert.rejects(deploy({ environment: {}, runner: failedRunner, output: value => failedOutput.push(value) }));
  const retryOutput = [];
  await deploy({ environment: {}, runner: remote.runner, output: value => retryOutput.push(value) });
  assert.ok(!failedOutput.join('\n').includes(remote.secrets.CONNECT_CODE));
  assert.ok(retryOutput.join('\n').includes(remote.secrets.CONNECT_CODE));
});

test('retry after a lost upload response preserves the pair already stored remotely', async () => {
  const remote = cloud();
  const failedOutput = [];
  const failedRunner = async (args, input, options) => {
    const result = await remote.runner(args, input, options);
    if (args[1] === 'bulk') throw new Error('response lost');
    return result;
  };
  await assert.rejects(deploy({ environment: {}, runner: failedRunner, output: value => failedOutput.push(value) }));
  const original = { ...remote.secrets };
  const retryOutput = [];
  await deploy({ environment: {}, runner: remote.runner, output: value => retryOutput.push(value) });
  assert.deepEqual(remote.secrets, original);
  assert.ok(failedOutput.join('\n').includes(original.CONNECT_CODE));
  assert.ok(!retryOutput.join('\n').includes(original.CONNECT_CODE));
});
