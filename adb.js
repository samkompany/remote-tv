import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADB_CANDIDATES = [
  process.env.ADB_PATH,
  '/Users/michel/Library/Android/sdk/platform-tools/adb',
  'adb',
].filter(Boolean);

function resolveAdb() {
  for (const c of ADB_CANDIDATES) {
    if (c === 'adb') return c;
    if (fs.existsSync(c)) return c;
  }
  return 'adb';
}

const ADB = resolveAdb();

function run(args, { timeout = 15000, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(ADB, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, out, err: err || 'timeout' });
    }, timeout);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    if (input) {
      child.stdin.write(String(input) + '\n');
      child.stdin.end();
    }
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out, err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: (out + err).trim(), err });
    });
  });
}

export const ADB_KEYS = {
  POWER: 'KEYCODE_POWER',
  KEYCODE_POWER: 'KEYCODE_POWER',
  KEYCODE_VOLUME_MUTE: 'KEYCODE_VOLUME_MUTE',
  KEYCODE_HOME: 'KEYCODE_HOME',
  KEYCODE_DPAD_UP: 'KEYCODE_DPAD_UP',
  KEYCODE_DPAD_DOWN: 'KEYCODE_DPAD_DOWN',
  KEYCODE_DPAD_LEFT: 'KEYCODE_DPAD_LEFT',
  KEYCODE_DPAD_RIGHT: 'KEYCODE_DPAD_RIGHT',
  KEYCODE_DPAD_CENTER: 'KEYCODE_DPAD_CENTER',
  KEYCODE_BACK: 'KEYCODE_BACK',
  KEYCODE_MENU: 'KEYCODE_MENU',
  KEYCODE_VOLUME_UP: 'KEYCODE_VOLUME_UP',
  KEYCODE_VOLUME_DOWN: 'KEYCODE_VOLUME_DOWN',
  KEYCODE_CHANNEL_UP: 'KEYCODE_CHANNEL_UP',
  KEYCODE_CHANNEL_DOWN: 'KEYCODE_CHANNEL_DOWN',
  KEYCODE_MEDIA_PLAY_PAUSE: 'KEYCODE_MEDIA_PLAY_PAUSE',
  KEYCODE_MEDIA_PLAY: 'KEYCODE_MEDIA_PLAY',
  KEYCODE_MEDIA_PAUSE: 'KEYCODE_MEDIA_PAUSE',
  KEYCODE_MEDIA_NEXT: 'KEYCODE_MEDIA_NEXT',
  KEYCODE_MEDIA_PREVIOUS: 'KEYCODE_MEDIA_PREVIOUS',
  KEYCODE_MEDIA_FAST_FORWARD: 'KEYCODE_MEDIA_FAST_FORWARD',
  KEYCODE_MEDIA_REWIND: 'KEYCODE_MEDIA_REWIND',
  KEYCODE_SETTINGS: 'KEYCODE_SETTINGS',
  KEYCODE_TV_INPUT: 'KEYCODE_TV_INPUT',
  KEYCODE_INFO: 'KEYCODE_INFO',
  KEYCODE_SEARCH: 'KEYCODE_SEARCH',
  KEYCODE_VOICE_ASSIST: 'KEYCODE_VOICE_ASSIST',
  KEYCODE_PROG_RED: 'KEYCODE_PROG_RED',
  KEYCODE_PROG_GREEN: 'KEYCODE_PROG_GREEN',
  KEYCODE_PROG_YELLOW: 'KEYCODE_PROG_YELLOW',
  KEYCODE_PROG_BLUE: 'KEYCODE_PROG_BLUE',
};

/** Catalogue apps Smart TV (filtrées après découverte) */
export const APPS = {
  netflix: { label: 'Netflix', packages: ['com.netflix.ninja', 'com.netflix.mediaclient'], link: 'https://www.netflix.com/title' },
  youtube: { label: 'YouTube', packages: ['com.google.android.youtube.tv', 'com.google.android.youtube.tvunplugged', 'com.google.android.youtube'], link: 'https://www.youtube.com' },
  prime: { label: 'Prime', packages: ['com.amazon.amazonvideo.livingroom', 'com.amazon.avod'], link: 'https://app.primevideo.com' },
  disney: { label: 'Disney+', packages: ['com.disney.disneyplus'], link: 'https://www.disneyplus.com' },
  spotify: { label: 'Spotify', packages: ['com.spotify.tv.android'], link: 'https://open.spotify.com' },
  playstore: { label: 'Play', packages: ['com.android.vending'], link: null },
  settings: { label: 'Réglages', packages: ['com.android.tv.settings'], link: null },
  canal: { label: 'Canal+', packages: ['com.canal.android.canal'], link: null },
  molotov: { label: 'Molotov', packages: ['tv.molotov.app'], link: null },
  pluto: { label: 'Pluto', packages: ['tv.pluto.android'], link: null },
  twitch: { label: 'Twitch', packages: ['tv.twitch.android.app'], link: null },
  plex: { label: 'Plex', packages: ['com.plexapp.android'], link: null },
  vlc: { label: 'VLC', packages: ['org.videolan.vlc'], link: null },
  browser: { label: 'Navigateur', packages: ['com.tcl.browser'], link: null },
  live: { label: 'TV Live', packages: ['com.android.tv', 'com.realtek.dtv'], link: null },
};

