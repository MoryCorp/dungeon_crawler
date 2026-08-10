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

## Le modèle de puissance

Le jeu ne se règle pas en dégâts. Il se règle sur trois grandeurs, et c'est le
cadre standard des jeux d'action :

```
TTK = PV du monstre / DPS du joueur      temps pour tuer
TTD = PV effectifs  / DPS des monstres   temps pour mourir
K   = TTD / TTK                          combien on en gère à la fois
```

**L'invariant : TTK et K restent constants sur toute la descente.** La
difficulté ne vient jamais des statistiques, elle vient du nombre d'ennemis
simultanés et de la géométrie de la rencontre. C'est ce qui permet à l'étage 20
d'être aussi tendu que l'étage 2 sans que les monstres deviennent des éponges.

Trois conséquences, chacune imposée par une mesure :

1. **La puissance est multiplicative.** Le modèle additif (`arme + atk`) faisait
   disparaître l'arme dans le bruit : la hache frappait 3× plus fort que la
   dague au niveau 1, et seulement 1.36× au niveau 24. Il ne restait que la
   cadence, donc la dague gagnait toujours — elle a produit **89 % des dégâts**
   d'une descente réelle jusqu'à l'étage 16.
2. **Toutes les armes ont le même DPS.** Les dégâts se déduisent de la cadence
   (`WEAPON_DPS × cooldown`), en prenant la cadence arrondie au tick. Choisir
   une arme n'est plus « laquelle tape le plus fort » mais **quel profil de
   risque** : la dague force le contact, la hache te cloue sur place, la lance
   tient la distance dans un cône étroit.
3. **La montée des monstres est dérivée, pas choisie.** `FLOOR_HP_GROWTH` vaut
   exactement `ATK_GROWTH ^ LEVELS_PER_FLOOR` — le facteur qui garde TTK
   constant. Toucher à la progression du joueur recalcule le donjon tout seul.
   Il n'y a plus d'endroit où se mentir.

Les défenses passent par les **PV effectifs** (`effectiveHp`), pas par les PV
bruts, et la réduction de dégâts utilise la forme canonique à rendements
décroissants `a / (a + k)`. Personne ne porte d'armure aujourd'hui : le chemin
existe pour que les armures s'ajoutent **sans redériver TTD ni K**. Cette forme
a la propriété qui la rend sûre — les PV effectifs croissent *linéairement* avec
l'armure, donc aucun empilement ne peut s'emballer.

```bash
npx tsx scripts/curve.ts 20    # vérifie le modèle analytiquement, en 1 seconde
```

```
   étage  niveau      PV     TTK     TTD       K
       1       1      32    1.20    3.91    3.26
      10      10      50    1.20    3.94    3.28
      20      20      81    1.20    3.92    3.26

  Dérive de TTK sur 20 étages : ×1.000
  Écart de DPS entre la meilleure et la pire arme : ×1.000
```

Mesuré sur une vraie descente avant ce modèle, le TTK **tombait de 1.32 s à
0.48 s** entre l'étage 2 et l'étage 16 : les monstres mouraient deux fois plus
vite à mesure qu'on descendait. C'est ça qui empêchait toute tension, pas le
réglage des espèces.

## La difficulté, et pourquoi elle n'y était pas

Le prototype se traversait en avançant tout droit en cliquant. Ce n'était pas un
chiffre mal réglé, c'était une boucle cassée : **le recul verrouillait les
monstres**. L'épée poussait de 0.83 tuile, le monstre mettait 0.38 s à revenir
plus 0.40 s de préparation, et le cooldown de l'épée était de 0.42 s. On le
refrappait toujours avant qu'il ait fini d'armer. Structurellement, aucun
monstre au corps à corps ne pouvait toucher qui que ce soit.

Quatre changements, dans l'ordre de leur importance :

