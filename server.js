import express from 'express';
import fs from 'fs';
import net from 'net';
import os from 'os';
import dns from 'dns/promises';
import { Bonjour } from 'bonjour-service';
import { AndroidRemote, RemoteKeyCode, RemoteDirection } from 'androidtv-remote';
import { adbConnect, adbPair, adbKey, adbLaunch, adbHelp, adbDiscover, adbTvAction, APPS } from './adb.js';
import { runVoiceOnAdb } from './voice.js';
import { rokuKey, rokuLaunch, rokuInfo } from './roku.js';
import {
  scanBluetoothTvs,
  openTvBluetoothPairing,
  bluetoothLimitationFr,
  listBluetoothDevices,
  launchBtRemoteApp,
  launchBtHidBridge,
  sendBtHidKey,
  pairClassicTv,
  btRemoteInstalled,
} from './bluetooth.js';

const CERT_FILE = './cert.json';
const CONNECT_TIMEOUT_MS = 12000;
const ADB_PORT = 5555;
const app = express();
app.use(express.json());
app.use(express.static('public'));

let remote = null;
let connectTimer = null;
/** @type {{ status: string, host: string|null, error: string|null, mode?: string|null, platform?: string|null, profile?: object|null }} */
let state = { status: 'idle', host: null, error: null, mode: null, platform: null, profile: null };
let adbTarget = null;
let activeType = null; // android | adb | roku
let tvProfile = null;

const loadCerts = () => (fs.existsSync(CERT_FILE) ? JSON.parse(fs.readFileSync(CERT_FILE)) : {});
const saveCert = (host, cert) => {
  const all = loadCerts();
  all[host] = cert;
  fs.writeFileSync(CERT_FILE, JSON.stringify(all));
};

const ipv4 = (addrs = []) => addrs.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));

async function resolveHost(hostname) {
  if (!hostname) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return hostname;
  try {
    const { address } = await dns.lookup(hostname, { family: 4 });
    return address;
  } catch {
    return null;
  }
}

function localIpv4s() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}

function stopRemote() {
  clearTimeout(connectTimer);
  connectTimer = null;
  try { remote?.pairingManager?.client?.destroy(); } catch {}
  try { remote?.remoteManager?.client?.destroy(); } catch {}
  try { remote?.stop(); } catch {}
  remote = null;
  adbTarget = null;
  activeType = null;
  tvProfile = null;
}

function setError(message) {
  stopRemote();
  state = { status: 'idle', host: null, error: message, mode: null, platform: null, profile: null };
}

async function attachAdbProfile(host) {
  try {
    tvProfile = await adbDiscover(host, ADB_PORT);
    const label = [tvProfile.brand, tvProfile.model].filter(Boolean).join(' ');
    state.platform = label || state.platform;
    state.profile = tvProfile;
  } catch (e) {
    tvProfile = null;
    state.profile = null;
  }
}

