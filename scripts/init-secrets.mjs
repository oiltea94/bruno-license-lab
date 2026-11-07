import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { createSecrets } from './setup.mjs';
import { runWrangler } from './wrangler.mjs';

class SecretInitError extends Error {}

async function secretNames(runner, targetArgs, workerName, allowMissing = false) {
  try {
    const result = await runner(['secret', 'list', '--format', 'json', ...targetArgs], undefined, { capture: true, quiet: true });
    if (result.code !== 0) {
      // Wrangler 4.158 reports a missing Worker as this specific error (without an API code).
      // Only the initial read may treat that response as an empty configuration.
      if (allowMissing && result.code === 1
          && stripVTControlCharacters(result.stderr ?? '').includes(`Worker "${workerName}" not found.`)) return new Set();
      throw new Error();
    }
    const entries = JSON.parse(result.stdout);
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.name !== 'string' || entry.type !== 'secret_text')) throw new Error();
    return new Set(entries.map(entry => entry.name));
  } catch {
    throw new SecretInitError('Could not read remote secret names. Keep any printed Key and inspect Cloudflare before retrying. / 读取远程密钥名称失败，请保留已显示的 Key，检查 Cloudflare 后再重试。');
  }
}

export async function initializeSecrets({ workerName, runner = runWrangler, output = console.log } = {}) {
  if (typeof workerName !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(workerName)) {
    throw new SecretInitError('The deployment Worker name is unavailable or invalid. / 无法确定部署目标的 Worker 名称。');
  }
  // Secret commands do not apply Workers Builds' name override automatically.
  const targetArgs = ['--name', workerName];
  const names = await secretNames(runner, targetArgs, workerName, true);
  const hasCode = names.has('CONNECT_CODE');
  const hasSigning = names.has('SIGNING_KEY');
  if (hasCode && hasSigning) {
    output('Existing credentials preserved. Use your saved License Key. / 已保留现有密钥，请继续使用已保存的激活 Key。');
    return;
  }
  if (hasCode || hasSigning) {
    throw new SecretInitError('Remote credentials are incomplete. Restore the missing secret in Cloudflare; existing secrets were preserved. / 远程凭据不完整，请在 Cloudflare 中恢复缺少的密钥；现有密钥已保留。');
  }
  const secrets = createSecrets();
  // Show the user's key before upload: a lost response must not make a successfully
  // stored key unrecoverable. Never print SIGNING_KEY or put either value in argv.
  output('Save this generated License Key from the deployment log. Use it only after the deployment succeeds. / 请保存部署日志中的激活 Key，等待部署成功后再使用。');
  output(`License Key (CONNECT_CODE): ${secrets.CONNECT_CODE}`);
  try {
    const result = await runner(['secret', 'bulk', ...targetArgs], JSON.stringify(secrets), { quiet: true });
    if (result !== 0) throw new Error();
  } catch {
    throw new SecretInitError('Secret upload did not complete. Keep the printed Key and inspect the remote secret names before retrying. / 密钥上传未完成，请保留上方 Key，检查远程密钥名称后再重试。');
  }
  const confirmed = await secretNames(runner, targetArgs, workerName);
  if (!confirmed.has('CONNECT_CODE') || !confirmed.has('SIGNING_KEY')) {
    throw new SecretInitError('Could not confirm both uploaded secrets. Keep the printed Key and inspect Cloudflare. / 尚未确认两项密钥均已上传，请保留上方 Key 并检查 Cloudflare。');
  }
  output('Credentials stored. Wait for Worker deployment to finish before connecting Bruno. / 密钥已保存，请等待 Worker 部署完成后再接入 Bruno。');
}

export async function runBuild({ environment = process.env, runner = runWrangler, output = console.log } = {}) {
  // Custom builds also run during dev and dry-run. Only initialize in Workers Builds
  // production deploys; the project's dry-run wrapper explicitly disables this hook.
  if (environment.WORKERS_CI !== '1' || environment.WRANGLER_COMMAND !== 'deploy'
      || environment.BRUNO_SKIP_SECRET_INIT === '1') return;
  await initializeSecrets({ workerName: environment.WRANGLER_CI_OVERRIDE_NAME, runner, output });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runBuild(); }
  catch (error) {
    console.error(error instanceof SecretInitError ? error.message
      : 'Secret initialization did not complete. Check Cloudflare authentication and retry. / 密钥初始化未完成，请检查 Cloudflare 授权后重试。');
    process.exitCode = 1;
  }
}
