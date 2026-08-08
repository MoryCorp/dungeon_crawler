# Dungeon Crawler

Donjon coopératif en ligne dans le navigateur, jusqu'à 4 joueurs. Déplacement
libre façon Necesse, combat au corps à corps.

## Démarrer

```bash
npm install
npm run dev
```

- Client : http://localhost:5173
- Serveur : http://localhost:3000

Entrez un pseudo et un code de partie. Les joueurs qui saisissent **le même code**
se retrouvent dans le même donjon. L'URL contient le code (`/#ABCD`) : il suffit
de partager le lien.

**Commandes**

| | |
|---|---|
| Se déplacer | ZQSD / WASD / flèches, 8 directions, vitesse constante |
| Viser | la souris — indépendamment du déplacement |
| Frapper | **clic gauche** (Espace en secours) |
| Manette | stick gauche pour bouger, stick droit pour viser, A ou gâchette pour frapper |

## Déplacement libre, combat en arc

Le monde est fait de tuiles, mais **les acteurs s'y déplacent en coordonnées
continues** : positions flottantes exprimées en tuiles, collisions résolues axe
par axe contre les murs. La grille ne sert plus qu'aux murs, au pathfinding et
au champ de vision — jamais à contraindre un déplacement.

Trois conséquences qui règlent les problèmes du prototype en grille :

- **La visée est découplée du déplacement.** On frappe où on regarde, pas où on
  marche. Un ennemi en diagonale n'est plus un cas particulier.
- **Le coup d'épée frappe un arc de 110° devant soi**, et touche *tout* ce qui
  s'y trouve. L'arc est élargi de la taille angulaire de la cible : un monstre
  au contact occupe un large secteur et devient facile à toucher, alors qu'un
  monstre lointain demande de viser. Chaque coup applique un recul.
