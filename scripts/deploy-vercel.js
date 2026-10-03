'use strict';

/**
 * Deploys this project to Vercel through the REST API.
 *
 * `vercel deploy` would normally do this, but the CLI resolves the signed-in
 * *user* before it will do anything, and an access token scoped to a team has no
 * user behind it — the CLI stops with "User not found" while the same token works
 * perfectly against the API. This script does what the CLI would: hash and upload
 * each file, create a deployment that references them, then wait for the build.
 *
 *     VERCEL_TOKEN=… node scripts/deploy-vercel.js [--target preview]
 *
 * Only the files the deployment actually needs are uploaded — an explicit list,
 * not an ignore file, so a stray `data/` directory or a 200 MB `node_modules`
 * can never be swept in by accident.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const API = 'https://api.vercel.com';

const TOKEN = process.env.VERCEL_TOKEN;
const TEAM_ID = process.env.VERCEL_TEAM_ID || 'team_FDHCZ2TwVpxnwIleCDnByPER';
const PROJECT = process.env.VERCEL_PROJECT || 'kinera-registration-demo';
const TARGET = process.argv.includes('--target')
  ? process.argv[process.argv.indexOf('--target') + 1]
  : 'production';

/** Directories whose whole contents ship, plus individual files. */
const INCLUDE_DIRS = ['api', 'src', 'public'];
const INCLUDE_FILES = ['package.json', 'package-lock.json', 'vercel.json'];

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile()) acc.push(full);
  }
  return acc;
}

function collect() {
  const files = [];
  for (const dir of INCLUDE_DIRS) {
    const full = path.join(ROOT, dir);
    if (fs.existsSync(full)) files.push(...walk(full));
  }
  for (const file of INCLUDE_FILES) {
    const full = path.join(ROOT, file);
    if (fs.existsSync(full)) files.push(full);
  }
  return files.map((full) => {
    const data = fs.readFileSync(full);
    return {
      // Vercel wants a POSIX path relative to the project root.
      file: path.relative(ROOT, full).split(path.sep).join('/'),
      data,
      size: data.length,
      sha: crypto.createHash('sha1').update(data).digest('hex'),
    };
  });
}

const qs = `teamId=${encodeURIComponent(TEAM_ID)}`;

async function upload(entry) {
  const res = await fetch(`${API}/v2/files?${qs}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Length': String(entry.size),
      'x-vercel-digest': entry.sha,
    },
    body: entry.data,
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`upload ${entry.file} failed (${res.status}): ${await res.text()}`);
  }
}

async function createDeployment(files) {
  const res = await fetch(`${API}/v13/deployments?${qs}&forceNew=1&skipAutoDetectionConfirmation=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: PROJECT,
      project: PROJECT,
      target: TARGET,
      files: files.map(({ file, sha, size }) => ({ file, sha, size })),
      projectSettings: {
        framework: null,
        buildCommand: null,
        installCommand: null,
        outputDirectory: 'public',
        nodeVersion: '22.x',
      },
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`deployment failed (${res.status}): ${JSON.stringify(body)}`);
  return body;
}

async function waitFor(id) {
  const started = Date.now();
  let last = null;
  for (;;) {
    const res = await fetch(`${API}/v13/deployments/${id}?${qs}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = await res.json();
    const state = body.readyState || body.status;
    if (state !== last) {
      process.stdout.write(`  ${state} (${Math.round((Date.now() - started) / 1000)}s)\n`);
      last = state;
    }
    if (['READY', 'ERROR', 'CANCELED'].includes(state)) return body;
    if (Date.now() - started > 10 * 60 * 1000) throw new Error('timed out waiting for the build');
    await new Promise((r) => { setTimeout(r, 4000); });
  }
}

async function buildLog(id) {
  const res = await fetch(`${API}/v3/deployments/${id}/events?limit=200&builds=1&${qs}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) return `could not read the build log (${res.status})`;
  const text = await res.text();
  return text.split('\n').filter(Boolean).map((line) => {
    try {
      const e = JSON.parse(line);
      return (e.payload && (e.payload.text || e.text)) || '';
    } catch { return line; }
  }).filter(Boolean).join('\n');
}

async function main() {
  if (!TOKEN) {
    process.stderr.write('Set VERCEL_TOKEN.\n');
    process.exit(1);
  }

  const files = collect();
  const bytes = files.reduce((a, f) => a + f.size, 0);
  process.stdout.write(`Uploading ${files.length} files (${(bytes / 1024).toFixed(0)} KB)…\n`);

  // A handful at a time: enough to be quick, few enough to be kind to the API.
  for (let i = 0; i < files.length; i += 6) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(files.slice(i, i + 6).map(upload));
  }

  process.stdout.write(`Creating a ${TARGET} deployment of ${PROJECT}…\n`);
  const deployment = await createDeployment(files);
  process.stdout.write(`  id  ${deployment.id}\n  url https://${deployment.url}\n`);

  const final = await waitFor(deployment.id);
  if (final.readyState !== 'READY') {
    process.stdout.write(`\n--- build log ---\n${await buildLog(deployment.id)}\n`);
    throw new Error(`deployment ended as ${final.readyState}`);
  }

  const aliases = (final.alias || []).map((a) => `https://${a}`);
  process.stdout.write('\nREADY\n');
  process.stdout.write(`  deployment : https://${final.url}\n`);
  for (const a of aliases) process.stdout.write(`  alias      : ${a}\n`);
  process.stdout.write(`  region     : ${(final.regions || []).join(', ') || 'default'}\n`);
}

main().catch((err) => {
  process.stderr.write(`\n${err.message}\n`);
  process.exit(1);
});
