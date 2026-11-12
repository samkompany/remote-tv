import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { createWriteStream } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.join(__dirname, 'bin');
const LOCAL_CF = path.join(BIN_DIR, 'cloudflared');

function cloudflaredBin() {
  if (fs.existsSync(LOCAL_CF)) return LOCAL_CF;
  return null;
}

async function ensureCloudflared() {
  if (cloudflaredBin()) return cloudflaredBin();
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`;
  const tgz = path.join(BIN_DIR, 'cloudflared.tgz');
  console.log('Téléchargement de cloudflared…');
  await download(url, tgz);
  await execFileAsync('tar', ['-xzf', tgz, '-C', BIN_DIR]);
  try { fs.unlinkSync(tgz); } catch {}
  try { fs.chmodSync(LOCAL_CF, 0o755); } catch {}
  if (!fs.existsSync(LOCAL_CF)) throw new Error('cloudflared introuvable après download');
  return LOCAL_CF;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const get = (u, redirects = 0) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume();
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for cloudflared`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      }).on('error', reject);
    };
    get(url);
  });
}

/**
 * Ouvre un tunnel HTTPS public vers le port local.
 * Préfère Cloudflare (pas de page interstitial) puis localtunnel.
 */
export async function openPublicTunnel(port) {
  try {
    const bin = await ensureCloudflared();
    return await openCloudflared(bin, port);
  } catch (e) {
    console.warn('Cloudflare tunnel indispo:', e?.message || e);
  }
  return openLocaltunnel(port);
}

function openCloudflared(bin, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill(); } catch {}
        reject(new Error('Timeout cloudflared'));
      }
    }, 30000);

    const onData = (buf) => {
      const text = buf.toString();
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          url: m[0],
          provider: 'cloudflare',
          stop: () => { try { child.kill(); } catch {} },
        });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`cloudflared exit ${code}`));
      }
    });
  });
}

async function openLocaltunnel(port) {
  const localtunnel = (await import('localtunnel')).default;
  const tunnel = await localtunnel({ port });
  return {
    url: tunnel.url,
    provider: 'localtunnel',
    stop: () => { try { tunnel.close(); } catch {} },
  };
}
