# remote-tv

Télécommande web pour Smart TV (Android TV / Google TV, ADB, Roku).

## Local (contrôle direct)

```bash
npm install
npm start
```

Ouvre [http://localhost:3000](http://localhost:3000) — même Wi‑Fi / hotspot que la télé.

## Lien Vercel (envoyer aux autres)

Vercel héberge **l’interface**. La télé reste chez toi → il faut un **pont** :

```bash
export VERCEL_APP_URL=https://TON-APP.vercel.app
npm run share
```

Le terminal affiche un **lien à envoyer** (`?bridge=https://….trycloudflare.com`).  
Garde le terminal ouvert pendant les tests.

Sur Vercel : désactive **Deployment Protection** (Settings → Deployment Protection) sinon le lien demande un login.

## Déploiement Vercel

1. Import du repo GitHub `samkompany/remote-tv`
2. Deploy (config dans `vercel.json`)
3. Copie l’URL → `VERCEL_APP_URL` pour `npm run share`