1. **Le recul a des rendements décroissants.** Le premier coup projette
   franchement — c'est ce qui rend une hache satisfaisante — puis chaque coup
   enchaîné pousse deux fois moins. Le compteur retombe si on arrête une
   seconde. Chaque espèce a en plus un `weight` : une chauve-souris s'envole,
   un orc guerrier bouge à peine, un boss ne recule pas.
2. **Frapper engage.** On ralentit pendant le coup, d'un facteur propre à
   l'arme. La hache tombe à 12 % de sa vitesse, la dague reste à 85 %. Frapper
   et fuir dans le même souffle n'est plus possible, et c'est ce qui donne enfin
   une identité à chaque arme.
3. **Les monstres montent avec l'étage.** PV, dégâts et cadence croissent avec
   la profondeur. Jamais le temps de préparation : le télégraphe doit rester
   aussi lisible à l'étage 20 qu'au premier, sinon la difficulté cesse d'être
   juste.
4. **Ils arrivent en meutes, et dans les couloirs.** Un monstre isolé n'est
   jamais une menace, quels que soient ses points de vie. À trois, il faut
   choisir lequel gérer d'abord. Un tiers d'entre eux est posé dans les
   couloirs, en privilégiant archers et chargeurs : ne pas pouvoir contourner
   ni reculer est le meilleur moment du jeu.

La courbe d'XP n'est pas choisie : ses deux coefficients sont **ajustés** sur le
butin réel des étages, de sorte que le niveau atteint suive l'étage. Ils sont
donc à refaire chaque fois que le peuplement change — `scripts/curve.ts` le
vérifie en une seconde.

### Ce qu'on ne tue pas descend derrière nous

Les quatre changements ci-dessus ont durci les combats, et n'ont rien changé au
problème de fond — que seules les mesures ont montré. Sur une vraie partie, un
joueur compétent laissait **60 % de l'étage derrière lui** : il trouvait la clé,
il descendait, et 5 étages sur 6 se traversaient sans jamais passer sous 65 % de
PV. Le donjon n'était pas trop faible, il était **facultatif**.

Alors les monstres laissés en vie suivent. À la descente, les survivants les
plus proches de l'escalier viennent avec vous, blessures comprises — mais ils ne
débouchent pas quelque part, ils sont versés à la réserve de la Directrice, qui
décidera quand les rendre.

La dette est entièrement choisie : nettoyer l'étage ne coûte rien, et le HUD
affiche en permanence combien descendent derrière vous.

C'est le changement qui a le plus d'effet, et il ne touche à aucune statistique :
il rend simplement le fait d'ignorer un monstre payant plus tard plutôt que
gratuit.

La première version les faisait sortir **un par un au pied de l'escalier
d'arrivée**, ce qui semblait raisonnable — une file est un choix, un mur de
seize est une condamnation. C'était le mauvais choix, et la mesure l'a dit :
il suffisait de rester à l'escalier et de les cueillir à la sortie, isolés, sans
jamais en affronter deux. Une menace qui arrive à un endroit connu et à un
rythme connu n'est pas une menace, c'est une file d'attente de cibles.

## La Directrice

Les meutes existaient déjà. La mesure de simultanéité a montré qu'elles ne
servaient à rien : **effectif médian 1, deux tiers du temps de combat en
tête-à-tête**, quatre étages sur six terminés à 100 % de PV. Des monstres posés
sur une carte, même côte à côte, n'arrivent jamais ensemble : les espèces n'ont
pas la même vitesse, le groupe s'étire pendant l'approche et se présente en file
indienne. Tout le modèle de puissance repose sur « la difficulté vient du nombre
simultané » — et la simultanéité valait 1.

D'où la Directrice, sur le modèle de celle de *Left 4 Dead* (2008). Elle ne
place pas les monstres, elle les **livre**.

Elle suit une **intensité perçue**, pas objective : elle monte fort quand on
encaisse, doucement quand on est simplement entouré, et retombe toute seule dès
qu'il ne se passe plus rien — un joueur qui recule pour souffler voit
effectivement la pression retomber au lieu d'être puni de sa prudence. Là-dessus
tourne une machine à quatre états :