const EXTRA_APP_PACKAGES = {
  telegram: { label: 'Telegram', packages: ['org.telegram.messenger', 'org.telegram.messenger.web'] },
  crunchyroll: { label: 'Crunchyroll', packages: ['com.crunchyroll.crunchyroid'] },
  rakuten: { label: 'Rakuten', packages: ['tv.wuaki'] },
};

export async function adbConnect(host, port = 5555) {
  const target = `${host}:${port}`;
  await run(['disconnect', target], { timeout: 4000 });
  const res = await run(['connect', target]);
  const text = res.out.toLowerCase();
  const ok = text.includes('connected to') || text.includes('already connected');
  return { ok, target, detail: res.out || res.err };
}

/** Appairage Wireless debugging (Android 11+) : adb pair IP:PORT + code */
export async function adbPair(host, port, code) {
  const target = `${host}:${port}`;
  const res = await run(['pair', target], { input: String(code).trim(), timeout: 20000 });
  const text = res.out.toLowerCase();
  const ok = text.includes('successfully paired') || res.ok;
  return { ok, detail: res.out || res.err };
}

export async function adbKey(host, port, key) {
  const code = ADB_KEYS[key] || key;
  const serial = `${host}:${port}`;
  return run(['-s', serial, 'shell', 'input', 'keyevent', code], { timeout: 5000 });
}

function serialOf(host, port) {
  return `${host}:${port}`;
}

export async function adbShell(host, port, shellArgs, timeout = 8000) {
  return run(['-s', serialOf(host, port), 'shell', ...shellArgs], { timeout });
}

