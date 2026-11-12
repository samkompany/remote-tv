import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ADB = [
  process.env.ADB_PATH,
  '/Users/michel/Library/Android/sdk/platform-tools/adb',
  'adb',
].find((c) => c === 'adb' || (c && fs.existsSync(c))) || 'adb';

const BTREMOTE_APP = '/Applications/BTRemote.app';
const BTREMOTE_PKG = path.join(__dirname, 'vendor', 'BTRemote.pkg');
const BTHID_BRIDGE = path.join(
  __dirname,
  'native',
  'BtHidBridge',
  '.build',
  'release',
  'BtHidBridge'
);
const BTHID_APP = path.join(__dirname, 'native', 'BtHidBridge', 'TelecommandeMac.app');
const BTHID_PORT = Number(process.env.BTHID_PORT || 8765);

function runAdb(args, timeout = 8000) {
  return new Promise((resolve) => {
    const child = spawn(ADB, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, out });
    }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, out: out.trim() });
    });
    child.on('error', () => {
      clearTimeout(t);
      resolve({ ok: false, out });
    });
  });
}

export function normMac(mac) {
  return String(mac || '')
    .toUpperCase()
    .replace(/[^0-9A-F]/g, '')
    .replace(/(..)(?=.)/g, '$1:');
}

export function relatedMacs(mac) {
  const n = normMac(mac).replace(/:/g, '');
  if (n.length !== 12) return [normMac(mac)];
  const bytes = n.match(/.{2}/g).map((h) => parseInt(h, 16));
  const variants = new Set([normMac(mac)]);
  for (const delta of [-1, 1, -2, 2]) {
    const b = bytes.slice();
    b[5] = (b[5] + delta + 256) % 256;
    variants.add(b.map((x) => x.toString(16).padStart(2, '0')).join(':').toUpperCase());
  }
  return [...variants];
}

export async function arpTable() {
  try {
    const arpBin = fs.existsSync('/usr/sbin/arp') ? '/usr/sbin/arp' : 'arp';
    const { stdout } = await execFileAsync(arpBin, ['-an'], { timeout: 8000 });
    const rows = [];
    for (const line of stdout.split('\n')) {
      const ip = line.match(/\((\d+\.\d+\.\d+\.\d+)\)/)?.[1];
      const mac = line.match(/\bat\s+([0-9a-f:]+)\b/i)?.[1];
      if (ip && mac && !/incomplete/i.test(mac)) {
        rows.push({ ip, mac: normMac(mac) });
      }
    }
    return rows;
  } catch {
    return [];
  }
}

export async function listBluetoothDevices() {
  try {
    const { stdout } = await execFileAsync(
      'system_profiler',
      ['SPBluetoothDataType', '-json'],
      { timeout: 15000, maxBuffer: 5_000_000 }
    );
    const json = JSON.parse(stdout);
    const root = json.SPBluetoothDataType?.[0] || {};
    const devices = [];

    const pushDev = (name, info, connected) => {
      if (!info || typeof info !== 'object') return;
      const addr = info.device_address || info.address || info.Address;
      if (!addr) return;
      devices.push({
        name: String(name).replace(/_/g, ' '),
        address: normMac(addr),
        connected: !!connected,
        rssi: info.device_rssivalue ?? info.rssi ?? null,
        vendor: info.device_vendorID ?? null,
        minorType: info.device_minorType || info.minor_type || null,
        transport: 'bluetooth',
      });
    };

    const collect = (node, connected) => {
      if (!node) return;
      if (Array.isArray(node)) {
        for (const item of node) {
          if (!item || typeof item !== 'object') continue;
          for (const [name, info] of Object.entries(item)) pushDev(name, info, connected);
        }
        return;
      }
      if (typeof node === 'object') {
        for (const [name, info] of Object.entries(node)) {
          if (info && typeof info === 'object' && (info.device_address || info.address)) {
            pushDev(name, info, connected);
          }
        }
      }
    };

    collect(root.device_connected, true);
    collect(root.device_not_connected, false);
    for (const key of Object.keys(root)) {
      if (/device_.*connected/i.test(key)) collect(root[key], !/not/i.test(key));
    }

    const map = new Map();
    for (const d of devices) {
      if (!map.has(d.address)) map.set(d.address, d);
    }
    return [...map.values()];
  } catch {
    return [];
  }
}

function looksLikeTv(dev) {
  const n = String(dev.name || '').toLowerCase();
  return /android\s*tv|google\s*tv|smart\s*tv|itel|tcl|sony|bravia|shield|mi\s*box|fire\s*tv|roku|\btv\b/i.test(n);
}