```
montée → pic → décompression → repos → montée…
```

La difficulté n'est pas une rampe, c'est une **onde**. Une pression constante
n'est pas de la difficulté, c'est de l'épuisement : au bout de quelques minutes
on ne la perçoit plus, elle devient un bruit de fond. C'est le creux qui donne
sa valeur au pic, et c'est le repos — garanti, que rien ne peut écourter — qui
permet d'en replacer un sans que ce soit vécu comme une punition.

Une vague n'est livrée que pendant la montée, après plusieurs secondes de calme
continu. Elle arrive **hors du champ de vision**, entre 7 et 15 tuiles, serrée,
déjà en chasse, et **d'une seule espèce** — un groupe mixte s'étirerait sur le
trajet et arriverait un par un, c'est-à-dire exactement le défaut qu'on corrige.
Elle puise d'abord dans la dette de l'étage précédent, ensuite dans la réserve.

Deux conséquences qui n'étaient pas le but mais qui tombent bien :

- **Camper l'escalier ne sert plus à rien.** Ce qu'on doit ne revient plus à un
  endroit connu, il revient en groupe, ailleurs, au pire moment.
- **Personne ne se fait achever au sol.** Quand toute l'équipe est à terre, la
  Directrice n'a plus de munitions : livrer là ne produirait pas de la tension,
  ça s'acharnerait.

Le peuplement d'un étage s'est scindé en deux parts qui ne jouent pas le même
rôle : ce qui est **posé** sur la carte se rencontre en explorant, presque
toujours seul — c'est le décor du donjon ; ce qui est **gardé en réserve** est
sa difficulté. La réserve ne grandit pas avec l'étage, et c'est volontaire : le
modèle tient K constant, donc une vague de l'étage 20 n'est pas plus nombreuse,
elle est plus forte.

Premier relevé après coup : effectif médian **1.3 → 2.0**, tête-à-tête
**57 % → 39 %**, 5.7 vagues par étage. Et le bot qui fonçait vers la sortie en
ignorant tout, qui atteignait l'étage 12, meurt maintenant au troisième.

### Elle apprend : le bandit

La mesure suivante (partie TEST5) a montré que toutes les vagues ne se valent
pas contre un joueur donné : sur un profil mobile au corps à corps, les vagues
de mêlée et d'essaim faisaient **0.1 dégât par monstre** — la moitié des
munitions partait en vagues invisibles — pendant que chargeurs et archers
produisaient l'essentiel du danger.

