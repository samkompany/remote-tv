# remote-tv

Télécommande web pour Smart TV (Android TV / Google TV, ADB, Roku, Bluetooth).

## Pourquoi Vercel seul ne trouve pas la télé ?

Le site sur Vercel est dans le **cloud**. La télé est derrière ton **Wi‑Fi (NAT)**.  
Les deux ont Internet, mais **Internet ne permet pas de “voir” un appareil dans un salon** sans un relais chez toi.

```
[Navigateur / Vercel] ──HTTPS──► [Pont chez toi] ──Wi‑Fi local──► [Télé]
```

## Mode en ligne (lien à envoyer)

Sur l’ordinateur **à la maison** (même Wi‑Fi que la télé) :

```bash
npm install
export VERCEL_APP_URL=https://TON-APP.vercel.app
npm run share
```

Le terminal affiche un **lien à envoyer**. Ce lien ouvre l’UI Vercel déjà branchée sur ton pont.

Sinon, ouvre ton site Vercel et colle l’URL du pont (`https://….loca.lt`) dans le champ prévu.

## Mode local uniquement

```bash
npm start
```

→ [http://localhost:3000](http://localhost:3000)

## Déploiement Vercel (UI)

`vercel.json` sert le dossier `public/`.  
Le contrôle réel passe toujours par `npm run share` chez la personne qui a la télé.

## Bluetooth accessoire

```bash
cd native/BtHidBridge && swift build -c release
```

Puis dans l’UI : activer l’accessoire → appairer la télé.
