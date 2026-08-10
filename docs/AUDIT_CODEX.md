# Audit complet de `dungeon_crawler`

## 1. Résumé exécutif

Le socle est remarquablement cohérent pour un side project : moteur pur, gameplay mesurable, séparation comportement/statistiques et télémétrie riche.  
`typecheck`, les 236 tests engine et `curve.ts` passent ; aucun fichier n’a été modifié.  
La v1.0 ne devrait toutefois pas être figée telle quelle : `curve.ts` annonce un K constant tout en ignorant l’accélération réelle des attaques en profondeur.  
La télémétrie fusionne les runs successifs et les scènes SAS/boss portant le même étage, ce qui fragilise la doctrine « tout se prouve au relevé ».  
Le Gardien peut changer de pattern après son télégraphe, lequel est de toute façon mal dessiné côté client.  
La Directrice est globalement réussie, mais son intensité et la récompense du bandit ne sont pas réellement par joueur en coop.  
La dette de poursuite est une excellente mécanique, avec un bug de sélection des poursuivants et une information HUD incomplète.  
Le moteur tient confortablement la charge actuelle ; les principaux risques sont la robustesse réseau, les transitions d’état et quelques ressources Pixi.  
La meilleure extension inspirée de PDM est une petite ceinture tactique d’objets, pas un inventaire complet ni la faim.  
Priorité absolue : réparer les instruments et relancer les relevés avant toute décision touchant TTK/K.

## 2. Phase 1 — Constats gameplay

### 1. Le modèle de puissance est bon dans son principe, mais sa preuve actuelle est fausse pour K

Le budget multiplicatif, le DPS nominal commun aux armes et la croissance dérivée des PV ennemis forment une base saine : les choix d’armes portent sur la portée, l’arc, le recul et l’engagement, pas sur une course aux gros nombres ([types.ts:125](/home/amaury/dev/dungeon_crawler/packages/engine/src/types.ts:125), [types.ts:182](/home/amaury/dev/dungeon_crawler/packages/engine/src/types.ts:182), [types.ts:553](/home/amaury/dev/dungeon_crawler/packages/engine/src/types.ts:553)).

En revanche, les monstres raccourcissent réellement leur récupération avec l’étage ([types.ts:557](/home/amaury/dev/dungeon_crawler/packages/engine/src/types.ts:557), [game.ts:1786](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1786)), alors que `curve.ts` utilise le même cycle `windup + cooldown` partout ([curve.ts:55](/home/amaury/dev/dungeon_crawler/scripts/curve.ts:55), [curve.ts:82](/home/amaury/dev/dungeon_crawler/scripts/curve.ts:82)). En reproduisant la formule exacte du moteur pour trois orcs, K passe approximativement de **3,26 à l’étage 1 à 2,40 à l’étage 20**, et non à 3,28 comme annoncé. C’est une baisse de 26 %, structurellement contraire à l’invariant affiché.

Je ne recommande aucun nouveau chiffre : il faut d’abord faire calculer à `curve.ts` le cycle réellement utilisé, verrouiller cela par test, puis confronter la dérive au relevé.

### 2. La Directrice produit une bonne onde de tension

La séparation entre mémoire d’intensité et présence instantanée est juste. Les sorties temporelles empêchent les phases `fade` et `rest` de se bloquer, et le repos reste garanti ([director.ts:86](/home/amaury/dev/dungeon_crawler/packages/engine/src/director.ts:86), [director.ts:122](/home/amaury/dev/dungeon_crawler/packages/engine/src/director.ts:122)). La réserve constante respecte aussi l’idée que la profondeur doit renforcer les ennemis sans gonfler mécaniquement les vagues ([types.ts:722](/home/amaury/dev/dungeon_crawler/packages/engine/src/types.ts:722)).

La livraison hors FOV, en groupes homogènes et en escouades résout proprement le problème historique de la file indienne ([game.ts:1193](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1193), [game.ts:1243](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1243)).

Deux écarts importants subsistent :

- Il n’existe qu’une intensité globale. Le moteur prend le plus gros dégât relatif et le maximum d’ennemis engagés parmi tous les joueurs ([game.ts:953](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:953), [game.ts:963](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:963)). Ce n’est donc pas une intensité perçue par joueur, mais une enveloppe d’équipe.

- La cible est systématiquement le joueur au meilleur ratio de PV ([game.ts:1139](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1139)). Si ce joueur campe dans une salle de repos, `deliverHorde()` abandonne la vague, même si ses coéquipiers explorent ailleurs ([game.ts:1146](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1146)). Un joueur frais peut donc neutraliser la Directrice pour toute l’équipe. Il faut exclure les joueurs en repos de la sélection et viser le meilleur joueur **éligible hors repos**.

### 3. Le bandit est bien borné, mais sa récompense n’est pas contextuelle en coop

UCB, 20 % d’exploration et warm-start décoté sont des choix adaptés au faible volume de parties ([bandit.ts:53](/home/amaury/dev/dungeon_crawler/packages/engine/src/bandit.ts:53), [bandit.ts:76](/home/amaury/dev/dungeon_crawler/packages/engine/src/bandit.ts:76)). Le bandit ne touche qu’à la composition et à la géométrie : bon garde-fou pour TTK/K.

Mais le carnet `joueur:arme` reçoit :

- le pic d’intensité global ;
- les dégâts maximaux encaissés par n’importe quel joueur ;
- les effets de tous les monstres présents pendant huit secondes, pas seulement ceux de la vague évaluée ([game.ts:899](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:899), [game.ts:953](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:953), [game.ts:989](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:989)).

