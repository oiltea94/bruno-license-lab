import { randomBytes } from 'node:crypto';
import { access, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { ROOT, runWrangler } from './wrangler.mjs';

export function createSecrets() {
  return { CONNECT_CODE: randomBytes(48).toString('base64url'), SIGNING_KEY: randomBytes(48).toString('base64url') };
}
async function writeExclusive(path, text) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); } finally { await handle.close(); }
}
export async function setupLocal(root = ROOT) {
  const secrets = createSecrets();
  const varsPath = join(root, '.dev.vars');
  const codePath = join(root, '.secrets', 'local-connection-code.txt');
  // Reserve the vars file first; never replace an existing local setup.
  const handle = await open(varsPath, 'wx', 0o600);
  let codeWritten = false;
  try {
    await mkdir(join(root, '.secrets'), { recursive: true, mode: 0o700 });
    await writeExclusive(codePath, `${secrets.CONNECT_CODE}\n`);
    codeWritten = true;
    await handle.writeFile(`CONNECT_CODE=${secrets.CONNECT_CODE}\nSIGNING_KEY=${secrets.SIGNING_KEY}\n`, 'utf8');
  } catch (error) {
    await handle.close();
    await unlink(varsPath).catch(() => {});
    if (codeWritten) await unlink(codePath).catch(() => {});
    throw error;
  }
  await handle.close();
  return codePath;
}
export async function setupRemote(root = ROOT, runner = (args, input) => runWrangler(args, input, { quiet: true, root })) {
  const secrets = createSecrets();
  const codePath = join(root, '.secrets', 'remote-connection-code.txt');
  await mkdir(join(root, '.secrets'), { recursive: true, mode: 0o700 });
  // Persist the human's code before the network request, even if upload partially fails.
  // SIGNING_KEY stays in memory and is stored only by Cloudflare after a successful upload.
  await writeExclusive(codePath, `${secrets.CONNECT_CODE}\n`);
  let code;
  try { code = await runner(['secret', 'bulk'], JSON.stringify(secrets)); }
  catch { throw new Error('Secret upload did not complete. Connection code retained; inspect remote secret names before retrying.'); }
  if (code !== 0) throw new Error('Secret upload did not complete. Connection code retained; inspect remote secret names before retrying.');
  return codePath;
}

class SetupError extends Error {}

async function checkEndpoint(endpoint) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
      const health = await response.json();
      if (response.ok && health.status === 'ok' && health.configured === true
          && health.protocolVersion === 1 && health.service === 'bruno-helper') return;
    } catch { /* Retry briefly while the new deployment propagates; never print remote bodies. */ }
    if (attempt < 3) await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  }
  throw new SetupError('Deployment finished but health is not ready. Check both secret names and PUBLIC_ORIGIN, then revisit the printed Worker URL. Existing credentials were preserved.');
}

export async function setupHosted(root = ROOT, {
  runner = (args, input, options = {}) => runWrangler(args, input, { ...options, root }),
  checkHealth = checkEndpoint,
} = {}) {
  if (await runner(['login']) !== 0) throw new SetupError('Login did not complete. Run setup again after completing browser authorization.');
  const deployment = await runner(['deploy'], undefined, { capture: true });
  if (deployment.code !== 0) throw new SetupError('Deployment did not complete. Check Wrangler output above.');
  const matches = deployment.stdout.match(/https:\/\/[a-zA-Z0-9-]+\.[a-zA-Z0-9-]+\.workers\.dev\b/g);
  if (!matches?.length) throw new SetupError('No workers.dev endpoint was printed by Wrangler. Enable workers_dev in the config or use the manual custom-domain flow in README.md.');
  const endpoint = matches.at(-1);
  const codePath = join(root, '.secrets', 'remote-connection-code.txt');
  let hasCode = false;
  try { await access(codePath); hasCode = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!hasCode) await setupRemote(root, (args, input) => runner(args, input, { quiet: true }));
  await checkHealth(endpoint);
  return { endpoint, codePath };
}


const USAGE = `npm run setup                        Choose local or Cloudflare / 选择本地或 Cloudflare
npm run setup -- --local              Initialize/reuse and start locally / 本地初始化或复用并启动
npm run setup -- --cloudflare         Login and deploy / 登录并部署
npm run setup -- --local --port 8788  Choose a local port / 指定本地端口
npm run setup -- --lang zh            中文提示 (en = English)
The old --remote flag is an alias for --cloudflare / 旧 --remote 参数等同 --cloudflare`;

