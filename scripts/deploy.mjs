import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSecrets } from './setup.mjs';
import { runWrangler } from './wrangler.mjs';

class DeployError extends Error {}

async function secretNames(runner, targetArgs) {
  try {
    const result = await runner(['secret', 'list', '--format', 'json', ...targetArgs], undefined, { capture: true, quiet: true });
    if (result.code !== 0) throw new Error();
    const entries = JSON.parse(result.stdout);
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.name !== 'string' || entry.type !== 'secret_text')) throw new Error();
    return new Set(entries.map(entry => entry.name));
  } catch {
    throw new DeployError('Could not read remote secret names. Keep any printed Key and inspect Cloudflare before retrying. / 读取远程密钥名称失败，请保留已显示的 Key，检查 Cloudflare 后再重试。');
  }
}

export async function deploy({ runner = runWrangler, output = console.log, environment = process.env } = {}) {
  // Secret commands do not apply the CI name override that wrangler deploy uses.
  const targetArgs = environment.WRANGLER_CI_OVERRIDE_NAME ? ['--name', environment.WRANGLER_CI_OVERRIDE_NAME] : [];
  // Create the Worker first so secret list also works for a fresh browser deployment.
  if (await runner(['deploy', ...targetArgs]) !== 0) throw new DeployError('Deployment failed; secret initialization was not started. / 部署失败，尚未初始化密钥。');
  const names = await secretNames(runner, targetArgs);
  const hasCode = names.has('CONNECT_CODE');
  const hasSigning = names.has('SIGNING_KEY');
  if (hasCode && hasSigning) {
    output('Existing credentials preserved. Use your saved License Key. / 已保留现有密钥，请继续使用已保存的激活 Key。');
    return;
  }
  if (hasCode || hasSigning) {
    throw new DeployError('Remote credentials are incomplete. Restore the missing secret in Cloudflare; existing secrets were preserved. / 远程凭据不完整，请在 Cloudflare 中恢复缺少的密钥；现有密钥已保留。');
  }
  const secrets = createSecrets();
  // Show the user's key before upload: a lost response must not make a successfully
  // stored key unrecoverable. Never print SIGNING_KEY or put either value in argv.
  output('Save this generated License Key from the deployment log. It becomes usable after initialization succeeds. / 请保存部署日志中的激活 Key，初始化成功后即可使用。');
  output(`License Key (CONNECT_CODE): ${secrets.CONNECT_CODE}`);
  try {
    const result = await runner(['secret', 'bulk', ...targetArgs], JSON.stringify(secrets), { quiet: true });
    if (result !== 0) throw new Error();
  } catch {
    throw new DeployError('Secret upload did not complete. Keep the printed Key and inspect the remote secret names before retrying. / 密钥上传未完成，请保留上方 Key，检查远程密钥名称后再重试。');
  }
  const confirmed = await secretNames(runner, targetArgs);
  if (!confirmed.has('CONNECT_CODE') || !confirmed.has('SIGNING_KEY')) {
    throw new DeployError('Could not confirm both uploaded secrets. Keep the printed Key and inspect Cloudflare. / 尚未确认两项密钥均已上传，请保留上方 Key 并检查 Cloudflare。');
  }
  output('Credentials ready. Enter the Worker URL and the License Key above in Bruno. / 密钥初始化完成，在 Bruno 中填写 Worker 地址和上方激活 Key。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new DeployError('Usage: npm run deploy. For a build check, use npm run dry-run. / 部署请运行 npm run deploy；打包检查请运行 npm run dry-run。');
    await deploy();
  } catch (error) {
    console.error(error instanceof DeployError ? error.message : 'Deployment did not complete. Check Cloudflare authentication and try again. / 部署未完成，请检查 Cloudflare 登录状态后重试。');
    process.exitCode = 1;
  }
}