export async function adbLaunch(host, port, appId) {
  const app = APPS[appId] || EXTRA_APP_PACKAGES[appId];
  if (!app) return { ok: false, out: '', err: 'App inconnue' };

  // Intents directs pour réglages / live
  if (appId === 'settings') {
    const r = await adbShell(host, port, ['am', 'start', '-n', 'com.android.tv.settings/.MainSettings']);
    return { ok: r.ok, detail: 'MainSettings' };
  }
  if (appId === 'live') {
    const r = await adbShell(host, port, ['am', 'start', '-n', 'com.android.tv/.TvActivity']);
    return { ok: r.ok, detail: 'TvActivity' };
  }

  for (const pkg of app.packages) {
    const r = await adbShell(host, port, ['monkey', '-p', pkg, '-c', 'android.intent.category.LEANBACK_LAUNCHER', '1'], 6000);
    if (r.ok || /Events injected/i.test(r.out)) return { ok: true, detail: pkg };
    const r2 = await adbShell(host, port, ['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], 6000);
    if (r2.ok || /Events injected/i.test(r2.out)) return { ok: true, detail: pkg };
  }

  if (app.link) {
    const r = await adbShell(host, port, ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', app.link], 6000);
    if (r.ok) return { ok: true, detail: app.link };
  }

  return { ok: false, out: '', err: `Impossible d’ouvrir ${appId}` };
}

/** Actions TV constructeur (menus Image/Son Realtek/Itel, etc.) */
export async function adbTvAction(host, port, action) {
  const s = serialOf(host, port);
  const broadcast = async (act) =>
    run(['-s', s, 'shell', 'am', 'broadcast', '-a', act, '-n', 'com.realtek.menu/.receiver.GlobalMenuReceiver'], { timeout: 5000 });

  switch (action) {
    case 'menu': {
      // Menu TV constructeur (Image / Son / Chaînes…) — pas KEYCODE_MENU
      let r = await run(['-s', s, 'shell', 'am', 'start', '-n', 'com.realtek.menu/.MainActivity'], { timeout: 5000 });
      if (r.ok) return { ok: true, detail: 'realtek.menu' };
      r = await run(['-s', s, 'shell', 'am', 'start', '-n', 'com.android.tv.settings/.MainSettings'], { timeout: 5000 });
      return { ok: r.ok, detail: 'settings.fallback' };
    }
    case 'picture': {
      const r = await broadcast('com.realtek.intent.START_NEWMENU_PICTURE');
      if (r.ok) return { ok: true, detail: 'picture' };
      return run(['-s', s, 'shell', 'am', 'start', '-n', 'com.android.tv.settings/.device.displaysound.DisplaySoundActivity'], { timeout: 5000 })
        .then((x) => ({ ok: x.ok, detail: 'displaysound' }));
    }
    case 'sound': {
      const r = await broadcast('com.realtek.intent.START_NEWMENU_SOUND');
      if (r.ok) return { ok: true, detail: 'sound' };
      return run(['-s', s, 'shell', 'am', 'start', '-n', 'com.android.tv.settings/.device.displaysound.DisplaySoundActivity'], { timeout: 5000 })
        .then((x) => ({ ok: x.ok, detail: 'displaysound' }));
    }
    case 'display_sound':
      return run(['-s', s, 'shell', 'am', 'start', '-n', 'com.android.tv.settings/.device.displaysound.DisplaySoundActivity'], { timeout: 5000 })
        .then((x) => ({ ok: x.ok, detail: 'displaysound' }));
    case 'network':
      return run(['-s', s, 'shell', 'am', 'start', '-n', 'com.android.tv.settings/.connectivity.NetworkActivity'], { timeout: 5000 })
        .then((x) => ({ ok: x.ok, detail: 'network' }));
    case 'inputs':
    case 'source': {
      // Source HDMI / tuner
      let r = await run(['-s', s, 'shell', 'input', 'keyevent', 'KEYCODE_TV_INPUT'], { timeout: 4000 });
      if (r.ok) return { ok: true, detail: 'tv_input' };
      r = await run(['-s', s, 'shell', 'am', 'start', '-n', 'com.android.tv/.TvActivity'], { timeout: 5000 });
      return { ok: r.ok, detail: 'tv_activity' };
    }
    case 'settings':
      return run(['-s', s, 'shell', 'am', 'start', '-n', 'com.android.tv.settings/.MainSettings'], { timeout: 5000 })
        .then((x) => ({ ok: x.ok, detail: 'settings' }));
    case 'channels': {
      const r = await broadcast('com.realtek.intent.StartChannelSetupNewMenu');
      return { ok: r.ok, detail: 'channels' };
    }
    default:
      return { ok: false, err: 'Action inconnue' };
  }
}

/** Profil télé : marque, apps installées, menus disponibles */
export async function adbDiscover(host, port) {
  const s = serialOf(host, port);
  const prop = async (name) => {
    const r = await run(['-s', s, 'shell', 'getprop', name], { timeout: 4000 });
    return (r.out || '').trim();
  };
  const [brand, model, manufacturer, release, packagesOut, hasRealtekMenu, hasDisplaySound] = await Promise.all([
    prop('ro.product.brand'),
    prop('ro.product.model'),
    prop('ro.product.manufacturer'),
    prop('ro.build.version.release'),
    run(['-s', s, 'shell', 'pm', 'list', 'packages'], { timeout: 12000 }),
    run(['-s', s, 'shell', 'pm', 'path', 'com.realtek.menu'], { timeout: 5000 }),
    run(['-s', s, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', 'com.android.tv.settings/.device.displaysound.DisplaySoundActivity'], { timeout: 5000 }),
  ]);

  const installed = new Set(
    (packagesOut.out || '')
      .split('\n')
      .map((l) => l.replace(/^package:/, '').trim())
      .filter(Boolean)
  );

  const catalog = { ...APPS, ...EXTRA_APP_PACKAGES };
  const apps = [];
  for (const [id, meta] of Object.entries(catalog)) {
    const pkg = (meta.packages || []).find((p) => installed.has(p));
    if (pkg || id === 'settings' || id === 'live') {
      // settings/live presque toujours présents sur Android TV
      if (id === 'settings' && !installed.has('com.android.tv.settings')) continue;
      if (id === 'live' && !installed.has('com.android.tv') && !installed.has('com.realtek.dtv')) continue;
      if (pkg || id === 'settings' || id === 'live') {
        apps.push({ id, label: meta.label || id, package: pkg || meta.packages[0] });
      }
    }
  }

  const realtek = /package:/.test(hasRealtekMenu.out || '');
  const features = {
    realtekMenu: realtek,
    pictureMenu: realtek,
    soundMenu: realtek,
    displaySound: true,
    networkSettings: true,
    voice: true,
  };

  return {
    brand: brand || 'Android',
    model: model || 'TV',
    manufacturer: manufacturer || '',
    android: release || '',
    apps,
    features,
    menus: [
      { id: 'menu', label: 'Menu TV', available: realtek || true },
      { id: 'picture', label: 'Image', available: realtek || true },
      { id: 'sound', label: 'Son', available: realtek || true },
      { id: 'source', label: 'Source', available: true },
      { id: 'settings', label: 'Réglages', available: true },
      { id: 'network', label: 'Réseau', available: true },
    ],
  };
}

export function adbHelp(host) {
  return [
    `Sur Itel, « Débogage réseau » n'existe souvent pas. Cherche plutôt :`,
    ``,
    `A) Créer le menu développeur`,
    `   Réglages → Préférences de l'appareil (ou Système) → À propos`,
    `   Appuie 7× sur « Build » / « Numéro de build » / « Version Android TV »`,
    ``,
    `B) Dans Options pour les développeurs, active CE QUE TU VOIS :`,
    `   • Débogage USB  ← souvent suffisant`,
    `   • Débogage ADB`,
    `   • Débogage réseau`,
    `   • Débogage sans fil / Wireless debugging`,
    ``,
    `C) Si « Débogage sans fil » : ouvre-le → « Appairer avec un code »`,
    `   Note IP + port + code, puis utilise le formulaire Appairage ADB ici.`,
    ``,
    `D) Reconnecte ${host || 'la télé'} et autorise sur l'écran TV.`,
  ].join('\n');
}