function probePort(host, port, ms = 2500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.setTimeout(ms);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

async function connectAdb(host) {
  const open = await probePort(host, ADB_PORT, 2000);
  if (!open) return { ok: false, reason: 'closed' };
  const res = await adbConnect(host, ADB_PORT);
  if (!res.ok) return { ok: false, reason: res.detail || 'adb connect failed' };
  adbTarget = { host, port: ADB_PORT };
  remote = null;
  activeType = 'adb';
  state = { status: 'ready', host, error: null, mode: 'adb', platform: 'Android TV / Google TV', profile: null };
  await attachAdbProfile(host);
  return { ok: true };
}

async function connectRoku(host) {
  const info = await rokuInfo(host);
  if (!info) return { ok: false };
  activeType = 'roku';
  adbTarget = null;
  remote = null;
  state = { status: 'ready', host, error: null, mode: 'roku', platform: 'Roku' };
  return { ok: true };
}

async function connectNative(host) {
  const saved = loadCerts()[host] || {};
  remote = new AndroidRemote(host, {
    pairing_port: 6467,
    remote_port: 6466,
    service_name: 'Smart TV Remote',
    cert: saved,
  });

  remote.on('secret', () => {
    clearTimeout(connectTimer);
    if (state.host === host) state = { status: 'waiting_code', host, error: null, mode: 'native', platform: 'Android TV' };
  });
  remote.on('ready', () => {
    clearTimeout(connectTimer);
    activeType = 'android';
    state = { status: 'ready', host, error: null, mode: 'native', platform: 'Android TV / Google TV' };
    try { saveCert(host, remote.getCertificate()); } catch {}
  });
  remote.on('error', (e) => { state.error = String(e?.message || e); });
  remote.on('unpaired', () => setError('Appairage perdu — reconnecte-toi.'));

  connectTimer = setTimeout(() => {
    if (state.status === 'connecting' && state.host === host) {
      connectAdb(host).then((r) => {
        if (r.ok) return;
        setError(adbHelp(host));
      });
    }
  }, CONNECT_TIMEOUT_MS);

  const started = await remote.start();
  if (!started && state.status === 'connecting' && state.host === host) {
    const adb = await connectAdb(host);
    if (!adb.ok) setError(adbHelp(host));
  }
}

// 1) Découverte multi-plateforme
app.get('/api/scan', async (req, res) => {
  const bonjour = new Bonjour();
  const found = new Map();

  const add = (ip, data) => {
    if (!ip) return;
    const prev = found.get(ip) || {};
    found.set(ip, { ...prev, ...data, host: ip });
  };

  const browsers = [
    ...['androidtvremote2', 'androidtvremote'].map((type) =>
      bonjour.find({ type }, async (s) => {
        const ip =
          ipv4(s.addresses) ||
          ipv4([s.referer?.address].filter(Boolean)) ||
          (await resolveHost(s.host?.replace(/\.$/, '')));
        add(ip, {
          name: s.name || 'Android TV',
          type: 'android',
          platform: 'Android TV / Google TV / Itel / TCL…',
          methods: ['native', 'adb'],
        });
      })
    ),
    bonjour.find({ type: 'googlecast' }, async (s) => {
      const ip =
        ipv4(s.addresses) ||
        ipv4([s.referer?.address].filter(Boolean)) ||
        (await resolveHost(s.host?.replace(/\.$/, '')));
      add(ip, {
        name: s.name || 'Cast TV',
        type: found.get(ip)?.type || 'cast',
        platform: found.get(ip)?.platform || 'Google Cast / Android TV',
        methods: ['adb', 'native'],
      });
    }),
    bonjour.find({ type: 'roku' }, async (s) => {
      const ip =
        ipv4(s.addresses) ||
        ipv4([s.referer?.address].filter(Boolean)) ||
        (await resolveHost(s.host?.replace(/\.$/, '')));
      add(ip, {
        name: s.name || 'Roku',
        type: 'roku',
        platform: 'Roku',
        methods: ['roku'],
      });
    }),
  ];

  setTimeout(async () => {
    for (const b of browsers) b.stop();
    bonjour.destroy();

    // Probe Roku on hotspot neighbors if needed
    const mine = localIpv4s().find((a) => a.startsWith('172.20.10.'));
    if (mine) {
      for (const last of [2, 3, 4, 6, 7, 8]) {
        const ip = `172.20.10.${last}`;
        if (ip === mine || found.has(ip)) continue;
        const info = await rokuInfo(ip);
        if (info) add(ip, { ...info, methods: ['roku'] });
      }
      if (![...found.values()].some((d) => d.type === 'android' || d.type === 'cast')) {
        add('172.20.10.6', {
          name: 'Smart TV (hotspot)',
          type: 'android',
          platform: 'Android TV (à confirmer)',
          methods: ['adb', 'native'],
        });
      }
    }

    // Enrichir avec Bluetooth (nom / MAC → IP via ARP)
    try {
      const bt = await scanBluetoothTvs();
      for (const d of bt) {
        if (d.host) {
          add(d.host, {
            name: d.name,
            type: d.type || 'android',
            platform: d.platform,
            methods: d.methods || ['adb'],
            transport: d.transport,
            btAddress: d.btAddress,
          });
        } else {
          // Pas d'IP : entrée spéciale (clé = bt MAC)
          const key = `bt:${d.btAddress}`;
          if (!found.has(key)) {
            found.set(key, {
              name: d.name,
              host: null,
              btAddress: d.btAddress,
              type: 'bluetooth',
              platform: d.platform,
              methods: ['bluetooth-pair'],
              transport: 'bluetooth',
            });
          }
        }
      }
    } catch {}

    res.json([...found.values()]);
  }, 5500);
});

app.get('/api/bt/scan', async (req, res) => {
  try {
    const [tvs, all] = await Promise.all([scanBluetoothTvs(), listBluetoothDevices()]);
    res.json({
      tvs,
      devices: all,
      btRemoteInstalled: btRemoteInstalled(),
      note: bluetoothLimitationFr(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e), note: bluetoothLimitationFr() });
  }
});

/** Mode accessoire : Mac = télécommande HID pour la TV */
app.post('/api/bt/become-accessory', async (req, res) => {
  const host = req.body?.host || state.host || null;
  const bridge = await launchBtHidBridge();
  let tvPairingOpened = false;
  if (host) {
    const pair = await openTvBluetoothPairing(host, ADB_PORT);
    tvPairingOpened = !!pair.tvPairingOpened;
  }
  const help = [
    'La télé cherche du Bluetooth Classic (pas seulement le BLE).',
    '',
    '1) Sur la télé : Réglages → Télécommandes et accessoires → Ajouter un accessoire',
    '2) Sur cette page : clique « Appairer la télé (Bluetooth) »',
    '3) Dans la fenêtre Mac : sélectionne ta télé',
    '',
    'Ensuite tu peux couper le Wi‑Fi.',
    '',
    bridge.help,
  ].join('\n');

  if (bridge.ok || bridge.status?.classic?.sdp) {
    activeType = 'bluetooth';
    state = {
      ...state,
      status: 'ready',
      mode: 'bluetooth-hid',
      platform: 'Accessoire Bluetooth HID',
      error: null,
    };
  }
  res.json({
    ok: !!bridge.ok,
    tvPairingOpened,
    btRemote: bridge,
    help,
    btRemoteInstalled: btRemoteInstalled(),
    note: bluetoothLimitationFr(),
    state,
  });
});

/** Fenêtre macOS : choisir la télé pendant qu’elle cherche un accessoire */
app.post('/api/bt/pair-classic', async (req, res) => {
  const r = await pairClassicTv();
  if (r.ok) {
    activeType = 'bluetooth';
    state = {
      ...state,
      status: 'ready',
      mode: 'bluetooth-hid',
      platform: `Bluetooth → ${r.peer || 'TV'}`,
      error: null,
    };
  }
  res.json({ ...r, state });
});

app.post('/api/bt/pair-tv', async (req, res) => {
  const host = req.body?.host || state.host;
  if (!host) {
    const app = await launchBtRemoteApp();
    return res.json({
      ok: app.ok,
      help: 'Sans IP : ' + app.help,
      btRemote: app,
    });
  }
  const r = await openTvBluetoothPairing(host, ADB_PORT);
  res.json(r);
});

app.get('/api/bt/info', (req, res) => {
  res.json({ note: bluetoothLimitationFr(), btRemoteInstalled: btRemoteInstalled() });
});

// 2) Connexion selon type
app.post('/api/connect', async (req, res) => {
  const { host, preferAdb, type } = req.body || {};
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host || '')) {
    return res.status(400).json({ error: 'IP invalide' });
  }

  stopRemote();
  state = { status: 'connecting', host, error: null, mode: null, platform: null };
  res.json(state);

  try {
    if (type === 'roku' || preferAdb === 'roku') {
      const r = await connectRoku(host);
      if (!r.ok) setError('Roku injoignable sur le port 8060.');
      return;
    }

    if (preferAdb) {
      const adb = await connectAdb(host);
      if (adb.ok) return;
      setError(adbHelp(host));
      return;
    }

    // Auto: Roku si 8060 ouvert
    if (await probePort(host, 8060, 800)) {
      const r = await connectRoku(host);
      if (r.ok) return;
    }

    const [pairOk, remoteOk, adbOk] = await Promise.all([
      probePort(host, 6467),
      probePort(host, 6466),
      probePort(host, ADB_PORT),
    ]);
    if (state.host !== host || state.status !== 'connecting') return;

    if (adbOk) {
      const adb = await connectAdb(host);
      if (adb.ok) return;
    }

    if (pairOk || remoteOk) {
      await connectNative(host);
      return;
    }

    setError(
      adbHelp(host) +
      '\n\nAutres TV : Roku (souvent auto), Samsung/LG bientôt. Entre l’IP manuellement si besoin.'
    );
  } catch (e) {
    if (state.host === host) setError(String(e?.message || e));
  }
});