Chaque vague suit donc une **recette** parmi six — ruée, clouage (chargeurs au
contact + archers en couverture), tenaille, mur (posé devant la direction de
déplacement récente de la cible), tireurs, harcèlement — et la Directrice
choisit la recette par **bandit manchot**, un levier par recette et par couple
joueur-arme (changer d'arme ouvre un carnet neuf — ce qui marche contre un
joueur à la dague ne dit rien contre le même joueur à l'arc) :
le gain d'une vague est le pic d'intensité produit dans les secondes qui la
suivent, et les recettes qui marchent sur *ce* joueur sortent plus souvent.
C'est l'échelle d'apprentissage adaptée à quatre amis — quelques dizaines de
vagues suffisent, là où du deep learning en voudrait des centaines de milliers.

Trois garde-fous : aucune recette ne meurt (20 % des vagues restent tirées au
hasard pur — l'imprévisibilité est une composante de la difficulté, et un
joueur qui change de style est re-détecté) ; le bandit choisit une forme, jamais
des statistiques — TTK et K restent hors de sa portée ; et tout est mesuré dans
le relevé, gain moyen par recette et par joueur, pour vérifier qu'il apprend
juste au lieu de le croire.

La matière première est le **profil de style** que l'engine cumule par joueur —
portée des coups, mobilité en combat, encombrement toléré, cohésion d'équipe,
patience — cinq mesures qui distinguent déjà un joueur qui nettoie (patience
80 %) d'un joueur qui fonce (29 %), affichées dans le rapport.

## Mesurer au lieu de deviner

Régler une difficulté au ressenti, c'est régler pour la seule personne qui a
joué. Chaque partie enregistre donc ce qui s'y est passé, **étage par étage** :
monstres présents et monstres tués, poursuivants traînés depuis l'étage
précédent, PV les plus bas atteints, temps passé sous 35 % de vie, dégâts
infligés par espèce, dégâts subis **par espèce**, qui vous a mis à terre, mises
à terre, morts, relèves, XP, niveau à l'entrée et à la sortie, coups portés et
dégâts par arme.

Le rapport « tués sur présents » est celui qui a payé le plus : c'est lui qui a
révélé qu'on ne combattait pas le donjon, on le traversait.

Le rapport recalcule aussi **TTK et K mesurés** et les compare aux cibles. Le
TTK compte les coups *qui touchent*, jamais les coups portés : un joueur qui
garde le clic enfoncé en traversant frappe deux à trois fois plus qu'il ne
touche, et compter les coups mesurerait sa discipline de gâchette plutôt que la
solidité des monstres.

### Combien en même temps

La mesure la plus importante, et celle qui manquait le plus longtemps. Tout le
modèle repose sur « la difficulté vient du nombre simultané, pas des
statistiques » — et on ne mesurait justement pas la simultanéité.

Chaque tick, on compte les monstres à portée d'engagement (6 tuiles) du joueur
le plus exposé, et on en garde la distribution. Le rapport en sort l'effectif
médian, le p90, le pic, et **la part du temps de combat passée en tête-à-tête**.

Un étage de quarante monstres pris un par un est un étage facile. Sans cette
mesure on croit régler la difficulté en ajoutant des monstres, alors qu'ils
arrivent à la queue leu leu et se font cueillir isolément.

Deux compteurs vont avec, parce qu'ils décrivent des stratégies qui vident le
jeu de son enjeu sans tricher :

- **L'économie des cœurs** — combien tombent, combien sont ramassés, et à quels
  PV. Laisser les cœurs au sol tant qu'on est en pleine vie transforme la barre
  de vie en stock rappelable au lieu d'une ressource qui s'épuise.
- **Le campement de l'entrée** — part du temps passée à moins de 5 tuiles de
  l'escalier d'arrivée. C'est la mesure qui a condamné la première version de la
  poursuite : il suffisait d'attendre les poursuivants à leur point de sortie
  pour les transformer en file d'attente de cibles isolées.

C'est calculé uniquement à partir des événements que l'engine émet déjà, plus un
échantillon des PV à chaque tick. `step()` reste pure : elle ne sait pas que la
télémétrie existe.

```bash
curl localhost:3000/stats/ABCD            # le relevé brut d'une partie
npx tsx scripts/report.ts ABCD            # le même, lisible
npx tsx scripts/report.ts data/runs/X.json
```

Le rapport répond aux questions qui font bouger un réglage : quel étage n'a
aucun enjeu, quelle espèce fait mal, laquelle ne sert à rien, quelle espèce vous
met à terre, quelle arme vous utilisez vraiment. Il désigne explicitement les
**ventres mous** — les étages traversés sans jamais descendre sous 70 % de PV.

### Les deux bots

```bash
npx tsx scripts/botrun.ts 10             # bourrin : nettoie tout
npx tsx scripts/botrun.ts 10 1234 rush   # pressé : la clé, et on file
```

Deux stratégies jouées sans réfléchir, qui encadrent le jeu par ses deux
extrêmes :

- **bourrin** — foncer sur le monstre le plus proche, bourriner, ne jamais
  reculer. L'étage finit toujours nettoyé, donc aucune dette.
- **pressé** — ignorer tout, aller chercher la clé, descendre. C'est la façon de
  jouer qu'on a mesurée en vrai, et donc celle qui teste si laisser des monstres
  en vie coûte quelque chose.

C'est le garde-fou d'équilibrage du projet — **si l'une des deux suffit, le jeu
ne demande aucune décision**, quels que soient les chiffres. Le rapport final dit
à quel étage la bêtise cesse de payer.

L'écart entre les deux est en soi une mesure : tant que « pressé » allait plus
loin que « bourrin », la stratégie optimale était de ne pas jouer au jeu.

Aucun réseau, aucun navigateur : uniquement l'engine, donc c'est reproductible
et ça tourne en quelques secondes. Le relevé est écrit au même format qu'une
vraie partie, `scripts/report.ts` l'avale tel quel.

C'est un **plancher, pas une prédiction** : le bot est seul et ne recule jamais.
L'étage où il meurt est celui en dessous duquel personne ne devrait pouvoir
descendre sans réfléchir — un vrai joueur, à quatre, ira bien plus loin.

C'est ce qui a permis de constater, par exemple, que les essaims infligeaient
littéralement **zéro dégât** sur une descente entière — ils mouraient tous en un
coup. Et de retrouver un vrai bug : 231 mises à terre sur un seul étage, parce
qu'un joueur déjà à terre était re-mis à terre par chaque coup reçu, ce qui
remettait à zéro son compte à rebours de saignement.

## Butin et progression

Cinq armes, qui changent la façon de jouer plutôt qu'un chiffre : la **dague**
frappe vite et court sans presque t'immobiliser, la **hache** ouvre un arc de
170° mais te cloue sur place, la **lance** tient à 2.4 tuiles dans un cône
étroit, l'**arc** tire un projectile. On les trouve dans les coffres et sur les
boss ; on en change en marchant dessus, et l'ancienne reste au sol pour un
coéquipier.

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

Ça ne suffisait pas : la clé donne un objectif, elle n'oblige pas à combattre.
C'est la poursuite qui s'en charge — tout ce qu'on laisse en vie descend derrière
nous. Descendre reste toujours possible, mais plus jamais gratuit.

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
  room.ts          Boucle de tick, diffusion, persistance
  telemetry.ts     Relevé d'équilibrage, dérivé des seuls événements
  persist.ts       Sauvegarde atomique des parties et des relevés
apps/client/       Vite + PixiJS. Rendu, entrées, prédiction, interpolation.
scripts/           dev, tests, bot d'équilibrage, rapports et debug
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
recul, `swing` et `movePenalty`), la table `MONSTERS` (comportement, vitesse,
portée, temps de préparation, `weight` face au recul), la courbe `xpForLevel`,
et les constantes de mise à terre (`BLEED_OUT_TICKS`, `REVIVE_TICKS`,
`REVIVE_RANGE`).