Une vague visant Alice peut donc être récompensée parce qu’un monstre posé a frappé Bob. Il faut conserver `targetId` et les identifiants d’escouades dans `banditPending`, puis mesurer les dégâts produits par ces escouades sur cette cible — éventuellement complétés par une métrique d’engagement.

Le piège appelle par ailleurs `pickRecipe()` sans warm-start, sans filtre de salle et sans ouvrir de fenêtre de récompense ([game.ts:1331](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1331)). Le bandit n’apprend donc rien de ses vagues piégées.

### 4. Quatre profils de style sur cinq sont uniquement de la télémétrie

Portée, mobilité, encombrement, cohésion et patience sont correctement accumulés et normalisés ([profile.ts:54](/home/amaury/dev/dungeon_crawler/packages/engine/src/profile.ts:54), [game.ts:820](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:820), [game.ts:861](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:861)).

Leur usage réel est cependant très limité :

- seule l’EMA de déplacement `moveX/moveY` pilote la recette `mur` ([game.ts:1103](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1103)) ;
- `fleeX/fleeY` n’est jamais lu ;
- portée, mobilité, encombrement, cohésion et patience ne servent qu’au rapport serveur ([telemetry.ts:513](/home/amaury/dev/dungeon_crawler/apps/server/src/telemetry.ts:513)).

Ce n’est pas du mauvais code : c’est une instrumentation préparatoire. Mais présenter l’ensemble comme matière active de la Directrice serait trompeur. Avant d’ajouter de l’adaptation, je rendrais d’abord ces profils visibles dans le rapport joueur et je prouverais qu’ils sont stables et discriminants.

### 5. La dette de poursuite est l’un des meilleurs systèmes, mais son choix est actuellement faux

La mécanique transforme élégamment le rush en dette future sans toucher aux statistiques. La livraison différée par la Directrice évite l’ancien exploit du campement à l’escalier ([recipes.ts:158](/home/amaury/dev/dungeon_crawler/packages/engine/src/recipes.ts:158), [game.ts:1172](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1172)).

Bug concret : `descend()` installe d’abord la nouvelle carte et son nouvel escalier ([game.ts:697](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:697), [game.ts:704](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:704)), puis trie les survivants de l’ancienne carte selon leur distance à `state.stairs` ([game.ts:747](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:747)). Les poursuivants ne sont donc pas ceux qui collaient l’ancien escalier, contrairement au commentaire et au design.

L’information joueur est aussi incomplète : `chasing` expose uniquement la dette héritée déjà stockée ([protocol.ts:155](/home/amaury/dev/dungeon_crawler/packages/engine/src/protocol.ts:155), [room.ts:211](/home/amaury/dev/dungeon_crawler/apps/server/src/room.ts:211)). Il n’affiche pas le coût prévisionnel de descendre maintenant. Pour qu’il s’agisse réellement d’un choix, le HUD devrait distinguer « dette actuelle » et « X survivants suivraient si vous descendez ».

Enfin, tout est pardonné avant le SAS et à la sortie du boss ([game.ts:750](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:750)). C’est cohérent avec un acte fermé, mais cela crée un étage de rush gratuit juste avant chaque sanctuaire ; ce comportement doit être explicitement mesuré.

### 6. Plafond de soin, relève et usure forment une excellente boucle longue

Le plafond transforme les PV en ressource de descente sans augmenter le coût instantané d’un monstre ([types.ts:361](/home/amaury/dev/dungeon_crawler/packages/engine/src/types.ts:361), [types.ts:367](/home/amaury/dev/dungeon_crawler/packages/engine/src/types.ts:367)). L’ordre relève > respawn > transport à l’escalier corrige une vraie contradiction coopérative ([types.ts:402](/home/amaury/dev/dungeon_crawler/packages/engine/src/types.ts:402), [game.ts:1492](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1492)). Le plafond rachetable constitue aussi un puits économique durable.

Le signal lent est toutefois calculé à partir du joueur **le mieux portant** ([game.ts:921](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:921)). En coop, un joueur à 100 % peut masquer l’érosion de trois coéquipiers. Combiné au ciblage du plus sain, cela donne trop de pouvoir structurel au « porteur de tempo ». Je mesurerais au minimum meilleur/médiane/pire ratio séparément avant de choisir l’agrégat.

La salle méritée est bonne, mais elle ne doit pas devenir une immunité globale : le problème vient de la sélection de cible de la Directrice, pas du principe de sanctuaire.

### 7. L’économie respecte la doctrine, mais ses récompenses s’épuisent vite

Les ossements communs évitent la compétition intra-équipe, et aucun achat n’augmente directement les dégâts ([types.ts:275](/home/amaury/dev/dungeon_crawler/packages/engine/src/types.ts:275)). Prix de coffre, soin, fioles et plafond créent plusieurs horizons de dépense.

La faiblesse vient du coffre : il donne toujours une arme tirée dans le même pool plat et un cœur ([game.ts:2076](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:2076)). Dès que l’équipe possède ses armes préférées, le coffre devient essentiellement un cœur cher. C’est le meilleur point d’insertion pour les objets tactiques PDM.

Autre risque coop : coffre et articles payants sont achetés automatiquement par le joueur le plus proche dès qu’il les touche ([game.ts:1952](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1952), [game.ts:2001](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:2001)). N’importe qui peut dépenser la bourse commune accidentellement ou unilatéralement. Le même maintien contextuel que pour le ramassage d’arme suffirait, sans menu.

