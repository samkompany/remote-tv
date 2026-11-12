# remote-tv

Télécommande web universelle pour Smart TV (Android TV / Google TV, ADB, Roku, Bluetooth HID).

## Démarrage local (vrai contrôle TV)

```bash
npm install
npm start
```

Ouvre [http://localhost:3000](http://localhost:3000).  
Le Mac/PC doit être sur le **même Wi‑Fi** que la télé (ou hotspot).

### Bluetooth accessoire (sans Wi‑Fi après appairage)

```bash
cd native/BtHidBridge
swift build -c release
```

Puis dans l’UI : **Activer accessoire Bluetooth** → **Appairer la télé**.

## Déploiement Vercel (UI / démo)

Le site sur Vercel sert l’interface (`public/`). Les routes `/api/*` affichent une page d’aide : le pilotage réel ne peut pas tourner dans le cloud (réseau local + Bluetooth).

1. Import du repo sur [vercel.com/new](https://vercel.com/new)
2. Framework Preset : **Other**
3. Build & Output déjà définis dans `vercel.json`
4. Deploy

Ou en CLI :

```bash
npx vercel
```

## Stack

- Node / Express (`server.js`)
- UI : `public/index.html`
- ADB / discovery / voice / Roku / Bluetooth helpers
