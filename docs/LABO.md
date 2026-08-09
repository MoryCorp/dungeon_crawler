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

## Recommandations d'équilibrage — chiffrées, non appliquées

1. **skeleton_mage** : ramener sa part de mises à terre sous 40 % (aujourd'hui
   ~70 % en médiane). Leviers au choix : dégâts de projectile 6 → 5 (−17 %),
   ou +20 % d'intervalle entre salves, ou portée effective −1 case. Un seul
   levier à la fois, re-mesurer.
2. **Composition des vagues de piège** : plafonner la part d'espèces à
   distance à 50 % de la vague (aujourd'hui 7 mages sur 7 possibles dès
   l'étage 4 dans une salle de 8×6 fermée). C'est le seul endroit du jeu où
   une vague 100 % distance apparaît dans un espace clos sans repli.
3. **Dague** : +1 dégât ou +15 % de cadence, objectif médiane 3 (parité avec
   les autres armes, identité « rapide mais courte » conservée).
4. **Le mur étages 3-5** : si l'étalon étage 10 tient, le levier honnête est
   la pente de difficulté entre les étages 3 et 6 (c'est là que meurent 80 %
   des runs solo), pas les étages profonds. À instruire séparément — aucun
   chiffre de TTK/K n'est proposé ici, règle intangible.

## Refaire les mesures

```bash
npx tsx scripts/lab/swarm.ts baseline 16      # matrice 44 profils × 16 graines
npx tsx scripts/lab/analyze.ts data/lab/baseline-16.jsonl
npx tsx scripts/lab/evolve.ts apres 12 6      # évolution 12 générations × 6 graines
npx tsx scripts/lab/compare.ts data/lab/baseline-16.jsonl data/lab/apres-16.jsonl
```