### 8. L’architecture des actes est prometteuse, mais le premier acte ne livre pas son échelle complète

Les clones de garnison sont stricts pour le soldat, l’archer royal, le chevalier et le prêtre ([types.ts:857](/home/amaury/dev/dungeon_crawler/packages/engine/src/types.ts:857)). Le gardien-vétéran est choisi parmi les rangs déjà rencontrés, ce qui évite une élite d’un pattern inconnu ([game.ts:466](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:466)).

Mais les étages ordinaires du Château sont 1 à 4 ; l’étage 5 est remplacé par SAS puis arène ([game.ts:679](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:679)). Avec l’échelle retardée, le prêtre n’entre dans le pool qu’à l’étage théorique 5 ([game.ts:317](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:317), [game.ts:341](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:341)) : il n’apparaît donc jamais dans une partie normale. Le test « garnison complète étage 5 » appelle directement `createGame(..., 5)`, une scène qui n’existe pas dans le flux réel ([engine-test.ts:2432](/home/amaury/dev/dungeon_crawler/scripts/engine-test.ts:2432), [engine-test.ts:2444](/home/amaury/dev/dungeon_crawler/scripts/engine-test.ts:2444)).

Après le Château, `BIOMES` retombe immédiatement sur le cachot historique ([types.ts:919](/home/amaury/dev/dungeon_crawler/packages/engine/src/types.ts:919), [types.ts:939](/home/amaury/dev/dungeon_crawler/packages/engine/src/types.ts:939)). La structure d’actes existe donc, mais un seul acte est réellement thématisé.

### 9. Le palier de boss est une bonne rupture de rythme, mais le contrat de télégraphe est cassé

Le SAS marchand sans menace, l’arène dédiée, les piliers et les appels de garde sont une excellente récompense de fin d’acte ([mapgen.ts:268](/home/amaury/dev/dungeon_crawler/packages/engine/src/mapgen.ts:268), [mapgen.ts:314](/home/amaury/dev/dungeon_crawler/packages/engine/src/mapgen.ts:314), [game.ts:1794](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1794)).

Le défaut critique : le colosse choisit de commencer une préparation selon la distance initiale ([ai.ts:203](/home/amaury/dev/dungeon_crawler/packages/engine/src/ai.ts:203)), mais décide charge ou martèlement à nouveau selon la distance **au moment de l’exécution** ([game.ts:1845](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1845)). Un joueur qui s’éloigne d’un martèlement préparé peut donc le transformer en charge ; celui qui ferme l’écart sur une charge peut recevoir soudain le marteau et huit éclats. Il faut mémoriser `pendingAttack: 'charge' | 'slam'` au début du windup.

Côté client, tout windup du colosse est affiché comme un large arc de portée 6,5 ; seul `behavior === 'charger'` reçoit un couloir étroit ([render.ts:981](/home/amaury/dev/dungeon_crawler/apps/client/src/render.ts:981)). Le télégraphe est donc faux pour les deux patterns. Le protocole doit transporter le type et la géométrie exacte de l’attaque préparée.

Enfin, le Gardien ne clone pas strictement tous les timings du chevalier : vitesse, portée, windup, cooldown et ruée diffèrent ([types.ts:865](/home/amaury/dev/dungeon_crawler/packages/engine/src/types.ts:865), [types.ts:873](/home/amaury/dev/dungeon_crawler/packages/engine/src/types.ts:873)). Le test ne compare que PV, attaque et XP ([engine-test.ts:2466](/home/amaury/dev/dungeon_crawler/scripts/engine-test.ts:2466)). Cette exception doit être soit justifiée par un relevé boss spécifique, soit ramenée sous la doctrine des clones — sans modifier de chiffre avant mesure.

### 10. Le corps à corps dispose enfin de vrais verbes défensifs

Interruption conditionnée au poids, immunité temporaire, roulade brève, renvoi de projectile et dashbreak produisent des réponses distinctes sans simple nerf statistique ([game.ts:1616](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1616), [game.ts:1635](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1635), [game.ts:1722](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1722)). C’est exactement la réponse au diagnostic du laboratoire, qui identifiait l’absence de verbe contre projectiles et ruées ([LABO.md:111](/home/amaury/dev/dungeon_crawler/docs/LABO.md:111), [LABO.md:145](/home/amaury/dev/dungeon_crawler/docs/LABO.md:145)).

Deux risques doivent être instrumentés :

- la parade n’existe qu’au tick où `playerAttack()` est exécuté, pas pendant toute l’animation de swing ([game.ts:1681](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1681), [game.ts:1727](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1727)) ; le visuel peut laisser croire à une fenêtre plus longue ;

- une roulade annule immédiatement la récupération de l’arme ([game.ts:260](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:260), [game.ts:2221](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:2221)). Cela peut neutraliser le principal coût de la hache. La télémétrie compte les roulades, mais pas l’arme portée ni les récupérations annulées ([telemetry.ts:108](/home/amaury/dev/dungeon_crawler/apps/server/src/telemetry.ts:108)).

Aucun chiffre ne doit être changé avant d’ajouter `rollsByWeapon`, `rollCancelsSwing` et `parriesByWeapon`.

### 11. La salle piégée reproduit un problème déjà prouvé

