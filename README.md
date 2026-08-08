# Dungeon Crawler

Donjon coopératif en ligne dans le navigateur, jusqu'à 4 joueurs. Inspiré de
Pokémon Donjon Mystère pour la lisibilité tactique, de Necesse pour l'ambiance.

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

**Commandes** — ZQSD / WASD / flèches pour se déplacer (8 directions),
Espace pour attaquer. Manette Xbox / PlayStation / Pro supportée : appuyez sur
un bouton pour qu'elle soit détectée.

Se déplacer vers un ennemi l'attaque : pas de touche à retenir.

## Le choix central : des ticks, pas du tour par tour

Le tour par tour strict à 4 joueurs devient du Dofus — on attend que trois
personnes réfléchissent avant de bouger d'une case.

Ici le serveur fait tourner une horloge à **15 ticks/seconde** et chaque action
coûte un cooldown (déplacement ~133 ms, attaque ~400 ms). On agit dès que son
cooldown est écoulé : **personne n'attend personne**.

On garde donc la grille, le brouillard, les portées et le positionnement de PMD,
mais sans le temps d'attente. Et comme l'état reste discret (des cases, pas des
positions flottantes), il n'y a ni physique, ni prédiction, ni réconciliation :
le netcode tient en quelques centaines de lignes.

Corollaire agréable : la référence temporelle des monstres est l'horloge
serveur, ce qui règle l'ambiguïté « le temps de qui ? » qu'aurait posée le tour
par tour à plusieurs. Et le groupe peut se séparer sans que ça pose problème.

## Architecture

```
packages/engine/   Règles du jeu. Aucune dépendance, aucun I/O.
  types.ts         Constantes, coûts d'action, table des monstres
  rng.ts           PRNG mulberry32, état sérialisable
  mapgen.ts        Génération d'étage par BSP
  fov.ts           Champ de vision par lancer de rayons
  ai.ts            Dijkstra map : un BFS par tick pour tous les monstres
  game.ts          createGame / step — la fonction de pas, déterministe
  protocol.ts      Messages réseau partagés client/serveur

apps/server/       Node + ws. Fait autorité, sert aussi le client statique.
apps/client/       Vite + PixiJS. Rendu, entrées, interpolation.
scripts/           dev (lance les deux), tests, observateur de debug
```

Le point important : `step(state, intents)` est **pure et déterministe**. Même
état + mêmes intentions = même résultat, toujours. C'est ce qui permet de tester
les règles sans serveur ni navigateur, de sauvegarder une partie en un JSON, et
plus tard de faire tourner le même code côté client pour la prédiction.

Le client tourne à deux cadences : `applyState()` au rythme du réseau (15 Hz),
`render()` à chaque frame (60 Hz+) avec interpolation. C'est de là que vient la
fluidité malgré une simulation discrète.

## Tests

```bash
npx tsx scripts/engine-test.ts   # règles pures, aucune dépendance externe
npx tsx scripts/smoke.ts         # bout en bout, serveur lancé requis
npx tsx scripts/observe.ts ABCD  # affiche l'état d'une room en direct
npm run typecheck
```

`engine-test` vérifie notamment que toutes les salles générées sont accessibles
depuis le spawn, et que deux parties de même graine restent identiques après
300 ticks.

## Déploiement Coolify

Un seul container : le serveur Node sert le client statique **et** la WebSocket
sur le même port. Rien à câbler entre deux services.

1. **New Resource → Application → Private Repository** → ce dépôt
2. **Build Pack : Dockerfile**
3. **Port exposé : 3000**
4. **Persistent Storage** : monter un volume sur `/data`
   → sans ça, les parties sont perdues à chaque redéploiement
5. Domaine + HTTPS : le client choisit `wss://` tout seul selon l'origine
6. Activer le webhook de déploiement automatique

Aucune variable d'environnement n'est requise (`PORT` et `DATA_DIR` sont dans le
Dockerfile). `/healthz` répond pour le healthcheck.

## Sauvegarde

Un fichier JSON par partie dans `$DATA_DIR/rooms/<CODE>.json`, écrit toutes les
10 secondes et à l'arrêt du serveur (écriture atomique, pour survivre à un
redéploiement en plein vol).

Une room sans joueur connecté **ne tourne pas** : le donjon est figé jusqu'au
retour de quelqu'un. Se reconnecter avec le même pseudo reprend le même
personnage à sa position — un refresh de page ou un wifi qui saute ne coûte rien.

Postgres deviendra utile le jour où il y aura de la progression méta entre les
parties. Pas avant.

## Brancher de vrais sprites

Tout le placeholder est isolé dans `apps/client/src/atlas.ts` — rien d'autre dans
le projet ne sait d'où viennent les textures.

1. Déposer le pack dans `apps/client/public/assets/packs/`
2. Remplacer `makeActorTexture` par un découpage du spritesheet
3. Remplacer `paintTile` par un `drawImage` depuis le tileset

Le pack visé est [Pixel Crawler](https://anokolisa.itch.io/free-pixel-art-asset-pack-topdown-tileset-rpg-16x16-sprites)
(16×16, top-down, gratuit) — les noms d'espèces dans `types.ts` sont déjà alignés
sur son contenu (skeleton / orc × base / warrior / mage / rogue).

Gardez `TILE = 16` et un `SCALE` **entier**, sinon les pixels bavent.

## Aspérités connues

- Le respawn peut vous remettre à côté du monstre qui vient de vous tuer
  (pas d'invulnérabilité temporaire)
- Prendre l'escalier téléporte toute l'équipe, sans vote ni confirmation
- La carte complète est envoyée au client : le brouillard est cosmétique.
  Sans importance entre amis, à resserrer si ça devient public.
- Pas encore : objets, inventaire, classes, progression méta, son

## Pistes

Par ordre de rapport plaisir/effort :

1. Objets au sol et inventaire (le loot transforme l'exploration)
2. Classes de héros aux cooldowns différents (le système les gère déjà)
3. Un village hub persistant entre les runs
4. Attaques à distance et sorts
5. Sons — Howler.js, un fichier par événement, la moitié du game feel
