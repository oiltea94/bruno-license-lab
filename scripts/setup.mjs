import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

class SetupError extends Error {}

const USAGE = `npm run setup                       Initialize/reuse and start locally / 本地初始化或复用并启动
npm run setup -- --port 8788         Choose a local port / 指定本地端口
npm run setup -- --lang zh           中文提示 (en = English)`;

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
async function instructions(endpoint, codePath, output, zh) {
  const key = (await readFile(codePath, 'utf8')).trim();
  const mode = zh ? '本地运行' : 'Local';
  const steps = zh
    ? ['    1. 打开 Bruno → License → License Server',
       '    2. 填写上方服务地址、你的邮箱和 License Key',
       '    3. 等待下方显示 Ready 后，点击 Activate']
    : ['    1. Open Bruno → License → License Server',
       '    2. Enter the server URL, your email and License Key',
       '    3. Wait for Ready below, then click Activate'];
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
    zh ? '  正在启动本地服务，请保持当前终端打开。' : '  Starting the local service. Keep this terminal open.',
    zh ? '  停止服务：Ctrl+C' : '  Stop the service: Ctrl+C',
    '',
  ].join('\n'));
}

export async function runSetup(args, {
  root = ROOT, output = console.log,
  runner = (values, input, options = {}) => runWrangler(values, input, { ...options, root }),
} = {}) {
  let port = '8787', portSet = false, localSet = false;
  let lang = Intl.DateTimeFormat().resolvedOptions().locale.startsWith('zh') ? 'zh' : 'en';
  if (args.length === 1 && args[0] === '--help') { output(USAGE); return 0; }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--local' && !localSet) localSet = true;
    else if (arg === '--port' && !portSet && /^[1-9][0-9]{0,4}$/.test(args[index + 1] ?? '') && Number(args[index + 1]) <= 65535) {
      port = args[++index]; portSet = true;
    } else if (arg === '--lang' && ['en', 'zh'].includes(args[index + 1])) lang = args[++index];
    else { output(USAGE); return 2; }
  }
  const zh = lang === 'zh';
  const codePath = await ensureLocal(root);
  await instructions(`http://127.0.0.1:${port}`, codePath, output, zh);
  return runner(['dev', '--local', '--ip', '127.0.0.1', '--port', port]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runSetup(process.argv.slice(2)); }
  catch (error) {
    if (error instanceof SetupError) console.error(error.message);
    else if (error?.code === 'EEXIST') console.error('Setup already exists. Existing credentials were preserved.');
    else console.error('Setup did not complete. Check dependencies and local configuration, then retry. Existing credentials were preserved.');
    process.exitCode = 1;
  }
}
