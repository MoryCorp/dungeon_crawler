# Le laboratoire de bots

Campagne de mesure menée les 8-9 août 2026 : la difficulté actuelle est-elle
humainement jouable, et la roadmap 2→4 (ossements, salles typées, salle
piégée, signal lent, salle de repos, fioles) a-t-elle déplacé les courbes ?

Étalon de verdict fixé en amont : **un bon joueur solo atteint l'étage 10 en
médiane**, un joueur moyen meurt vers 5-7.

## Méthode

- **`scripts/lab/`** : un cerveau paramétré (le « génome » : arme, objectif,
  distance de kite, esquive, seuils de fuite/cœur, patience…), un runner
  déterministe qui joue des parties complètes via `step()` hors engine, un
  orchestrateur multi-processus, un analyseur.
- **Profils** : 5 armes × 4 styles (bourrin, prudent, pressé, kite) ×
  {optimal, humanisé} en solo, plus duo et quatuor prudents. L'humanisation :
  ~250 ms de latence d'inputs, bruit gaussien sur la visée, re-décision toutes
  les ~150 ms.
- **Volume** : 44 profils × 16 graines (704 runs) avant et après la roadmap,
  confirmation sur 32 graines (1 408 runs), plus une évolution (1+5)-ES,
  12 générations × 6 graines, par arme, avant et après.
- **Fin de run** : budget de morts épuisé (6 par joueur), plafond 30 étages,
  ou coincement (90 s sans kill/descente/mort — voir les réserves).
- Les JSONL bruts sont dans `data/lab/` (committés).

## Verdict contre l'étalon

**La difficulté actuelle est un mur, pas une pente — avant comme après.**

| | avant | après |
|---|---|---|
| Médiane solo humanisé (meilleur style) | 4 | 4 |
| Médiane solo, toutes armes confondues | 3 | 3 |
| Duo prudent | 4-5 | 4 |
| Quatuor prudent | 7 | 5-6 (voir réserves) |
| Runs solo atteignant l'étage 10 | 0 % | 0 % |

La confirmation sur 32 graines donne les mêmes ordres : meilleur solo humanisé
médiane 4, quatuor optimal médiane 6 (13 % des runs à l'étage 10, seul profil
à y arriver), quatuor humanisé 5.

Même les champions issus de l'évolution (le plafond de ce que le cerveau sait
faire, style optimisé arme par arme) plafonnent loin de l'étalon :

| arme | plafond évolué avant | après |
|---|---|---|
| arc | 4,50 | 4,00 |
| épée | 4,17 | 3,50 |
| hache | 3,67 | 4,33 |
| lance | 3,67 | 3,67 |
| dague | 2,33 | 2,83 |

Moyenne identique (3,67) : les écarts par arme sont dans le bruit (médiane sur
6 graines). Tous les champions convergent vers **le même style** : objectif
« clear », kite ~1-1,5, esquive 0,7-0,9, sprint partout — le jeu ne récompense
qu'une seule façon de jouer.

## Qui tue

Le **skeleton_mage** cause 45 à 98 % des mises à terre selon le profil
(médiane ~70 %), devant skeleton_rogue et, en coop, orc_mage/orc_warrior.
C'était vrai avant, c'est encore vrai après. La dague est la pire arme du
jeu : médiane 2 sur tous les styles, plafond évolué 2,83 quand les autres
armes font 3,5-4,3.

La coop aide par le relevage : en quatuor, 70-73 % des mises à terre sont
relevées (35 % en duo), d'où l'écart quatuor/solo.

## Effet de la roadmap 2→4

Comparaison profil par profil, mêmes 16 graines : **6 profils gagnent un
étage, 32 inchangés, 6 en perdent, Δ moyen −0,02**. Les bots sont à plat — et
c'est le résultat attendu : la roadmap n'a pas touché TTK/K (règle intangible),
elle a ajouté de la *marge exploitable* (économie, fioles, repos, plafond de
soin rachetable).