Une recette `tireurs` consacre 100 % de sa vague aux archers ([recipes.ts:65](/home/amaury/dev/dungeon_crawler/packages/engine/src/recipes.ts:65)), et le piège utilise toutes les recettes sans plafond de distance ([game.ts:1331](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1331)). Le laboratoire a déjà observé des vagues de sept mages sur sept et recommande un plafond de 50 % de distance ([LABO.md:93](/home/amaury/dev/dungeon_crawler/docs/LABO.md:93), [LABO.md:171](/home/amaury/dev/dungeon_crawler/docs/LABO.md:171)). C’est une modification de composition, pas de TTK/K : elle est donc compatible avec la doctrine et déjà appuyée par une mesure.

### 12. Verdict gameplay global

Le système est pertinent : Directrice, dette, usure, économie et actes forment une vraie descente, pas une collection de combats isolés. Le risque principal n’est pas le manque d’idées mais la superposition d’instruments partiellement faux.

La dernière campagne documentée conclut encore à une falaise d’archétypes et à un style dominant unique ([LABO.md:43](/home/amaury/dev/dungeon_crawler/docs/LABO.md:43), [LABO.md:127](/home/amaury/dev/dungeon_crawler/docs/LABO.md:127)). La roulade et le dashbreak répondent au diagnostic, mais aucun relevé post-implémentation présent dans `docs/LABO.md` ne prouve encore qu’ils ont transformé cette falaise en pente. La conclusion honnête est donc : **design prometteur, équilibre non encore démontré sur le build actuel**.

## 3. Phase 2 — Propositions PDM priorisées

Prérequis transversal : réparer la télémétrie de la phase 3 avant toute expérimentation. Sans séparation fiable des runs/scènes et attribution correcte des dégâts, aucune fonctionnalité ne pourra être jugée selon la doctrine.

| Priorité | Fonctionnalité | Valeur joueur | Effort | Fichiers principaux | Compatibilité avec la doctrine |
|---|---|---|---:|---|---|
| 1 | **Ceinture tactique à deux emplacements** : une fiole + un objet lancé/graine/orbe | Ajoute des décisions courtes et partageables sans transformer le jeu en gestion d’inventaire. Les coffres restent désirables après acquisition des armes. Premier lot : caillou qui détourne l’aggro, orbe de révélation, graine qui crée un obstacle temporaire, orbe de rappel de butin. | M | `types.ts`, `game.ts`, `protocol.ts`, `input.ts`, `main.ts`, `render.ts`, `telemetry.ts` | Commencer sans dégâts directs. Stun, poison ou multiplicateur de dégâts modifieraient le TTK/K effectif et exigeraient un relevé dédié. |
| 2 | **Étal façon Kecleon avec vol choisi** | Donne une histoire à la monnaie et une boucle risque/récompense mémorable. Le joueur maintient « prendre sans payer » ; la valeur devient une dette spéciale livrée par la Directrice au prochain étage ordinaire. | M | `game.ts`, `types.ts`, `protocol.ts`, `render.ts`, `telemetry.ts` | Ne pas créer un marchand invincible ni augmenter les statistiques. La punition doit être compositionnelle, plafonnée et annoncée ; sinon elle court-circuite la dette et le repos. |
| 3 | **Étages spéciaux déterministes** : chambre au trésor, maison de monstres optionnelle, coffre maudit, raccourci risqué | Renouvelle l’exploration en réutilisant BSP, salles typées, pièges et recettes. Très bon ratio valeur/scope. | M | `mapgen.ts`, `game.ts`, `types.ts`, `protocol.ts`, `render.ts`, `telemetry.ts` | Les maisons de monstres changent la simultanéité réelle : conserver les mêmes espèces/statistiques, instrumenter engagement p50/p90 et downs avant activation générale. |
| 4 | **Missions et sauvetage par code** | C’est la composante PDM la plus forte socialement : un wipe produit une mission partageable, un ami rejoue la graine jusqu’au lieu du KO et rend la room récupérable. | L | `room.ts`, `persist.ts`, `index.ts`, nouveau module de mission, lobby `main.ts`, protocole | Compatible avec TTK/K, mais nécessite des sauvegardes robustes, un `runId`, une scène précise et une politique anti-duplication des récompenses. À faire après la v1 du stockage. |
| 5 | **Météo d’étage légère** : brume, vents visuels, pénombre, spores révélant périodiquement les ennemis | Identité immédiate d’un étage et variation lisible sans nouvelle espèce. Déterminée par graine + étage et envoyée une fois dans `floor`. | M | `types.ts`, `game.ts`, `protocol.ts`, `render.ts`, `audio.ts`, `telemetry.ts` | Éviter dégâts, vitesse et cadence. Modifier FOV ou lisibilité des projectiles peut tout de même déplacer les downs : journaliser la météo par étage. |
| 6 | **Escouade de mission, sans bonus de statistiques** : nom, emblème, objectifs de run et historique | Donne une identité persistante au groupe sans classes ni méta-puissance. Exemples : nettoyer 80 %, réussir un piège, gagner sans vol. | S/M | serveur persistant séparé, lobby, `telemetry.ts`, `report.ts` | Compatible tant que les récompenses restent cosmétiques ou débloquent des variantes équivalentes. Des passifs de combat violeraient la doctrine. |
| 7 | **Faim/ventre — à différer** | Signature PDM, mais faible valeur ici : le jeu possède déjà plafond de soin, usure, Directrice, prix croissants et dette pour empêcher le camping. Une jauge supplémentaire risque d’être seulement une taxe temporelle. | M | `types.ts`, `game.ts`, protocole/HUD, télémétrie | Incompatible sans preuve que la lenteur ou le camping restent une stratégie dominante. En temps réel coop, elle punirait aussi les pauses, discussions et déconnexions. |
| 8 | **Recrutement d’alliés — hors scope v1** | Attachement et composition d’équipe intéressants, mais redondants avec quatre vrais joueurs. | L/XL | acteurs/IA, sauvegardes, protocole, rendu, commandes, télémétrie | Ajoute DPS, corps, cibles et relève : change frontalement K et la simultanéité. Variante acceptable plus tard : compagnon non combattant qui porte un objet ou indique un secret. |

