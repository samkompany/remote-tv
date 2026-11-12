import { adbKey, adbLaunch, APPS } from './adb.js';
import { spawn } from 'child_process';
import fs from 'fs';

const ADB = [
  process.env.ADB_PATH,
  '/Users/michel/Library/Android/sdk/platform-tools/adb',
  'adb',
].find((c) => c === 'adb' || (c && fs.existsSync(c))) || 'adb';

function run(args, timeout = 8000) {
  return new Promise((resolve) => {
    const child = spawn(ADB, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, out });
    }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: out.trim() });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, out });
    });
  });
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim();
}

/** Interprète une phrase FR/EN en action télécommande */
export function parseVoiceCommand(text) {
  const t = norm(text);
  if (!t) return { type: 'empty' };

  if (/\b(netflix)\b/.test(t)) return { type: 'app', app: 'netflix' };
  if (/\b(youtube|you tube)\b/.test(t)) return { type: 'app', app: 'youtube' };
  if (/\b(prime|amazon)\b/.test(t)) return { type: 'app', app: 'prime' };
  if (/\b(disney)\b/.test(t)) return { type: 'app', app: 'disney' };
  if (/\b(spotify)\b/.test(t)) return { type: 'app', app: 'spotify' };
  if (/\b(play\s*store|playstore|magasin)\b/.test(t)) return { type: 'app', app: 'playstore' };
  if (/\b(reglages|settings|parametres)\b/.test(t)) return { type: 'app', app: 'settings' };

  if (/\b(home|accueil)\b/.test(t)) return { type: 'key', key: 'KEYCODE_HOME' };
  if (/\b(retour|back)\b/.test(t)) return { type: 'key', key: 'KEYCODE_BACK' };
  if (/\b(mute|silence|couper\s+le\s+son)\b/.test(t)) return { type: 'key', key: 'KEYCODE_VOLUME_MUTE' };
  if (/\b(volume\s+(plus|up)|monte\s+le\s+son|plus\s+fort)\b/.test(t)) return { type: 'key', key: 'KEYCODE_VOLUME_UP' };
  if (/\b(volume\s+(moins|down)|baisse\s+le\s+son|moins\s+fort)\b/.test(t)) return { type: 'key', key: 'KEYCODE_VOLUME_DOWN' };
  if (/\b(pause|play|lecture)\b/.test(t)) return { type: 'key', key: 'KEYCODE_MEDIA_PLAY_PAUSE' };
  if (/\b(eteins?|allume|power)\b/.test(t)) return { type: 'key', key: 'POWER' };

  return { type: 'search', query: text.trim() };
}

export async function adbVoiceSearch(host, port, query) {
  const serial = `${host}:${port}`;
  const q = String(query).slice(0, 120);

  // 1) Recherche Google / Assistant TV
  let r = await run([
    '-s', serial, 'shell', 'am', 'start',
    '-a', 'android.intent.action.WEB_SEARCH',
    '--es', 'query', q,
  ]);
  if (r.ok) return { ok: true, via: 'web_search' };

  // 2) Intent VIEW google search
  r = await run([
    '-s', serial, 'shell', 'am', 'start',
    '-a', 'android.intent.action.VIEW',
    '-d', `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  ]);
  if (r.ok) return { ok: true, via: 'google_view' };

  // 3) Fallback: ouvrir la recherche puis taper
  await run(['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_SEARCH']);
  await new Promise((res) => setTimeout(res, 400));
  const escaped = q.replace(/([\\'"])/g, '\\$1').replace(/ /g, '%s');
  r = await run(['-s', serial, 'shell', 'input', 'text', escaped]);
  return { ok: r.ok, via: 'input_text', detail: r.out };
}

export async function runVoiceOnAdb(host, port, text) {
  const cmd = parseVoiceCommand(text);
  if (cmd.type === 'empty') return { ok: false, error: 'Rien entendu' };
  if (cmd.type === 'app') {
    if (!APPS[cmd.app]) return { ok: false, error: 'App inconnue' };
    const r = await adbLaunch(host, port, cmd.app);
    return { ok: r.ok, action: cmd, detail: r.detail || r.err };
  }
  if (cmd.type === 'key') {
    const r = await adbKey(host, port, cmd.key);
    return { ok: r.ok, action: cmd, detail: r.out || r.err };
  }
  const r = await adbVoiceSearch(host, port, cmd.query);
  return { ok: r.ok, action: cmd, detail: r.via };
}