Cette marge est réelle mais **les bots ne savent pas s'en servir** — et un
humain si : sur le build final, une partie humaine réelle (TEST11) a doublé
son étage habituel (8 au lieu de ~4), en achetant 8 coffres, en dépensant
208 ossements sur 258 gagnés, en prenant une salle piégée (gagnée), avec une
usure réelle (entrées d'étage à 77 % des PV en fin de descente). L'écart
bot/humain sur le build final est la mesure de cette marge.

Mesures de santé des chantiers, relevées sur les runs :
- Économie : ~26 ossements gagnés par étage, prix du coffre `8+4·étage`
  soutenable (les runs meurent avec un solde faible, pas une fortune inutile).
- Géométrie : ~95 % des groupes de vagues placés, 4-15 % dégradés,
  100 % des vagues arrivent entières au premier contact.
- Signal lent : 0 % sur une équipe fraîche, >50 % sur une équipe usée,
  patience de la Directrice étirée de 180 à 288 ticks au max mesuré.

## Réserves de lecture

1. **Les chiffres quatuor sont bornés par le coincement, pas par la mort.**
   Avant : 28 runs sur 32 finissent coincés (90 s sans événement). Après :
   32 sur 32, dont 17 aux étages 4-5. Cause identifiée et reproduite : dans
   une salle piégée, une vague de 7 skeleton_mages **statiques** met les bots
   dans une boucle infinie à terre → relevé → à terre ; les branches
   « relever » et « esquiver » du cerveau passent avant « attaquer », personne
   ne traverse jamais les 5 cases pour tuer des mages à 12 PV. Une équipe
   humaine règle ça en dix secondes. La « régression » quatuor 7→5 est donc
   un artefact de mesure, pas une régression de difficulté.
2. Les bots humanisés ne modélisent pas un *bon* humain : pas d'utilisation
   des fioles en anticipation, pas d'arbitrage économique fin, pas de lecture
   des recettes de la Directrice. Ils donnent un plancher, TEST11 donne un
   point humain réel.
3. L'évolution optimise par arme en solo ; le plafond coop évolué n'a pas été
   mesuré (coût).

## La seconde campagne (9 août) — la cause du mur

Une relecture extérieure du moteur a proposé un modèle : *le hasard suit les
archétypes qui ignorent la vitesse de marche*. Aucune espèce de mêlée ou
d'essaim ne peut rattraper un joueur qui marche (vitesses 1,7-3,6 contre
4,2) ; les trois seules menaces fonctionnelles du jeu sont le projectile
(mages), le dash (rôdeurs) et le boss-chargeur — et le joueur n'a qu'un seul
verbe défensif, « s'écarter », qui marche à 100 % contre la première famille
et à 0 % contre la seconde. La campagne a testé ce modèle contre son rival
(« le mur est économique ») en éprouvette sur mule, rien de committé.

Instrument : le **hasard conditionnel** `h(N)` = morts à l'étage N / runs
entrés dans N (variante « risques concurrents » : runs coincés à N exclus du
dénominateur), lu avec `n(N)` en face de chaque ligne. La médiane est aveugle
ici : la distribution est une falaise, pas une pente.

Ce qui a été mesuré, chaque cellule = 704 runs sur 16 graines communes :

| expérience | résultat |
|---|---|
| nerf mage −20 % (dégâts ou cadence) | part du mage 64 → 55 %, médiane inchangée — symptôme, pas cause |
| distance de livraison 7 → 5 | quasi nul : l'occultation (FOV 9) est la contrainte active, distance réalisée ~10 tuiles |
| rattrapage mêlée/essaim 0,9× joueur | +28 % de hasard à l'étage 2, falaise intacte |
| marge économique (4-5 étages de butin en plus) | hasard au contact inchangé — la marge n'achète rien |
| **mage+rôdeur repoussés à l'étage 6** | **la falaise de l'étage 3 disparaît (3,24 → 0,47) et se rallume sur le premier archétype fonctionnel rencontré** |