## 4. Phase 3 — Code review production

### Bloquants

#### B1. `curve.ts` certifie un K qu’il ne calcule pas réellement

La récupération est resserrée dans le moteur mais ignorée dans l’outil analytique ([game.ts:1786](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1786), [curve.ts:55](/home/amaury/dev/dungeon_crawler/scripts/curve.ts:55)). Le test vert donne donc une assurance erronée.

**Correction :** exporter une fonction pure `monsterCooldown(floor, def)` depuis l’engine, l’utiliser à la fois dans `game.ts` et `curve.ts`, puis ajouter un test exact étage 1/10/20. Mesurer ensuite la dérive avant toute décision de valeur.

#### B2. Les messages WebSocket ne sont pas validés à l’exécution

Le serveur caste directement le JSON en `ClientMsg` ([index.ts:147](/home/amaury/dev/dungeon_crawler/apps/server/src/index.ts:147)). Un `room` non textuel peut faire échouer `trim()`, et un input incomplet/non numérique peut propager `undefined` puis `NaN` dans les positions persistées ([index.ts:160](/home/amaury/dev/dungeon_crawler/apps/server/src/index.ts:160), [game.ts:2204](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:2204), [game.ts:2271](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:2271)).

**Correction :** parseur discriminé à la frontière, `Number.isFinite` sur `mx/my/aim`, clamp de `mx/my`, booléens normalisés, taille maximale du paquet, fermeture explicite après plusieurs violations.

#### B3. La télémétrie fusionne des runs et scènes différents

Le constructeur reprend le premier étage portant le même numéro avec `find()` ([telemetry.ts:365](/home/amaury/dev/dungeon_crawler/apps/server/src/telemetry.ts:365)). Cela fusionne :

- plusieurs runs recommençant à l’étage 1 ;
- le SAS de l’étage 5 et l’arène du même étage ;
- une reprise serveur dans la mauvaise entrée.

`restart()` repasse précisément l’ancien record au nouveau collecteur ([room.ts:125](/home/amaury/dev/dungeon_crawler/apps/server/src/room.ts:125)), tandis que chaque `descend` ajoute encore un `FloorRecord` identifié par le seul nombre ([telemetry.ts:640](/home/amaury/dev/dungeon_crawler/apps/server/src/telemetry.ts:640)).

**Correction :** clé `{runId, floor, scene, visit}`, append systématique au restart, reprise uniquement de la dernière visite correspondant à l’état sauvegardé. Persister aussi les accumulateurs `dangerTicks` nécessaires à une reprise fidèle.

#### B4. Le Gardien ne respecte pas son télégraphe

Le pattern n’est pas mémorisé au windup et le client ne sait pas lequel dessiner ([ai.ts:203](/home/amaury/dev/dungeon_crawler/packages/engine/src/ai.ts:203), [game.ts:1845](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1845), [render.ts:981](/home/amaury/dev/dungeon_crawler/apps/client/src/render.ts:981)).

**Correction :** champ `pendingAttack` sur `Actor`, choisi une fois ; `ActorView` doit exposer `{telegraphKind, reach, halfArc}`. Le rendu ne doit plus déduire la géométrie depuis l’espèce.

### Importants

#### I1. L’état du RNG est remis en arrière après une descente déclenchée par `step()`

`step()` crée son RNG local au début ([game.ts:2158](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:2158)). `descend()` crée un autre RNG, consomme la génération et écrit son état ([game.ts:650](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:650), [game.ts:803](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:803)). Puis la fin de `step()` écrase ce nouvel état par celui du RNG extérieur ([game.ts:2384](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:2384), [game.ts:2395](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:2395)).

Reproduction pendant l’audit : `state.rng` était strictement identique avant et après une descente live, malgré la génération du nouvel étage. Les tests appelant directement `descend()` n’exercent donc pas le même flux aléatoire que le jeu réel.

**Correction :** un seul RNG transmis à `descend()`, ou retour immédiat après descente sans réécriture finale. Ajouter un test de partie scriptée traversant réellement l’escalier.

#### I2. La sélection des poursuivants utilise l’escalier du nouvel étage

Voir Phase 1 : nouvel escalier assigné aux lignes 704-708, tri des anciens monstres aux lignes 752-760 de [game.ts](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:704).

**Correction :** capturer `oldStairs` et les survivants avant de remplacer carte, salles et coordonnées.

#### I3. Les joueurs déconnectés restent des acteurs actifs

`leave()` ne retire ni ne désactive le personnage ([room.ts:112](/home/amaury/dev/dungeon_crawler/apps/server/src/room.ts:112)). Tant qu’un coéquipier reste connecté, ce fantôme :

- attire les monstres et le champ de flux ;
- reçoit XP et télémétrie ;
- peut être mis à terre ;
- peut empêcher un wipe parce que `killOrDown()` le considère encore debout ([game.ts:1510](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1510)).