async function optionalRead(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function ensureLocal(root) {
  const codePath = join(root, '.secrets', 'local-connection-code.txt');
  const vars = await optionalRead(join(root, '.dev.vars'));
  const code = await optionalRead(codePath);
  if (vars === null && code === null) return setupLocal(root);
  const valid = value => typeof value === 'string' && /^[\x21-\x7e]{32,512}$/.test(value);
  // Credentials created by setup are unquoted single-line values. Preserve them exactly.
  const codeMatch = vars?.match(/^CONNECT_CODE=([^\r\n]+)$/m)?.[1];
  const signingMatch = vars?.match(/^SIGNING_KEY=([^\r\n]+)$/m)?.[1];
  if (!valid(codeMatch) || !valid(signingMatch) || code?.trim() !== codeMatch) {
    throw new SetupError('Local credentials are incomplete, invalid or do not match. Restore .dev.vars and .secrets/local-connection-code.txt from the same backup; existing files were preserved.');
  }
  return codePath;
}
async function chooseMode(prompt) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return await terminal.question(prompt); } finally { terminal.close(); }
}
async function instructions(endpoint, codePath, output, zh, local = false) {
  const key = (await readFile(codePath, 'utf8')).trim();
  const mode = local ? (zh ? '本地运行' : 'Local') : 'Cloudflare';
  const steps = zh
    ? ['    1. 打开 Bruno → License → License Server',
       '    2. 填写上方服务地址、你的邮箱和 License Key',
       local ? '    3. 等待下方显示 Ready 后，点击 Activate' : '    3. 点击 Activate 完成接入']
    : ['    1. Open Bruno → License → License Server',
       '    2. Enter the server URL, your email and License Key',
       local ? '    3. Wait for Ready below, then click Activate' : '    3. Click Activate to connect'];
  output([
    '',
    `  Bruno License Lab · ${mode}`,
    '  ────────────────────────────────────────',
    '',
    zh ? '  连接信息' : '  Connection',
    `    Server URL   ${endpoint}`,
    zh ? '    Email        你的邮箱（仅检查格式，无需邮件验证）' : '    Email        Your email (format checked; no verification email)',
    '',
    '  License Key',
    `    ${key}`,
    '',
    zh ? '  Key 已保存至' : '  Key saved to',
    `    ${codePath}`,
    '',
    zh ? '  在 Bruno 中接入' : '  Connect in Bruno',
    ...steps,
    '',
    local
      ? (zh ? '  正在启动本地服务，请保持当前终端打开。' : '  Starting the local service. Keep this terminal open.')
      : (zh ? '  Cloudflare 服务已就绪，健康检查通过。' : '  Cloudflare service ready. Health check passed.'),
    local
      ? (zh ? '  停止服务：Ctrl+C' : '  Stop the service: Ctrl+C')
      : (zh ? '  可以关闭终端，服务会继续运行。' : '  You can close this terminal; the service stays online.'),
    '',
  ].join('\n'));
}

export async function runSetup(args, {
  root = ROOT, interactive = Boolean(process.stdin.isTTY), choose = chooseMode, output = console.log,
  runner = (values, input, options = {}) => runWrangler(values, input, { ...options, root }),
  checkHealth = checkEndpoint,
} = {}) {
  let mode, port = '8787', portSet = false;
  let lang = Intl.DateTimeFormat().resolvedOptions().locale.startsWith('zh') ? 'zh' : 'en';
  if (args.length === 1 && args[0] === '--help') { output(USAGE); return 0; }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (['--local', '--cloudflare', '--remote'].includes(arg) && !mode) mode = arg === '--local' ? 'local' : 'cloudflare';
    else if (arg === '--port' && !portSet && /^[1-9][0-9]{0,4}$/.test(args[index + 1] ?? '') && Number(args[index + 1]) <= 65535) {
      port = args[++index]; portSet = true;
    } else if (arg === '--lang' && ['en', 'zh'].includes(args[index + 1])) lang = args[++index];
    else { output(USAGE); return 2; }
  }
  const zh = lang === 'zh';
  if (!mode) {
    if (!interactive) { output(USAGE); return 2; }
    const answer = (await choose(zh ? '部署方式：\n  1) 本地运行\n  2) Cloudflare\n选择 [1/2]: ' : 'Deployment:\n  1) Local\n  2) Cloudflare\nChoose [1/2]: ')).trim().toLowerCase();
    if (['1', 'local'].includes(answer)) mode = 'local';
    else if (['2', 'cloudflare'].includes(answer)) mode = 'cloudflare';
    else { output(zh ? '请选择 1 或 2。未执行部署。' : 'Choose 1 or 2. No deployment was performed.'); return 2; }
  }
  if (mode === 'cloudflare' && portSet) { output(USAGE); return 2; }
  if (mode === 'local') {
    const codePath = await ensureLocal(root);
    await instructions(`http://127.0.0.1:${port}`, codePath, output, zh, true);
    return runner(['dev', '--local', '--ip', '127.0.0.1', '--port', port]);
  }
  const result = await setupHosted(root, { runner, checkHealth });
  await instructions(result.endpoint, result.codePath, output, zh);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runSetup(process.argv.slice(2)); }
  catch (error) {
    if (error instanceof SetupError) console.error(error.message);
    else if (error?.code === 'EEXIST') console.error('Setup already exists. Existing credentials were preserved.');
    else console.error('Setup did not complete. Check dependencies, configuration and network, then retry. Existing credentials were preserved.');
    process.exitCode = 1;
  }
}