Les quatre boutons qui pèsent le plus sur la difficulté :

| Constante | Ce qu'elle change |
|---|---|
| `TARGET_TTK` / `TARGET_K` | les cibles de conception. Tout le reste en découle |
| `ATK_GROWTH` / `LEVELS_PER_FLOOR` | la pente de progression. `FLOOR_HP_GROWTH` s'en déduit |
| `WEAPON_DPS` | la puissance commune à toutes les armes |
| `KB_STACK_FALLOFF` | à quel point on peut verrouiller un monstre au recul. **Le réglage le plus sensible du jeu** |
| `PACK_MIN` / `PACK_MAX` / `CORRIDOR_SPAWN_SHARE` | combien on en affronte à la fois, et où |
| `PURSUE_MAX` / `PURSUE_INTERVAL` | ce que coûte le fait d'esquiver un étage |
| `movePenalty` d'une arme | ce qu'un coup coûte en mobilité — l'identité de l'arme |

Après toute modification :

```bash
npx tsx scripts/curve.ts 20            # les invariants tiennent-ils encore ?
npx tsx scripts/botrun.ts 10           # le bourrinage ne doit pas suffire
npx tsx scripts/botrun.ts 10 4242 rush # esquiver l'étage ne doit pas payer
```

`curve.ts` répond en une seconde et sans jouer : c'est lui qu'on lance en
premier. Les bots ne servent qu'à vérifier que le modèle survit au contact.