export async function scanBluetoothTvs() {
  const [btDevices, arp] = await Promise.all([listBluetoothDevices(), arpTable()]);
  const arpByMac = new Map(arp.map((r) => [r.mac, r.ip]));
  const results = [];
  const seenIp = new Set();

  let tvBt = null;
  try {
    const r = await runAdb(['devices', '-l'], 4000);
    const serial = (r.out || '').split('\n').map((l) => l.trim()).find((l) => /:5555\s+device/.test(l))?.split(/\s+/)[0];
    if (serial) {
      const mac = await runAdb(['-s', serial, 'shell', 'settings', 'get', 'secure', 'bluetooth_address'], 4000);
      const name = await runAdb(['-s', serial, 'shell', 'settings', 'get', 'global', 'device_name'], 4000);
      if (mac.ok && /:/.test(mac.out)) {
        tvBt = {
          address: normMac(mac.out.split('\n')[0]),
          name: (name.out || 'Android TV').split('\n')[0] || 'Android TV',
        };
      }
    }
  } catch {}

  const candidates = [...btDevices];
  if (tvBt && !candidates.some((d) => d.address === tvBt.address)) {
    candidates.push({ name: tvBt.name, address: tvBt.address, connected: false, rssi: null });
  }

  for (const dev of candidates) {
    const macs = relatedMacs(dev.address);
    let ip = null;
    for (const m of macs) {
      if (arpByMac.has(m)) {
        ip = arpByMac.get(m);
        break;
      }
    }
    const isTv = looksLikeTv(dev) || (tvBt && dev.address === tvBt.address);
    if (!isTv) continue;
    if (ip) seenIp.add(ip);
    results.push({
      name: dev.name || 'Smart TV',
      host: ip,
      btAddress: dev.address,
      connected: !!dev.connected,
      type: 'android',
      transport: ip ? 'bluetooth+wifi' : 'bluetooth',
      platform: ip
        ? 'Trouvée via Bluetooth → IP (pilotage Wi‑Fi/ADB ou accessoire BT)'
        : 'Bluetooth TV détectée — mode accessoire recommandé',
      methods: ip ? ['adb', 'bluetooth-accessory'] : ['bluetooth-accessory'],
      rssi: dev.rssi,
      role: 'tv-host',
    });
  }

  for (const row of arp) {
    if (seenIp.has(row.ip)) continue;
    if (row.ip.startsWith('172.20.10.') && row.ip.endsWith('.6')) {
      results.push({
        name: 'Smart TV (réseau)',
        host: row.ip,
        btAddress: row.mac,
        connected: false,
        type: 'android',
        transport: 'bluetooth+wifi',
        platform: 'IP via ARP — peut servir pour ouvrir l’appairage BT',
        methods: ['adb', 'bluetooth-accessory'],
        role: 'tv-host',
      });
    }
  }

  return results;
}

export function btRemoteInstalled() {
  return fs.existsSync(BTHID_APP) || fs.existsSync(BTHID_BRIDGE) || fs.existsSync(BTREMOTE_APP);
}

async function bridgeStatus() {
  try {
    const r = await fetch(`http://127.0.0.1:${BTHID_PORT}/status`, { signal: AbortSignal.timeout(800) });
    if (!r.ok) return null;
    const j = await r.json();
    // Normalize new {ble,classic} shape + legacy flat shape
    const advertising = !!(j.advertising ?? j.ble?.advertising ?? j.classic?.sdp);
    const ready = !!(j.ready ?? j.ble?.ready ?? j.classic?.sdp);
    const connected = !!(j.classic?.connected);
    return {
      ...j,
      advertising,
      ready,
      connected,
      name: j.name || 'Telecommande Mac',
      peer: j.classic?.peer || null,
    };
  } catch {
    return null;
  }
}

export async function pairClassicTv() {
  let st = await bridgeStatus();
  if (!st) {
    const launched = await launchBtHidBridge();
    if (!launched.ok) return launched;
  }
  try {
    const r = await fetch(`http://127.0.0.1:${BTHID_PORT}/pair`, {
      method: 'POST',
      signal: AbortSignal.timeout(120000),
    });
    const j = await r.json().catch(() => ({}));
    return {
      ok: !!j.ok,
      peer: j.peer,
      error: j.error,
      help: j.ok
        ? `Appairé avec « ${j.peer || 'télé'} ». Tu peux couper le Wi‑Fi et utiliser la télécommande.`
        : (j.error || 'Appairage annulé ou échoué — laisse la télé sur Ajouter un accessoire, puis réessaie.'),
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), help: 'Pont Bluetooth inactif.' };
  }
}

