# 🐱 Chat Radar 🐭

Jeu du chat et de la souris **dans la vraie vie**, avec radar GPS sur téléphone.
Un serveur Node + Socket.IO qui sert aussi la page web — un seul service à déployer.

## Lancer en local

```bash
npm install
npm start
# → http://localhost:3010
```

### Tester sans GPS (mode simulation)

Ouvre `http://localhost:3010/?sim` : ta position est fictive et tu te déplaces
en **glissant le doigt / la souris sur le radar**. Pratique pour tester une
partie complète avec plusieurs onglets.

### Tester avec de vrais téléphones en local

La géolocalisation des navigateurs exige du **HTTPS** (sauf sur `localhost`).
Deux options :

1. **Le plus simple : déployer sur Render** (gratuit, HTTPS inclus) — voir plus bas.
2. **Tunnel HTTPS temporaire** vers ta machine :
   ```bash
   npx localtunnel --port 3010
   ```
   → donne une URL `https://xxxx.loca.lt` à ouvrir sur les téléphones
   (même Wi-Fi pas nécessaire, ça passe par internet).

## Déployer sur Render

1. Pousse ce dossier dans un repo GitHub (ou un sous-dossier d'un repo).
2. Sur [render.com](https://render.com) → **New → Web Service** → connecte le repo.
3. Réglages :
   - **Root Directory** : `chat-radar` (si le repo contient d'autres projets)
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** : Free
4. C'est tout — Render fournit l'URL HTTPS. Les joueurs l'ouvrent sur leur téléphone.

⚠️ Sur le plan gratuit, Render endort le service après ~15 min d'inactivité :
la première connexion peut prendre 30–60 s (le temps du réveil), et **les
parties en cours sont perdues si le service s'endort** (état en mémoire).
Pour une session de jeu entre amis, ça n'arrive pas tant que des joueurs
sont connectés.

## Règles du jeu

- **1 chat** contre **N souris**. Le chat gèle au départ (dispersion des souris).
- **L'hôte règle tout dans le lobby** : qui est le chat (toucher un joueur,
  sinon tirage au sort), la durée de la chasse (10–60 min), le temps de
  dispersion (0 s à 5 min), la **zone rétrécissante** (désactivée, ou 200 m
  à 1,2 km de rayon initial) et **chaque pouvoir en détail** (⚙️ Prix des
  pouvoirs) : activé ou non, prix (0–500 pts) et durée d'effet (5–600 s).
  Un pouvoir désactivé disparaît de la barre en jeu. Les autres joueurs
  voient les réglages en lecture seule.
- **Zone rétrécissante** (optionnelle) : fixée sur la position du chat à la
  fin de la dispersion, elle rétrécit linéairement jusqu'à 40 m à la fin de
  la partie (cercle violet pointillé sur la carte, rayon affiché en continu).
  Une souris **hors zone** ne gagne plus aucun point, apparaît sur **tous**
  les scans du chat (l'invisibilité et le leurre ne la protègent plus) et
  reçoit une alerte permanente « ⛔ HORS ZONE ».
- **Radar** : une vraie carte (Leaflet + OpenStreetMap) centrée sur toi,
  avec les autres joueurs en marqueurs nominatifs. Les souris voient le chat
  rafraîchi toutes les 4 s ; le chat ne voit les souris que par **scans
  toutes les 25 s**, avec ±20 m d'imprécision (les marqueurs pâlissent entre
  deux scans). Les blips du scan sont **anonymes** (pas de pseudo) — savoir
  qui est où, c'est le rôle des pouvoirs Révélation et Coup de filet.
  L'info est du côté des souris, la capture du côté du chat.
  Bouton « Recentrer » si tu as déplacé la carte ; en mode `?sim`, clique
  sur la carte pour te déplacer.
- **Capture** : le chat clique sur le pseudo d'une souris qu'il a vue IRL.
  Le serveur vérifie en silence qu'ils sont à **moins de 15 m** ; ensuite la
  souris **accepte ou conteste**. Déclaration ratée → recharge de 45 s, et
  si le chat s'est trompé (trop loin ou capture contestée) il perd **20 pts**.
- **Boussole** : un cône bleu au centre du radar montre la direction dans
  laquelle tu regardes.
- **Permissions** : dans le lobby, un bloc « Prépare ton téléphone » avec
  deux boutons déclenche les popups système — 📍 position (iOS/Android) et
  🧭 boussole (obligatoire sur iPhone : Apple exige un geste explicite).
  Boutons verts ✅ = prêt à jouer ; en cas de refus, le jeu affiche le
  chemin exact dans les réglages du téléphone pour réautoriser.
- **Points** : chat +1/10 s, +15 par contact radar (< 50 m), +40 par capture.
  Souris +1/10 s, **+3/10 s quand le chat est à moins de 20 m** (frisson),
  +30 en cas de survie.
- **Pouvoirs du chat** (coûts par défaut) : Coup de filet (8),
  Radar rapide (10), Chat fantôme (15), Sonnerie (15), Révélation (15).
- **Pouvoirs des souris** : Entraide (8), Sixième sens (10, alerte quand le
  chat est à moins de 40 m, 1 min), Brouillage (15), Leurre (15 : **touche
  la carte** pour poser ta fausse position où tu veux, jusqu'à 1 km de toi),
  Invisibilité (15), **Faux ami** (15 : fais sonner fort le téléphone d'une
  autre souris — pour attirer le chat sur elle 😈).
- **Avant de jouer** : le lobby propose « 🔊 Tester le son et la vibration »
  — chacun vérifie que son téléphone sonne et vibre (volume, mode
  silencieux) avant le départ. Ce test « débloque » aussi l'audio du
  navigateur, indispensable pour que la sonnerie marche à coup sûr.
- **Fin** : toutes les souris capturées → le chat gagne ; sinon les souris
  survivantes gagnent au bout du temps imparti.

## Conseils de jeu (limites du web mobile)

- **L'écran doit rester allumé** : le navigateur coupe le GPS si le téléphone
  se verrouille. Le jeu demande un « wake lock », mais garde le téléphone en main.
- Autorise la **géolocalisation précise** quand le navigateur la demande.
- Une souris déconnectée ne peut être ni capturée ni sonnée — si quelqu'un
  perd le réseau, il recharge simplement la page (la session est conservée).
