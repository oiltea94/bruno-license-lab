import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function wranglerEnvironment(root = ROOT, inherited = process.env) {
  const tooling = join(root, '.tooling');
  const temp = join(root, '.tmp');
  const dirs = { XDG_CONFIG_HOME: join(tooling, 'config'), XDG_CACHE_HOME: join(tooling, 'cache'),
    XDG_DATA_HOME: join(tooling, 'data'), APPDATA: join(tooling, 'appdata'),
    LOCALAPPDATA: join(tooling, 'localappdata'), USERPROFILE: join(tooling, 'home'),
    HOME: join(tooling, 'home'), TEMP: temp, TMP: temp, TMPDIR: temp };
  await Promise.all([...new Set(Object.values(dirs))].map(path => mkdir(path, { recursive: true })));
  const environment = { ...inherited, ...dirs, WRANGLER_SEND_METRICS: 'false',
    WRANGLER_NO_SKILLS_UPDATE_PROMPTS: 'true', WRANGLER_WRITE_LOGS: 'false',
    WRANGLER_LOG_SANITIZE: 'true', WRANGLER_LOG_PATH: join(root, '.wrangler', 'logs'),
    npm_config_cache: join(root, '.npm-cache'), npm_config_update_notifier: 'false' };
  // Workers Builds uses these files to track the deployed Worker in its dashboard.
  // Local runs keep tool artifacts inside this service instead.
  if (inherited.WORKERS_CI !== '1') {
    delete environment.WRANGLER_OUTPUT_FILE_PATH;
    delete environment.WRANGLER_OUTPUT_FILE_DIRECTORY;
  }
  return environment;
}

export async function runWrangler(args, input, { quiet = false, root = ROOT, capture = false, environment: inherited = process.env } = {}) {
  const environment = await wranglerEnvironment(root, inherited);
  if (args[0] === 'deploy' && args.some(arg => arg === '--dry-run' || arg === '--dry-run=true')) {
    environment.BRUNO_SKIP_SECRET_INIT = '1';
  }
  const cli = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root, env: environment, shell: false, windowsHide: true,
      stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : quiet ? 'ignore' : 'inherit', capture ? 'pipe' : quiet ? 'ignore' : 'inherit'],
    });
    child.once('error', () => reject(new Error('Wrangler could not start. Run npm ci first.')));
    let stdout = '', stderr = '';
    if (capture) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk).slice(-65536);
        if (!quiet) process.stderr.write(chunk);
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout = (stdout + chunk).slice(-65536);
        if (!quiet) process.stdout.write(chunk);
      });
    }
    child.once('close', code => resolveExit(capture ? { code: code ?? 1, stdout, stderr } : code ?? 1));
    if (input !== undefined) {
      // Secrets never become shell syntax, command-line arguments or temporary JSON files.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runWrangler(process.argv.slice(2)); }
  catch { console.error('Wrangler could not start. Run npm ci and try again.'); process.exitCode = 1; }
}