Le plafond de quatre porte uniquement sur les sockets, et `forget()` n’est appelé nulle part ([room.ts:84](/home/amaury/dev/dungeon_crawler/apps/server/src/room.ts:84), [room.ts:135](/home/amaury/dev/dungeon_crawler/apps/server/src/room.ts:135)). Des pseudos successifs peuvent donc accumuler des fantômes persistants.

**Correction :** séparer personnages persistés et acteurs actifs, ou porter un statut `connected` exclu de l’IA, du FOV, de l’XP, de l’usure et du calcul de wipe.

#### I4. La récompense du bandit peut être imputée au mauvais joueur et à la mauvaise vague

`banditPending` ne contient ni cible explicite ni membres de la vague ([types.ts:1248](/home/amaury/dev/dungeon_crawler/packages/engine/src/types.ts:1248)). Les dégâts sont agrégés globalement ([game.ts:953](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:953)) puis crédités au contexte choisi à la livraison ([game.ts:1267](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:1267)).

**Correction :** récompense causale par cible et escouade, avec attribution des `hit.from` aux membres livrés.

#### I5. Les sauvegardes v8 sont castées, pas validées, et les erreurs effacent silencieusement la continuité

Une sauvegarde portant le bon numéro est transformée directement en `GameState` sans validation de forme ([persist.ts:102](/home/amaury/dev/dungeon_crawler/apps/server/src/persist.ts:102)). Toute erreur — corruption, permission, JSON invalide — devient simplement `null` ([persist.ts:158](/home/amaury/dev/dungeon_crawler/apps/server/src/persist.ts:158)), donc une nouvelle partie qui pourra ensuite écraser l’ancienne.

**Correction :** validation structurelle minimale, distinction `absent / version incompatible / corrompu / erreur I/O`, journal explicite et quarantaine du fichier corrompu avant création d’une nouvelle room.

#### I6. Le redémarrage après wipe conserve des compteurs appartenant à l’ancien état

`restart()` recrée `state` à tick zéro mais ne réinitialise pas `lastSaveTick`, `visCountdown` ni la scratch visuelle ([room.ts:125](/home/amaury/dev/dungeon_crawler/apps/server/src/room.ts:125)). La sauvegarde périodique compare ensuite le petit tick neuf à l’ancien grand tick ([room.ts:218](/home/amaury/dev/dungeon_crawler/apps/server/src/room.ts:218)) : elle peut rester désactivée longtemps après un wipe. Le compteur de resets, non persisté, peut également répéter une graine après redémarrage serveur.

**Correction :** réinitialiser tous les compteurs de room, persister `runId/resets`, puis sauvegarder immédiatement le nouvel état.

#### I7. Le nettoyage Pixi d’un changement d’étage est incomplet

La texture de carte créée dynamiquement est remplacée via `mapSprite.destroy()` sans destruction symétrique explicite de sa texture, contrairement au brouillard ([render.ts:266](/home/amaury/dev/dungeon_crawler/apps/client/src/render.ts:266), [render.ts:274](/home/amaury/dev/dungeon_crawler/apps/client/src/render.ts:274)). Les repeints de grille peuvent donc accumuler des ressources GPU selon le cycle de GC de Pixi.

Plus concret : `fxLayer.removeChildren()` détache le prompt de ramassage et sa jauge, mais `takeTag/takeGauge` restent non nuls ([render.ts:289](/home/amaury/dev/dungeon_crawler/apps/client/src/render.ts:289), [render.ts:711](/home/amaury/dev/dungeon_crawler/apps/client/src/render.ts:711)). Ils ne sont ensuite jamais réajoutés : l’aide au ramassage peut disparaître après la première descente.

**Correction :** méthode `clearFloorResources()` unique : détruire texture/canvas de carte, tags de prix et prompts, vider leurs maps et remettre les références à `null`.

#### I8. L’échelle de garnison et son test valident une scène impossible

Le prêtre mort est détaillé en Phase 1. Le test construit un étage 5 ordinaire ([engine-test.ts:2432](/home/amaury/dev/dungeon_crawler/scripts/engine-test.ts:2432)), alors que le flux réel impose SAS puis boss ([game.ts:683](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:683)).

**Correction :** tester toute la séquence 1→SAS→boss→6 uniquement via `step()` et revoir l’échelle pour que chaque espèce annoncée dispose d’au moins un étage jouable.

#### I9. Le calcul d’XP de `curve.ts` ne représente pas le jeu réel

`floorXp()` utilise la moyenne de **toutes** les espèces, clones et boss compris, et suppose chaque étage peuplé par `placed + reserve` ([curve.ts:140](/home/amaury/dev/dungeon_crawler/scripts/curve.ts:140)). Il ignore pools par acte, élite, piège, SAS, boss et gardes. L’annonce « rythme réel 1,16 » n’est donc pas un rythme réel.

**Correction :** exporter un estimateur de contenu depuis l’engine ou, mieux, réserver `curve.ts` à TTK/K analytique et dériver la courbe d’XP des sorties botrun/télémétrie.

#### I10. Écritures de sauvegarde non sérialisées

Toutes les écritures d’une room partagent le même fichier temporaire `path.tmp` ([persist.ts:65](/home/amaury/dev/dungeon_crawler/apps/server/src/persist.ts:65)). Les sauvegardes périodiques sont lancées sans attente ([room.ts:218](/home/amaury/dev/dungeon_crawler/apps/server/src/room.ts:218)) et peuvent se chevaucher avec déconnexion ou shutdown.

**Correction :** une chaîne de promesses/mutex par room, coalesçant les demandes en une seule sauvegarde du dernier état.

#### I11. Aucun contrôle de backpressure WebSocket