app.post('/api/cancel', (req, res) => {
  stopRemote();
  state = { status: 'idle', host: null, error: null, mode: null, platform: null, profile: null };
  res.json(state);
});

app.post('/api/adb-pair', async (req, res) => {
  const { host, port, code, connectPort } = req.body || {};
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host || '')) {
    return res.status(400).json({ error: 'IP invalide' });
  }
  const pairPort = Number(port);
  if (!pairPort || !code) {
    return res.status(400).json({ error: 'Port d’appairage et code requis' });
  }

  state = { status: 'connecting', host, error: null, mode: 'adb', platform: 'Android TV' };
  const paired = await adbPair(host, pairPort, code);
  if (!paired.ok) {
    setError(`Appairage ADB échoué : ${paired.detail}\n\n${adbHelp(host)}`);
    return res.json(state);
  }

  const cPort = Number(connectPort) || ADB_PORT;
  let connected = await adbConnect(host, cPort);
  let usePort = cPort;
  if (!connected.ok && cPort !== ADB_PORT) {
    connected = await adbConnect(host, ADB_PORT);
    usePort = ADB_PORT;
  }
  if (!connected.ok) {
    setError(`Appairé, mais connexion échouée (${connected.detail}).`);
    return res.json(state);
  }

  adbTarget = { host, port: usePort };
  activeType = 'adb';
  remote = null;
  state = { status: 'ready', host, error: null, mode: 'adb', platform: 'Android TV / Google TV', profile: null };
  await attachAdbProfile(host);
  res.json(state);
});