Les événements réseau portent eux-mêmes la portée et l'ouverture d'un coup
(`{t:'swing', reach, halfArc}`) : le client dessine l'arc sans avoir à savoir
quelle arme a frappé, donc ajouter une arme ne demande aucune modification côté
rendu.

## Tests

```bash
npm test                         # les deux harnais ci-dessous, à la suite
npx tsx scripts/engine-test.ts   # règles pures, aucune dépendance externe
npx tsx scripts/server-test.ts   # frontières du serveur : réseau, disque, sockets, télémétrie
npx tsx scripts/curve.ts 20      # invariants du modèle de puissance
npx tsx scripts/smoke.ts         # bout en bout, serveur lancé requis
npx tsx scripts/botrun.ts 10     # équilibrage : le bourrinage suffit-il ?
npx tsx scripts/botrun.ts 10 1 rush   # équilibrage : esquiver l'étage paie-t-il ?
npx tsx scripts/report.ts ABCD   # rapport détaillé d'une partie
npx tsx scripts/observe.ts ABCD  # affiche l'état d'une room en direct
npx tsx scripts/mapdump.ts data/rooms/ABCD.json   # carte ASCII d'une sauvegarde
npm run typecheck
```

`engine-test` couvre notamment les cas qui rendaient le jeu pénible, chacun
ajouté après l'avoir vu en vrai : un ennemi en diagonale est touché, viser
approximativement suffit au contact, on glisse le long des murs sans les
traverser, la diagonale ne donne pas de bonus de vitesse, un coup télégraphié se
rate si la cible se décale, **une meute ne pousse pas le héros à travers un
mur**, rester sur l'arme qu'on vient de poser ne la reprend pas en boucle, un
enchaînement de coups cesse de projeter, frapper à la hache coûte réellement de
la vitesse, **un joueur à terre finit par saigner** même sous les coups, et la
Directrice livre ses vagues groupées, hors du champ de vision, jamais pendant
son repos et jamais sur une équipe entièrement à terre.

`mapdump` sert exactement à ça : quand une position n'a pas de sens, la carte
ASCII dit en une seconde ce qu'un dump JSON cache.

En jeu, `window.__dc` expose les compteurs de frames, paquets, swings, effets
actifs, monstres/objets/projectiles reçus, la position prédite, la position qui
fait autorité et l'écart entre les deux — pratique pour distinguer « le réseau
ne répond plus » de « le rendu est figé » de « je suis coincé contre un mur ».
Un `drift` qui grimpe pendant qu'on frappe voudrait dire que le client
n'applique pas la même pénalité de déplacement que le serveur ; en pratique il
culmine à 0.3 tuile et retombe à zéro.

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
10 secondes et à l'arrêt du serveur (écriture atomique), et son relevé
d'équilibrage à côté dans `$DATA_DIR/runs/<CODE>.json`. Une room sans joueur
connecté ne tourne pas : le donjon est figé jusqu'au retour de quelqu'un.

Se reconnecter avec le même pseudo reprend le même personnage à sa position,
avec son arme et son niveau.

Le format porte un numéro de version (`SAVE_VERSION`, actuellement **8**). Une
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
- Pas encore : classes, progression entre les parties

## Pistes

1. Une esquive / roulade avec brèves i-frames (le recul, les télégraphes et le
   dash des monstres sont déjà là, il ne manque que la version joueur)
2. **Armures**, sur l'axe protection contre vitesse. Les formules sont déjà
   écrites pour les accueillir (`mitigation`, `effectiveHp`, `Actor.armor`).
3. Classes de héros, modificateurs d'arme sur les boss (feu, poison, vol de vie)

Livrées depuis : la Directrice pilotée par l'intensité (§ La Directrice), les
salles neutres (salle de repos et son étal, gagnées à l'usure), le son
(bande générative maison).
