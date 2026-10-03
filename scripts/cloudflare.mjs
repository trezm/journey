import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseConfigFileTextToJson, flattenDiagnosticMessageText } from 'typescript';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const configPath = new URL('../wrangler.jsonc', import.meta.url);
const placeholder = '00000000-0000-4000-8000-000000000000';
const [command, ...args] = process.argv.slice(2);
const toolEnv = {
  ...process.env,
  CLOUDFLARE_CF_FETCH_ENABLED: process.env.CLOUDFLARE_CF_FETCH_ENABLED ?? 'false',
  WRANGLER_SEND_METRICS: process.env.WRANGLER_SEND_METRICS ?? 'false',
  WRANGLER_WRITE_LOGS: process.env.WRANGLER_WRITE_LOGS ?? 'false',
  WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? '.wrangler/logs',
  WRANGLER_REGISTRY_PATH: process.env.WRANGLER_REGISTRY_PATH ?? '.wrangler/dev-registry',
  MINIFLARE_REGISTRY_PATH: process.env.MINIFLARE_REGISTRY_PATH ?? '.wrangler/registry',
};
function run(relative, parameters) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(relative, import.meta.url)), ...parameters], {
    cwd: projectRoot, env: toolEnv, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function readConfig() {
  const parsed = parseConfigFileTextToJson(fileURLToPath(configPath), readFileSync(configPath, 'utf8'));
  if (parsed.error) throw new Error(flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  return parsed.config;
}
function checkConfig() {
  const config = readConfig();
  const database = config.d1_databases?.find(binding => binding.binding === 'DB');
  const bucket = config.r2_buckets?.find(binding => binding.binding === 'BUCKET');
  if (!database || !bucket) throw new Error('wrangler.jsonc must bind D1 as DB and R2 as BUCKET.');
  if (!database.database_id || database.database_id === placeholder) {
    throw new Error('Configure an existing or newly created D1 database before deploying: pnpm cf:configure --database-id YOUR_D1_ID. See docs/cloudflare.md.');
  }
  if (!bucket.bucket_name) throw new Error('Configure the R2 bucket_name in wrangler.jsonc.');
  return config;
}
try {
  if (command === 'configure') {
    const config = readConfig();
    const options = new Map();
    for (let i = 0; i < args.length; i += 2) {
      if (!['--database-id', '--database-name', '--bucket', '--name'].includes(args[i]) || !args[i + 1]) {
        throw new Error('Usage: pnpm cf:configure --database-id ID [--database-name NAME] [--bucket NAME] [--name WORKER_NAME]');
      }
      options.set(args[i], args[i + 1]);
    }
    const id = options.get('--database-id');
    if (!id || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) || id === placeholder) {
      throw new Error('Supply the real database UUID returned by Wrangler or the Cloudflare dashboard.');
    }
    config.d1_databases[0].database_id = id;
    if (options.has('--database-name')) config.d1_databases[0].database_name = options.get('--database-name');
    if (options.has('--bucket')) config.r2_buckets[0].bucket_name = options.get('--bucket');
    if (options.has('--name')) config.name = options.get('--name');
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    console.log('Updated wrangler.jsonc. Rebuild after configuration changes.');
  } else if (command === 'check') {
    checkConfig();
    console.log('Deployment binding configuration is ready. Resource existence and access are checked by Wrangler.');
  } else if (command === 'build' || command === 'dev') {
    run('../node_modules/vite/bin/vite.js', [command, ...(command === 'dev' ? ['--port', '5173'] : []), ...args]);
  } else if (command === 'start') {
    run('../node_modules/wrangler/bin/wrangler.js', ['dev', '--config', 'dist/server/wrangler.json', '--local', '--persist-to', '.wrangler/state', '--ip', '127.0.0.1', '--inspector-port', '0', ...args]);
  } else if (command === 'deploy') {
    if (!args.includes('--dry-run')) checkConfig();
    run('../node_modules/vite/bin/vite.js', ['build']);
    run('../node_modules/wrangler/bin/wrangler.js', ['deploy', '--config', 'dist/server/wrangler.json', ...args]);
  } else if (command === 'migrate-remote') {
    checkConfig();
    run('../node_modules/wrangler/bin/wrangler.js', ['d1', 'migrations', 'apply', 'DB', '--config', 'wrangler.jsonc', '--remote', ...args]);
  } else if (command === 'wrangler') {
    run('../node_modules/wrangler/bin/wrangler.js', [...args, '--config', 'wrangler.jsonc']);
  } else {
    throw new Error('Expected dev, build, start, deploy, check, configure, migrate-remote or wrangler.');
  }
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