L'expérience naturelle qui tranche : sous ce dernier test, le pic de hasard
n'est pas réapparu à 6 mais à **5** — l'étage du boss (`BOSS_EVERY = 5`), un
orc_warrior, donc un chargeur, attribution vérifiée à 68 %. Personne n'avait
mis le boss dans le protocole : le modèle a prédit juste sur un cas hors
expérience. Le mur du jeu **est** la ligne `monsterPool()` où les archétypes
fonctionnels s'allument, et la difficulté réelle n'est ni statistique ni
économique : c'est l'inventaire des verbes du joueur.

Conséquences actées :
- **Appliqué** (correctif de cohérence, mesuré avant/après) : dague `reach`
  1,00 → 1,25 — seule arme à portée inférieure au trash de mêlée ; downs par
  squelette 26 → 12 %, par orc 28 → 19 %, +1 étage sur la moitié des profils.
- **Le chantier** : une esquive/roulade à brèves i-frames — le verbe qui
  répond aux trois archétypes fonctionnels. Contrainte de conception posée
  d'avance : jamais seule, sinon elle devient le nouveau « kite partout ».
  Son contrepoids est l'encerclement, donc le rattrapage de mêlée (V1+V2)
  est son prérequis d'équilibre, pas une variante concurrente.
- **`monsterPool()` est un objet de conception**, pas une liste de cinq
  `if` : l'introduction de chaque archétype fonctionnel doit être un choix
  délibéré, boss compté dans l'échelle (son orthogonalité actuelle est
  précisément ce qui a produit l'expérience naturelle).
- Sous la forme « pente » (rattrapage + falaise repoussée), les plafonds
  évolués montent tous d'un étage (3,67 → 4,67 en moyenne) et viennent buter
  exactement sur la falaise du boss ; les styles champions divergent enfin
  par arme (la hache cesse de sprinter, l'arc raccourcit son kite).

Corrections d'instrument de la journée, committées : la distance de livraison
réalisée dans l'événement `horde` ; un seul secouriste par coéquipier à terre
et esquives plafonnées en rafale (cerveau) ; l'étal ne pose plus d'article
dans un mur (bug du jeu trouvé par les bots) ; un boss-fight n'est pas du
piétinement (coup porté/reçu = activité). Avant ces correctifs, 60-80 % des
runs finissaient coincés : la campagne 1 mesurait surtout la solidité du
cerveau — ses conclusions fines sont caduques, ses ordres de grandeur tiennent.

## Recommandations restantes — chiffrées, non appliquées

1. **Composition des vagues de piège** : plafonner la part d'espèces à
   distance à 50 % de la vague (aujourd'hui 7 mages sur 7 possibles dès
   l'étage 4 dans une salle de 8×6 fermée). Toujours valable.
2. **Rattrapage des vagues de mêlée/essaim** : 0,9× la vitesse du joueur
   depuis la livraison jusqu'au premier engagement de l'escouade, jamais pour
   archers et chargeurs. Mesuré : +28 % de hasard à l'étage 2, tueurs de
   mêlée enfin présents au tableau. À appliquer comme socle de la roulade.
3. **Échelle d'archétypes** : étaler l'allumage (ex. rôdeur à 3, mage à 5,
   boss compté dans l'échelle) pour que chaque menace s'apprenne avant la
   suivante. Les valeurs exactes sont à concevoir, pas à optimiser.
4. Le nerf du skeleton_mage (reco 1 d'origine) est **retiré** : testé à
   −20 %, il redistribue les downs sans déplacer le mur.

## Refaire les mesures

```bash
npx tsx scripts/lab/swarm.ts baseline 16      # matrice 44 profils × 16 graines
npx tsx scripts/lab/analyze.ts data/lab/baseline-16.jsonl
npx tsx scripts/lab/evolve.ts apres 12 6      # évolution 12 générations × 6 graines
npx tsx scripts/lab/compare.ts data/lab/baseline-16.jsonl data/lab/apres-16.jsonl
```