function accessoryHelp(st, prefix) {
  return [
    prefix,
    '',
    'Sur la télé :',
    '1) Réglages → Télécommandes et accessoires → Ajouter un accessoire',
    '2) Attends « Telecommande Mac » (accessoire Bluetooth)',
    '3) Sélectionne-la et accepte',
    '',
    'Ensuite tu peux COUPER le Wi‑Fi : les touches de la page web passent en Bluetooth.',
    st ? `État: advertising=${!!st.advertising} ready=${!!st.ready}` : '',
  ].filter(Boolean).join('\n');
}

export async function launchBtHidBridge() {
  if (!fs.existsSync(BTHID_BRIDGE) && !fs.existsSync(BTHID_APP)) {
    return {
      ok: false,
      help: 'BtHidBridge pas compilé. Dans native/BtHidBridge : swift build -c release',
    };
  }
  let st = await bridgeStatus();
  if (st?.advertising) {
    return {
      ok: true,
      alreadyRunning: true,
      status: st,
      help: accessoryHelp(st, `Accessoire actif : « ${st.name || 'Telecommande Mac'} »`),
    };
  }

  // Prefer direct binary (stable); app bundle for TCC if needed
  const bin = fs.existsSync(BTHID_APP)
    ? path.join(BTHID_APP, 'Contents', 'MacOS', 'TelecommandeMac')
    : BTHID_BRIDGE;

  // Avoid duplicate listeners on :8765
  if (!st) {
    spawn(bin, [], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, BT_REMOTE_NAME: 'Telecommande Mac' },
    }).unref();
  }

  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 500));
    st = await bridgeStatus();
    if (st?.advertising || st?.ready) break;
  }

  return {
    ok: !!(st?.ready || st?.advertising),
    status: st,
    help: accessoryHelp(
      st,
      st?.advertising
        ? 'Le Mac annonce « Telecommande Mac » en Bluetooth (HID).'
        : 'Pont lancé — autorise Bluetooth pour Telecommande Mac si macOS le demande, puis réessaie.'
    ),
  };
}

export async function sendBtHidKey(key) {
  try {
    const r = await fetch(`http://127.0.0.1:${BTHID_PORT}/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(1500),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok !== false, ...j };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function launchBtRemoteApp() {
  // BLE HID bridge = vrai rôle « accessoire » quand la TV cherche
  return launchBtHidBridge();
}

/** Ouvre l’écran « Ajouter un accessoire » sur la télé (besoin ADB/Wi‑Fi une fois) */
export async function openTvBluetoothPairing(host, port = 5555) {
  const serial = `${host}:${port}`;
  await runAdb(['connect', serial], 5000);
  await runAdb(['-s', serial, 'shell', 'svc', 'bluetooth', 'enable'], 4000);

  const tries = [
    ['am', 'start', '-n', 'com.android.tv.settings/.accessories.AddAccessoryActivity'],
    ['am', 'start', '-a', 'android.settings.BLUETOOTH_SETTINGS'],
    ['am', 'start', '-a', 'android.bluetooth.adapter.action.REQUEST_DISCOVERABLE', '--ei', 'android.bluetooth.adapter.extra.DISCOVERABLE_DURATION', '120'],
  ];

  let opened = false;
  for (const args of tries) {
    const r = await runAdb(['-s', serial, 'shell', ...args], 5000);
    if (r.ok && !/Error type/i.test(r.out)) {
      opened = true;
      break;
    }
  }

  const app = await launchBtRemoteApp();

  return {
    ok: opened || app.ok,
    tvPairingOpened: opened,
    btRemote: app,
    help: [
      opened
        ? 'Écran « Ajouter un accessoire » ouvert sur la télé.'
        : 'Impossible d’ouvrir l’appairage via ADB — ouvre-le à la main sur la télé.',
      '',
      app.help,
    ].join('\n'),
  };
}

export function bluetoothLimitationFr() {
  return [
    'Android TV cherche des accessoires Bluetooth Classic.',
    '',
    '1. Sur la télé : Ajouter un accessoire (laisse l’écran ouvert)',
    '2. Ici : « Appairer la télé (Bluetooth) » → choisis la télé dans la fenêtre Mac',
    '3. Coupe le Wi‑Fi si tu veux — les touches passent en Bluetooth',
  ].join('\n');
}
