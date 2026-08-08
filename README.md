# Dungeon Crawler

Donjon coopératif en ligne dans le navigateur, jusqu'à 4 joueurs. Déplacement
libre façon Necesse, combat au corps à corps.

Une descente ressemble à ça : on nettoie l'étage, on ramasse ce qui tombe, on
relève celui qui s'est fait avoir, on trouve le gardien qui détient la clé, et
on prend l'escalier ensemble. Tous les 5 étages, un boss.

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
| Ramasser | marcher dessus |
| Relever un coéquipier | rester à côté de lui 2.5 s |
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

## Ce qui rend un combat différent du précédent

Le comportement, pas les statistiques. Cinq archétypes, chacun exigeant une
réponse distincte — c'est ce qui évite le « on tape le même monstre pendant une
heure » :

| Archétype | Espèces | Ce qu'il impose |
|---|---|---|
| `melee` | squelette, orc, squelette guerrier | avancer et échanger des coups |
| `archer` | squelette mage, orc mage | fermer l'écart : il tire de loin et recule si on le colle |
| `charger` | squelette rôdeur, orc guerrier | se décaler **sur le côté**, jamais reculer : il fonce en ligne droite |
| `bomber` | orc kamikaze | reculer, ou le tuer pendant son amorçage — sinon il explose en zone |
| `swarm` | chauve-souris, orc rôdeur | rapides et fragiles, en nombre : c'est là que la hache paie |

Le télégraphe reste la règle : le monstre s'immobilise pendant son `windup`,
l'angle est figé à ce moment-là, et le chargeur affiche en plus le **couloir**
de sa ruée. Se décaler pendant la préparation fait rater le coup.

Le porteur de clé de chaque étage est une élite (3.2× PV, 1.5× dégâts), jamais
une espèce d'essaim. Tous les 5 étages c'est un boss (9× PV) à la place.

## Butin et progression

Cinq armes, qui changent la façon de jouer plutôt qu'un chiffre : la **dague**
frappe vite et court, la **hache** ouvre un arc de 170° mais s'engage, la
**lance** tient à 2.4 tuiles dans un cône étroit, l'**arc** tire un projectile.
On les trouve dans les coffres et sur les boss ; on en change en marchant
dessus, et l'ancienne reste au sol pour un coéquipier.

L'**XP est commune à l'équipe** — ramasser une orbe fait monter tout le monde.
Sans ça celui qui porte les coups distance les autres et la moitié du groupe se
retrouve à jouer un donjon trop dur pour elle.

Les orbes sont aimantées à 3 tuiles : ramasser à la case près n'est pas du jeu.
Les cœurs, eux, restent au sol si on est déjà à pleine vie.

## Coopération : la mise à terre

Tomber à 0 PV ne tue pas : le joueur passe **à terre**, rampe à 1.3 tuile/s et
saigne pendant 25 secondes. Un coéquipier qui reste collé 2.5 s le relève à 45 %
de ses PV. Personne à côté, et il meurt pour de bon, puis réapparaît 8 s plus
tard près de l'équipe avec 2 s d'invulnérabilité.

Deux détails font que ça fonctionne plutôt que d'être une punition de plus :

- **Les monstres se désintéressent d'un joueur à terre.** Il est retiré du champ
  de flux et fortement dépriorisé comme cible : l'équipe peut venir le chercher
  au lieu de trouver un tas de monstres campé sur son corps.
- **Un joueur à terre n'est plus blessable.** L'achever en boucle n'apporterait
  qu'une frustration.

La progression de la relève redescend doucement quand on s'éloigne — on peut
lâcher une seconde pour repousser un monstre sans tout recommencer.

## Structure d'un étage

L'escalier est **verrouillé** à l'arrivée. Il faut trouver le gardien, le tuer,
ramasser sa clé. Le HUD affiche l'objectif en permanence. Ça donne une raison
d'explorer au lieu de courir vers la sortie, et un moment où toute l'équipe
converge au même endroit.

Un ou deux coffres sont posés dans des salles au hasard. Leur contenu est
verrouillé pour celui qui ouvre le temps qu'il s'en écarte : on voit ce qui est
tombé avant de décider d'échanger son arme, au lieu de subir l'échange.

## Architecture