`broadcast()` envoie à toute socket ouverte sans vérifier `bufferedAmount` ([room.ts:233](/home/amaury/dev/dungeon_crawler/apps/server/src/room.ts:233)). Un client lent peut accumuler les snapshots à 30 Hz.

**Correction :** seuil de backpressure, abandon des états intermédiaires et fermeture des clients durablement en retard. Conserver les événements critiques dans le prochain snapshot.

#### I12. Les tests de production s’arrêtent presque entièrement à l’engine

La commande globale ne fait que du typecheck ([package.json:13](/home/amaury/dev/dungeon_crawler/package.json:13)). `engine-test.ts` couvre très bien les règles pures, mais pas :

- sauvegarde/chargement v8 ;
- runs et scènes répétés en télémétrie ;
- invalidation réseau ;
- déconnexion/reconnexion ;
- backpressure ;
- nettoyage Pixi ;
- descente live avec état RNG.

**Correction :** ajouter une petite suite Node pour `Room`, `persist` et `RunTelemetry`, plus un test client ciblé de `Renderer.setFloor()` avec renderer mocké.

### Mineurs

#### M1. Les allocations par tick sont nombreuses, mais pas problématiques au scope actuel

`buildFlowField()` alloue sa file, le moteur répète `Object.values()`, et `separateActors()` est quadratique ([ai.ts:32](/home/amaury/dev/dungeon_crawler/packages/engine/src/ai.ts:32), [physics.ts:201](/home/amaury/dev/dungeon_crawler/packages/engine/src/physics.ts:201), [game.ts:2187](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:2187)). Malgré cela, une mesure locale de 3 000 ticks, quatre joueurs et 38 acteurs donne environ **0,73 ms/tick** hors télémétrie/protocole : aucune réécriture urgente.

Si la concurrence augmente, remplacer la file `number[]` par un `Int32Array` réutilisé et construire des listes players/monsters une fois par phase suffira probablement.

#### M2. Les snapshots réseau sont complets mais encore raisonnables

Chaque état réalloue actors/projectiles/items et part à 30 Hz ([protocol.ts:145](/home/amaury/dev/dungeon_crawler/packages/engine/src/protocol.ts:145), [room.ts:203](/home/amaury/dev/dungeon_crawler/apps/server/src/room.ts:203)). Mesure all-visible : environ 3,3 à 5,3 Ko par état, soit 0,4 à 0,65 Mo/s pour une room de quatre clients. Ce n’est pas un problème v1 ; backpressure est plus prioritaire que les deltas.

#### M3. La télémétrie reconstruit profils et bandit 30 fois par seconde

Des objets imbriqués sont recréés chaque tick alors qu’ils ne sont utiles qu’en fin d’étage ou lors d’une sauvegarde ([telemetry.ts:513](/home/amaury/dev/dungeon_crawler/apps/server/src/telemetry.ts:513), [telemetry.ts:532](/home/amaury/dev/dungeon_crawler/apps/server/src/telemetry.ts:532)). Déplacer ces snapshots dans `toRecord()` réduirait le GC sans changer la mesure.

#### M4. Le bruit WebAudio est réalloué à chaque effet

`noiseSource()` crée et remplit un buffer d’une demi-seconde à chaque burst ([audio.ts:294](/home/amaury/dev/dungeon_crawler/apps/client/src/audio.ts:294), [audio.ts:328](/home/amaury/dev/dungeon_crawler/apps/client/src/audio.ts:328)). Mettre en cache un seul buffer de bruit par `AudioContext` évitera une allocation notable pendant les combats chargés.

#### M5. Le libellé SAS/Gardien est immédiatement écrasé

Le paquet `floor` affiche correctement « Sanctuaire » ou « Gardien » ([main.ts:219](/home/amaury/dev/dungeon_crawler/apps/client/src/main.ts:219)), mais chaque paquet `state` remplace ensuite ce texte par le seul numéro ([main.ts:253](/home/amaury/dev/dungeon_crawler/apps/client/src/main.ts:253)). Conserver `lastScene` dans la mise à jour du HUD.

#### M6. Code et documentation abandonnés

- `Tile.Door` est rendu et accepté mais jamais généré ([types.ts:21](/home/amaury/dev/dungeon_crawler/packages/engine/src/types.ts:21), [mapgen.ts:78](/home/amaury/dev/dungeon_crawler/packages/engine/src/mapgen.ts:78)).
- `AGGRO_MAX_DIST`, `healCap`, `HORDE_MIN` et `HORDE_MAX` sont importés sans usage dans [game.ts:33](/home/amaury/dev/dungeon_crawler/packages/engine/src/game.ts:33).
- `recipes.ts` parle encore de tirage uniforme alors que le bandit est actif ([recipes.ts:1](/home/amaury/dev/dungeon_crawler/packages/engine/src/recipes.ts:1)).
- Le README annonce encore `SAVE_VERSION = 3` et « pas de son », alors que la sauvegarde est v8 et l’audio livré ([README.md:569](/home/amaury/dev/dungeon_crawler/README.md:569), [README.md:590](/home/amaury/dev/dungeon_crawler/README.md:590), [persist.ts:51](/home/amaury/dev/dungeon_crawler/apps/server/src/persist.ts:51)).

Nettoyage simple avant tag v1.0.

## 5. Les 5 actions que je ferais en premier

1. **Réparer la preuve** : cycle réel dans `curve.ts`, télémétrie indexée par run/scène/visite, attribution causale du bandit, puis relancer les relevés actuels sans changer de chiffre.