app.post('/api/code', async (req, res) => {
  try {
    if (!remote) return res.status(409).json({ error: 'Pas de connexion native en cours' });
    await remote.sendCode(String(req.body.code || '').trim());
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.post('/api/key', async (req, res) => {
  const { key } = req.body;

  // Mode accessoire BT (sans Wi‑Fi) : envoi HID via BtHidBridge
  if (activeType === 'bluetooth' || state.mode === 'bluetooth-hid') {
    const r = await sendBtHidKey(key);
    if (!r.ok) return res.status(503).json({ error: r.error || 'Pont Bluetooth inactif — reclique Devenir télécommande Bluetooth' });
    return res.json({ ok: true, mode: 'bluetooth-hid' });
  }

  if (state.status !== 'ready') return res.status(409).json({ error: 'Non connecté' });

  // MENU → vrai menu TV (Image/Son…) pas le KEYCODE générique
  if (key === 'KEYCODE_MENU' || key === 'MENU') {
    if (activeType === 'adb' && adbTarget) {
      const r = await adbTvAction(adbTarget.host, adbTarget.port, 'menu');
      if (!r.ok) return res.status(500).json({ error: 'Menu TV impossible' });
      return res.json({ ok: true, mode: 'adb', via: 'tv-menu' });
    }
  }

  if (key === 'KEYCODE_SETTINGS' || key === 'SETTINGS') {
    if (activeType === 'adb' && adbTarget) {
      const r = await adbTvAction(adbTarget.host, adbTarget.port, 'settings');
      return res.json({ ok: r.ok, mode: 'adb' });
    }
  }

  if (activeType === 'roku') {
    const r = await rokuKey(state.host, key);
    if (!r.ok) return res.status(500).json({ error: 'Touche Roku échouée' });
    return res.json({ ok: true, mode: 'roku' });
  }

  if (activeType === 'adb' && adbTarget) {
    const r = await adbKey(adbTarget.host, adbTarget.port, key);
    if (!r.ok) return res.status(500).json({ error: r.out || r.err || 'ADB key failed' });
    return res.json({ ok: true, mode: 'adb' });
  }

  if (!remote) return res.status(409).json({ error: 'Non connecté' });
  if (key === 'POWER') { remote.sendPower(); return res.json({ ok: true }); }
  const code = RemoteKeyCode[key];
  if (code === undefined) return res.status(400).json({ error: 'Touche inconnue' });
  remote.sendKey(code, RemoteDirection.SHORT);
  res.json({ ok: true });
});

/** Menus Image / Son / Source / Réseau… */
app.post('/api/tv-action', async (req, res) => {
  if (state.status !== 'ready') return res.status(409).json({ error: 'Non connecté' });
  const { action } = req.body || {};
  if (!action) return res.status(400).json({ error: 'Action requise' });

  if (activeType === 'adb' && adbTarget) {
    const r = await adbTvAction(adbTarget.host, adbTarget.port, action);
    if (!r.ok) return res.status(500).json({ error: r.err || 'Échec action TV' });
    return res.json({ ok: true, ...r });
  }

  if (action === 'settings' && remote) {
    try {
      remote.sendAppLink('https://www.android.com/tv/');
      return res.json({ ok: true, via: 'native-fallback' });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  }

  res.status(409).json({ error: 'Action non dispo dans ce mode (passe en ADB)' });
});

app.post('/api/app', async (req, res) => {
  if (state.status !== 'ready') return res.status(409).json({ error: 'Non connecté' });
  const { app: appId } = req.body || {};
  if (!APPS[appId] && activeType !== 'roku') return res.status(400).json({ error: 'App inconnue' });

  if (activeType === 'roku') {
    const r = await rokuLaunch(state.host, appId);
    if (!r.ok) return res.status(500).json({ error: r.error || 'Échec Roku' });
    return res.json({ ok: true, via: 'roku' });
  }

  if (activeType === 'adb' && adbTarget) {
    const r = await adbLaunch(adbTarget.host, adbTarget.port, appId);
    if (!r.ok) return res.status(500).json({ error: r.err || 'Échec lancement' });
    return res.json({ ok: true, via: 'adb', detail: r.detail });
  }

  if (!remote) return res.status(409).json({ error: 'Non connecté' });
  const link = APPS[appId]?.link;
  if (!link) return res.status(400).json({ error: 'Pas de lien pour cette app en mode natif' });
  try {
    remote.sendAppLink(link);
    res.json({ ok: true, via: 'native' });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/** Micro PC → texte → commande TV */
app.post('/api/voice', async (req, res) => {
  if (state.status !== 'ready') return res.status(409).json({ error: 'Non connecté' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Texte vide' });

  if (activeType === 'adb' && adbTarget) {
    const r = await runVoiceOnAdb(adbTarget.host, adbTarget.port, text);
    if (!r.ok) return res.status(500).json({ error: r.error || 'Échec vocal', action: r.action });
    return res.json({ ok: true, ...r });
  }

  if (activeType === 'roku') {
    // Roku: recherche
    await fetch(`http://${state.host}:8060/search/browse?keyword=${encodeURIComponent(text)}`, { method: 'POST' }).catch(() => {});
    return res.json({ ok: true, action: { type: 'search', query: text }, via: 'roku' });
  }

  if (remote && APPS) {
    try {
      remote.sendAppLink(`https://www.google.com/search?q=${encodeURIComponent(text)}`);
      return res.json({ ok: true, action: { type: 'search', query: text }, via: 'native' });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  }

  res.status(409).json({ error: 'Vocal non disponible dans ce mode' });
});

app.get('/api/status', (req, res) => res.json({ ...state, profile: tvProfile || state.profile }));

app.post('/api/discover', async (req, res) => {
  if (state.status !== 'ready' || activeType !== 'adb' || !adbTarget) {
    return res.status(409).json({ error: 'Découverte ADB uniquement' });
  }
  await attachAdbProfile(adbTarget.host);
  res.json({ ok: true, profile: tvProfile });
});

app.listen(3000, () => console.log('Smart TV Remote → http://localhost:3000'));