```
packages/engine/   Règles du jeu. Aucune dépendance, aucun I/O.
  types.ts         Constantes, armes, table des monstres, réglages de game feel
  rng.ts           PRNG mulberry32, état sérialisable
  mapgen.ts        Génération d'étage par BSP
  fov.ts           Champ de vision par lancer de rayons
  physics.ts       Collisions continues, géométrie des arcs, anti-empilement
  ai.ts            Dijkstra map + steering continu, une logique par archétype
  game.ts          createGame / step / movePhysical
  protocol.ts      Messages réseau partagés client/serveur

apps/server/       Node + ws. Fait autorité, sert aussi le client statique.
apps/client/       Vite + PixiJS. Rendu, entrées, prédiction, interpolation.
scripts/           dev, tests, observateur et carte ASCII de debug
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

Tout est dans `packages/engine/src/types.ts`, et nulle part ailleurs :
`PLAYER_SPEED`, la table `WEAPONS` (portée, ouverture d'arc, cadence, dégâts,
recul), la table `MONSTERS` (comportement, vitesse, portée, temps de préparation
par espèce), la courbe `xpForLevel`, et les constantes de mise à terre
(`BLEED_OUT_TICKS`, `REVIVE_TICKS`, `REVIVE_RANGE`).

Les événements réseau portent eux-mêmes la portée et l'ouverture d'un coup
(`{t:'swing', reach, halfArc}`) : le client dessine l'arc sans avoir à savoir
quelle arme a frappé, donc ajouter une arme ne demande aucune modification côté
rendu.

## Tests

```bash
npx tsx scripts/engine-test.ts   # règles pures, aucune dépendance externe
npx tsx scripts/smoke.ts         # bout en bout, serveur lancé requis
npx tsx scripts/observe.ts ABCD  # affiche l'état d'une room en direct
npx tsx scripts/mapdump.ts data/rooms/ABCD.json   # carte ASCII d'une sauvegarde
npm run typecheck
```

`engine-test` couvre notamment les cas qui rendaient le jeu pénible, chacun
ajouté après l'avoir vu en vrai : un ennemi en diagonale est touché, viser
approximativement suffit au contact, on glisse le long des murs sans les
traverser, la diagonale ne donne pas de bonus de vitesse, un coup télégraphié se
rate si la cible se décale, **une meute ne pousse pas le héros à travers un
mur**, et rester sur l'arme qu'on vient de poser ne la reprend pas en boucle.

`mapdump` sert exactement à ça : quand une position n'a pas de sens, la carte
ASCII dit en une seconde ce qu'un dump JSON cache.

En jeu, `window.__dc` expose les compteurs de frames, paquets, swings, effets
actifs, monstres/objets/projectiles reçus et la position prédite — pratique pour
distinguer « le réseau ne répond plus » de « le rendu est figé » de « je suis
coincé contre un mur ».

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

Se reconnecter avec le même pseudo reprend le même personnage à sa position,
avec son arme et son niveau.

Le format porte un numéro de version (`SAVE_VERSION`, actuellement **2**). Une
sauvegarde d'une autre version est ignorée et la partie repart d'un donjon
neuf : entre amis c'est acceptable, et bien préférable à un chargement d'état à
moitié valide.

## Brancher de vrais sprites

Tout le placeholder est isolé dans `apps/client/src/atlas.ts` — rien d'autre ne
sait d'où viennent les textures.

1. Déposer le pack dans `apps/client/public/assets/packs/`
2. Remplacer `makeActorTexture` par un découpage du spritesheet
3. Remplacer `paintTile` par un `drawImage` depuis le tileset
4. Remplacer `makeItemTexture` (cœurs, orbes, clé, coffre, armes)

Le pack visé est [Pixel Crawler](https://anokolisa.itch.io/free-pixel-art-asset-pack-topdown-tileset-rpg-16x16-sprites)
(16×16, top-down, gratuit) — les noms d'espèces dans `types.ts` sont déjà alignés
sur son contenu.

Gardez `TILE = 16` et un `SCALE` **entier**, sinon les pixels bavent.

## Aspérités connues

- Les monstres ne s'écartent pas de la trajectoire des autres : ils se doublent
  proprement mais ne contournent pas
- Prendre l'escalier téléporte toute l'équipe, sans vote ni confirmation
- Un joueur qui reste immobile au milieu d'un groupe finit à terre sans pouvoir
  rien y faire : c'est voulu pour les monstres, gênant pour un AFK
- La carte complète est envoyée au client : le brouillard est cosmétique
- On porte une arme, pas un inventaire : pas de sac, pas d'armure, pas de sorts
- Pas encore : classes, progression entre les parties, son

## Pistes

1. Une esquive / roulade avec brèves i-frames (le recul, les télégraphes et le
   dash des monstres sont déjà là, il ne manque que la version joueur)
2. Salles au trésor gardées, pièges au sol
3. Classes de héros avec une compétence propre
4. Modificateurs d'arme trouvés sur les boss (feu, poison, vol de vie)
5. Sons — Howler.js, un fichier par événement, la moitié du game feel