2. **Rendre le Gardien honnête** : pattern figé au début du windup et télégraphe exact transporté par le protocole.

3. **Fermer les trous serveur** : validation runtime des messages, statut hors ligne des personnages, backpressure et sérialisation des sauvegardes.

4. **Fiabiliser les transitions** : ancien escalier capturé avant la descente, RNG unique, compteurs de room réinitialisés après wipe, tests de descente live et save/load.

5. **Enrichir l’économie sans toucher aux statistiques** : ceinture tactique minimale graines/orbes/objets lancés, achat explicite, puis mesure de son effet sur dépenses, engagement, downs et diversité d’armes.
---

## Addendum — Relevé post-chantier (10 août 2026)

Les quatre jalons issus de cet audit ont été livrés : « La preuve redevient
vraie » (curve au cycle réel, télémétrie par run/étage/scène, attribution
causale du bandit, ciblage hors salle de repos), « Le Gardien honnête »
(pattern figé au télégraphe, exécution garantie à l'expiration, prêtre en
garde d'élite de l'arène), « Le serveur ferme ses portes » (validation
réseau, statut hors ligne, backpressure, sauvegardes en quarantaine) et
« Transitions fiables » (descente déterministe, ancien escalier, client sans
fuites, harnais `scripts/server-test.ts`). Suite complète verte à chaque
jalon.

**Cette affirmation était trop tranquille pour la moitié serveur, et une
relecture du chantier l'a montré.** Le gameplay et les instruments de mesure
tenaient ; les frontières, non. Un wipe se volatilisait si le process
s'arrêtait dans les 2,5 secondes d'écran de fin — le cas exact d'un
redéploiement — et la partie morte était rejouée telle quelle au retour. Le
statut hors ligne promettait « hors du monde » alors que le corps absorbait
encore flèches et charges, armait la salle piégée et faussait toutes les
mesures. Et une sauvegarde superficiellement plausible pouvait passer le
chargement pour tomber à chaque tick, hors de portée de la quarantaine.

Ces trois familles sont corrigées par le chantier suivant (« Le serveur
survit au redéploiement », « Le monde ne garde pas de fantômes », « La preuve
du serveur »), avec leurs verrous dans `scripts/server-test.ts` — dont un
contrat qui prouve l'objectif plutôt que le moyen : toute sauvegarde relue
doit supporter un vrai `join` et un vrai tick.

Trois limites restent, assumées et écrites là où on les cherchera : les
événements d'un paquet d'état sauté pour cause de socket saturée ne sont pas
rejoués (ils ne pilotent que du son et des particules) ; le corps d'un
personnage absent continue d'occuper sa place aux yeux du placement, pour
qu'on ne fasse apparaître personne dedans ; et `Tile.Door` reste une valeur
réservée, jamais générée, parce que renuméroter les tuiles invaliderait
toutes les sauvegardes pour du décor.

### La courbe, maintenant qu'elle dit vrai (B1 corrigé)

`curve.ts` calcule enfin le cycle d'attaque réel étage par étage (windup +
récupération resserrée). Verdict sur 20 étages :

- **TTK : 1,20 s constant, dérive ×1,000.** La cible est tenue exactement —
  le modèle de puissance fait ce qu'il promet.
- **K : 3,26 (étage 1) → 2,37 (étage 20), dérive ×1,383** (le
  temps-pour-mourir se contracte de ~27 %). Le resserrement de récupération
  des monstres (`FLOOR_COOLDOWN_TIGHTEN`) ronge le TTD plus vite que les PV
  du joueur ne montent. Le plancher (`FLOOR_COOLDOWN_MIN` à l'étage 14)
  stabilise K ≈ 2,4 au-delà.

**Décision : constaté et documenté, pas corrigé.** TTK/K sont intouchables
dans ce chantier ; l'équilibrage de la dérive de K est un chantier séparé qui
attendra son go, nourri par ces chiffres devenus fiables.

### Botrun, 3 graines, brute et rush (10 étages demandés)

| Graine | Mode | Étage atteint | Morts | TTK relevé | K relevé (é.1 → dernier) |
|---|---|---|---|---|---|
| 20260808 | brute | 4 (wipe) | 6 | 1,11 → 1,37 s | 19,5 → 9,3 |
| 20260809 | brute | 4 (wipe) | 6 | 1,11 → 1,29 s | 23,2 → 13,6 |
| 20260810 | brute | 4 (wipe) | 6 | 1,11 → 1,25 s | 26,8 → 7,3 |
| 20260808 | rush | 4 (wipe) | 6 | 1,37 s | 8,0 |
| 20260809 | rush | 4 (wipe) | 6 | 1,37 s | 4,4 |
| 20260810 | rush | 4 (wipe) | 6 | 1,37 s | 2,6 |

Lecture : le bot (qui joue mal, c'est sa fonction) meurt à l'étage 4 sur les
six runs — cohérence brute/rush retrouvée, la poursuite fait payer le rush
(16, 8 et 11 suiveurs livrés à l'étage 4). Aucun étage traversé sans
encaisser, premier étage dangereux : 1–2. Le K relevé en jeu reste très
au-dessus du K analytique (le bot frappe des monstres déjà engagés sur
quatre joueurs) ; c'est la dérive RELATIVE qui compte, et elle suit la
courbe.

**Aucune décision d'équilibrage n'est prise ici.** Ce relevé est la ligne de
base : les chiffres sont désormais produits par des instruments justes, et
toute retouche future de TTK/K devra se prouver contre eux.