- **Les monstres télégraphient.** Avant de frapper ils s'immobilisent pendant
  un `windup` (0.28 s à 0.80 s selon l'espèce) en affichant un arc rouge, et
  l'angle est figé à ce moment-là. Se décaler pendant la préparation fait rater
  le coup. Plus de dégâts qu'on ne pouvait pas voir venir.

Le serveur simule à **30 ticks/seconde** et fait autorité. Le client prédit son
propre déplacement en appelant `movePhysical()`, **exactement la même fonction
que le serveur** : une divergence ne peut venir que de la latence, jamais d'une
règle appliquée différemment. La correction est douce sous 1.2 tuile d'écart,
sèche au-delà.

## Architecture

```
packages/engine/   Règles du jeu. Aucune dépendance, aucun I/O.
  types.ts         Constantes, réglages de game feel, table des monstres
  rng.ts           PRNG mulberry32, état sérialisable
  mapgen.ts        Génération d'étage par BSP
  fov.ts           Champ de vision par lancer de rayons
  physics.ts       Collisions continues, géométrie des arcs, anti-empilement
  ai.ts            Dijkstra map + steering continu
  game.ts          createGame / step / movePhysical
  protocol.ts      Messages réseau partagés client/serveur

apps/server/       Node + ws. Fait autorité, sert aussi le client statique.
apps/client/       Vite + PixiJS. Rendu, entrées, prédiction, interpolation.
scripts/           dev, tests, observateur de debug
```

`step(state, inputs)` est **pure et déterministe**. C'est ce qui permet de
tester les règles sans serveur ni navigateur, de sauvegarder une partie en un
JSON, et de faire tourner le même code côté client.

Le client tourne à deux cadences : `applyState()` au rythme du réseau (30 Hz),
`render()` à chaque frame avec interpolation. Le joueur local n'est jamais
interpolé — il est dessiné à sa position prédite, sinon on sent un aller-retour
à chaque paquet.

Le brouillard n'est renvoyé qu'un paquet sur cinq : il suit la position, qui
bouge d'au plus 0.14 tuile par tick, donc l'envoyer 30 fois par seconde
coûterait 20 Ko/s par client pour un résultat identique à l'œil.

### Régler le game feel

Tout est dans `packages/engine/src/types.ts` : `PLAYER_SPEED`, `ATTACK_REACH`,
`ATTACK_HALF_ARC`, `ATTACK_COOLDOWN`, `ATTACK_KNOCKBACK`, et la table `MONSTERS`
(vitesse, portée, temps de préparation, recul par espèce). Aucun de ces réglages
n'est dupliqué ailleurs.

## Tests

```bash
npx tsx scripts/engine-test.ts   # règles pures, aucune dépendance externe
npx tsx scripts/smoke.ts         # bout en bout, serveur lancé requis
npx tsx scripts/observe.ts ABCD  # affiche l'état d'une room en direct
npm run typecheck
```

`engine-test` couvre notamment les cas qui rendaient le prototype pénible :
un ennemi en diagonale est touché, viser approximativement suffit au contact,
on ne traverse pas les murs mais on glisse le long, la diagonale ne donne pas de
bonus de vitesse, et un coup télégraphié se rate si la cible se décale.

En jeu, `window.__dc` expose les compteurs de frames, paquets, swings et effets
actifs — pratique pour distinguer « le réseau ne répond plus » de « le rendu est
figé ».

## Déploiement Coolify

Un seul container : le serveur Node sert le client statique **et** la WebSocket
sur le même port.

1. **New Resource → Application → Private Repository** → ce dépôt
2. **Build Pack : `Docker Compose`** — pas `Dockerfile`
3. Compose file : `docker-compose.yaml` (détecté à la racine)
4. Activer le webhook de déploiement automatique

Coolify lit le fichier et crée lui-même le volume persistant `dungeon-data` sur
`/data`, les variables, le domaine (via `SERVICE_FQDN_APP_3000`) et le
healthcheck. Le client choisit `wss://` ou `ws://` selon l'origine.

> Le build pack **Dockerfile** fonctionne aussi, mais Coolify ne lit alors ni
> `ENV` ni `EXPOSE` ni `VOLUME` : il faut ressaisir le port et créer le volume
> `/data` à la main. Sans ce volume, les parties disparaissent à chaque
> redéploiement.

## Sauvegarde

Un fichier JSON par partie dans `$DATA_DIR/rooms/<CODE>.json`, écrit toutes les
10 secondes et à l'arrêt du serveur (écriture atomique). Une room sans joueur
connecté ne tourne pas : le donjon est figé jusqu'au retour de quelqu'un.

Se reconnecter avec le même pseudo reprend le même personnage à sa position.

## Brancher de vrais sprites

Tout le placeholder est isolé dans `apps/client/src/atlas.ts` — rien d'autre ne
sait d'où viennent les textures.

1. Déposer le pack dans `apps/client/public/assets/packs/`
2. Remplacer `makeActorTexture` par un découpage du spritesheet
3. Remplacer `paintTile` par un `drawImage` depuis le tileset

Le pack visé est [Pixel Crawler](https://anokolisa.itch.io/free-pixel-art-asset-pack-topdown-tileset-rpg-16x16-sprites)
(16×16, top-down, gratuit) — les noms d'espèces dans `types.ts` sont déjà alignés
sur son contenu.

Gardez `TILE = 16` et un `SCALE` **entier**, sinon les pixels bavent.

## Aspérités connues

- Les monstres ne s'écartent pas de la trajectoire des autres : ils se doublent
  proprement mais ne contournent pas
- Prendre l'escalier téléporte toute l'équipe, sans vote ni confirmation
- La carte complète est envoyée au client : le brouillard est cosmétique
- Pas encore : objets, inventaire, classes, progression méta, son

## Pistes

1. Objets au sol et inventaire
2. Une esquive / roulade avec brèves i-frames (le recul et les télégraphes sont
   déjà là, il ne manque que le dash)
3. Classes de héros aux portées et cadences différentes
4. Attaques à distance, sorts
5. Sons — Howler.js, un fichier par événement, la moitié du game feel
