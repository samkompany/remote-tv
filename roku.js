/** Contrôle basique Roku (ECP HTTP :8060) */

export async function rokuKey(host, key) {
  const map = {
    POWER: 'Power',
    KEYCODE_HOME: 'Home',
    KEYCODE_BACK: 'Back',
    KEYCODE_DPAD_UP: 'Up',
    KEYCODE_DPAD_DOWN: 'Down',
    KEYCODE_DPAD_LEFT: 'Left',
    KEYCODE_DPAD_RIGHT: 'Right',
    KEYCODE_DPAD_CENTER: 'Select',
    KEYCODE_VOLUME_UP: 'VolumeUp',
    KEYCODE_VOLUME_DOWN: 'VolumeDown',
    KEYCODE_VOLUME_MUTE: 'VolumeMute',
    KEYCODE_MEDIA_PLAY_PAUSE: 'Play',
    KEYCODE_MEDIA_PLAY: 'Play',
    KEYCODE_MEDIA_PAUSE: 'Play',
    KEYCODE_MEDIA_REWIND: 'Rev',
    KEYCODE_MEDIA_FAST_FORWARD: 'Fwd',
    KEYCODE_CHANNEL_UP: 'ChannelUp',
    KEYCODE_CHANNEL_DOWN: 'ChannelDown',
    KEYCODE_INFO: 'Info',
    KEYCODE_SEARCH: 'Search',
  };
  const k = map[key] || key;
  const res = await fetch(`http://${host}:8060/keypress/${k}`, { method: 'POST' });
  return { ok: res.ok || res.status === 200 };
}

export async function rokuLaunch(host, appId) {
  const apps = {
    netflix: '12',
    youtube: '837',
    prime: '13',
    disney: '291097',
    spotify: '19977',
  };
  const id = apps[appId];
  if (!id) return { ok: false, error: 'App non supportée sur Roku' };
  const res = await fetch(`http://${host}:8060/launch/${id}`, { method: 'POST' });
  return { ok: res.ok || res.status === 200 };
}

export async function rokuInfo(host) {
  try {
    const res = await fetch(`http://${host}:8060/query/device-info`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const xml = await res.text();
    const name = xml.match(/<user-device-name>([^<]+)/)?.[1] || 'Roku';
    return { name, host, type: 'roku', platform: 'Roku' };
  } catch {
    return null;
  }
}
