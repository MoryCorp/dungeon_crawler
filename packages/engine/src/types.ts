/**
 * Types et constantes partagés client <-> serveur.
 *
 * Le monde est fait de tuiles, mais les acteurs s'y déplacent en coordonnées
 * continues : positions flottantes exprimées en tuiles, 1.0 = une tuile. La
 * grille ne sert qu'aux murs, au pathfinding et au champ de vision — jamais à
 * contraindre un déplacement.
 *
 * Tous les réglages de game feel sont ici et nulle part ailleurs.
 */

export const TICK_RATE = 30
export const TICK_MS = 1000 / TICK_RATE
export const DT = 1 / TICK_RATE

/** Raccourci : convertit des secondes en ticks. */
export const ticks = (seconds: number) => Math.round(seconds * TICK_RATE)

export const Tile = {
  Wall: 0,
  Floor: 1,
  Door: 2,
  Stairs: 3,
} as const
export type TileId = (typeof Tile)[keyof typeof Tile]

export function isWalkable(t: number): boolean {
  return t === Tile.Floor || t === Tile.Door || t === Tile.Stairs
}

export function blocksSight(t: number): boolean {
  return t === Tile.Wall
}

export const MAP_W = 64
export const MAP_H = 64

// --- Déplacement ------------------------------------------------------------

/** Rayon de collision, en tuiles. Un peu moins d'une demi-tuile pour passer les portes sans accrocher. */
export const ACTOR_RADIUS = 0.33
export const PLAYER_SPEED = 4.2
/** Décroissance exponentielle du recul, par seconde. */
export const KNOCKBACK_DECAY = 9

// --- Armes ------------------------------------------------------------------

export interface WeaponDef {
  label: string
  /** Portée du balayage, depuis le centre du personnage. */
  reach: number
  /** Demi-angle de l'arc touché, en radians. */
  halfArc: number
  cooldown: number
  /** Durée pendant laquelle on est engagé : on ralentit, on ne peut plus fuir. */
  swing: number
  /** Vitesse conservée pendant cet engagement. C'est le prix de la frappe. */
  movePenalty: number
  damage: number
  knockback: number
  /** Présent pour les armes à distance : le coup tire un projectile. */
  ranged?: { speed: number; ttl: number }
  color: number
}

const deg = (d: number) => (d * Math.PI) / 180

/**
 * Budget de puissance : **toutes les armes ont le même DPS nominal**, et se
 * différencient uniquement par la façon de le dépenser — portée, ouverture
 * d'arc, engagement, recul. Choisir une arme n'est plus « laquelle tape le plus
 * fort » mais « quel profil de risque » : la dague force le contact, la hache
 * te cloue sur place, la lance tient la distance dans un cône étroit.
 *
 * Les dégâts se déduisent donc de la cadence : `damage = WEAPON_DPS × cooldown`,
 * en prenant la cadence **arrondie au tick** — sinon `ticks()` réintroduit un
 * écart de 11 % entre la meilleure et la pire arme, et le budget ne veut plus
 * rien dire. Ce ne sont pas des entiers : ils sont multipliés par la puissance
 * du joueur puis arrondis au moment du coup.
 *
 * `swing` et `movePenalty` sont l'autre moitié du prix : frapper immobilise
 * partiellement. Sans ce coût, toutes les armes reviennent à « avancer en
 * cliquant » et n'ont plus d'identité.
 */
export const WEAPON_DPS = 15

export const WEAPONS: Record<string, WeaponDef> = {
  sword:  { label: 'Épée',    reach: 1.45, halfArc: deg(55), cooldown: ticks(0.42), swing: ticks(0.18), movePenalty: 0.45, damage: 6.50,  knockback: 5,   color: 0xd8dde8 },
  dagger: { label: 'Dague',   reach: 1.00, halfArc: deg(40), cooldown: ticks(0.18), swing: ticks(0.08), movePenalty: 0.72, damage: 2.50,  knockback: 1.5, color: 0xbfe8d8 },
  axe:    { label: 'Hache',   reach: 1.60, halfArc: deg(85), cooldown: ticks(0.78), swing: ticks(0.40), movePenalty: 0.12, damage: 11.50, knockback: 9,   color: 0xe8b48a },
  spear:  { label: 'Lance',   reach: 2.40, halfArc: deg(22), cooldown: ticks(0.55), swing: ticks(0.26), movePenalty: 0.35, damage: 8.50,  knockback: 3.5, color: 0xc9d8f0 },
  bow:    { label: 'Arc',     reach: 0.9,  halfArc: deg(30), cooldown: ticks(0.50), swing: ticks(0.16), movePenalty: 0.55, damage: 7.50,  knockback: 2,
            ranged: { speed: 15, ttl: ticks(1.2) }, color: 0xe8dca0 },
}

export const STARTING_WEAPON = 'sword'
/** Armes trouvables dans les coffres. */
export const LOOT_WEAPONS = ['dagger', 'axe', 'spear', 'bow']

// --- Progression : le modèle de puissance -----------------------------------

/**
 * Le jeu ne se règle pas en dégâts. Il se règle sur trois grandeurs :
 *
 *   TTK = PV effectifs du monstre / DPS du joueur     — temps pour tuer
 *   TTD = PV effectifs du joueur / DPS des monstres   — temps pour mourir
 *   K   = TTD / TTK                                   — combien on en gère à la fois
 *
 * L'invariant de conception : **TTK et K restent constants sur toute la
 * descente**. La difficulté ne vient jamais des statistiques, elle vient du
 * nombre d'ennemis simultanés et de la géométrie de la rencontre. C'est ce qui
 * permet à l'étage 20 d'être aussi tendu que l'étage 2 sans que les monstres
 * deviennent des éponges à coups.
 *
 * La mesure qui a imposé ce modèle : sur une descente réelle jusqu'à l'étage
 * 16, TTK valait 0.5 s et K montait de 6 à 11. On pouvait tuer dix monstres
 * dans le temps qu'il leur fallait pour en venir à bout d'un joueur — aucune
 * rencontre ne pouvait menacer qui que ce soit.
 */
export const TARGET_TTK = 1.2
export const TARGET_K = 3.2

/**
 * La puissance est MULTIPLICATIVE, et c'est le point le plus important du
 * fichier.
 *
 * Le modèle additif précédent (`dégâts = arme + atk`) faisait disparaître
 * l'arme dans le bruit : au niveau 1 la hache frappait 3× plus fort que la
 * dague, au niveau 24 seulement 1.36× plus fort. Il ne restait que la cadence,
 * donc la dague gagnait toujours — elle a produit 89 % des dégâts d'une
 * descente entière. Un facteur préserve les écarts pour toujours.
 */
export const ATK_GROWTH = 1.07
export const HP_GROWTH = 1.05

/**
 * Rythme visé : niveaux gagnés par étage. Ce n'est pas un réglage libre, c'est
 * la charnière entre la progression du joueur et celle du donjon — la courbe
 * d'XP est calibrée pour le tenir.
 */
export const LEVELS_PER_FLOOR = 1.0

export function powerScale(steps: number, growth: number): number {
  return growth ** Math.max(0, steps)
}

export const PLAYER_BASE_HP = 32

export function playerAttackMult(level: number): number {
  return powerScale(level - 1, ATK_GROWTH)
}

export function playerMaxHp(level: number): number {
  return Math.round(PLAYER_BASE_HP * powerScale(level - 1, HP_GROWTH))
}

/**
 * Réduction de dégâts, forme canonique à rendements décroissants : a / (a + k).
 *
 * Aucune armure n'existe encore. La constante et le chemin de calcul sont posés
 * maintenant pour que les armures s'ajoutent plus tard **sans redériver TTD ni
 * K** : une armure ne touchera jamais aux PV, elle changera les PV *effectifs*,
 * et c'est déjà cette grandeur-là que le modèle équilibre.
 *
 * Cette forme a une propriété qui la rend sûre : les PV effectifs valent
 * `PV × (1 + armure / k)`, donc ils croissent **linéairement** avec l'armure.
 * Pas d'emballement possible, quel que soit l'empilement — c'est exactement
 * pour ça que tous les jeux à statistiques l'utilisent. L'axe de coût prévu
 * pour une armure lourde est la vitesse de déplacement, pas un malus de PV.
 */
export const ARMOR_K = 60

export function mitigation(armor: number): number {
  return armor / (armor + ARMOR_K)
}

/** PV effectifs : la vraie monnaie défensive, celle que TTD et K mesurent. */
export function effectiveHp(maxHp: number, armor = 0): number {
  return maxHp / (1 - mitigation(armor))
}

/**
 * XP cumulée nécessaire pour atteindre un niveau donné.
 *
 * L'exposant décide du rythme, et le rythme n'est plus une question de goût :
 * il doit tenir LEVELS_PER_FLOOR, sinon la montée dérivée des monstres ne
 * correspond plus à rien et TTK dérive. `scripts/curve.ts` vérifie que la
 * courbe et le butin des étages sont bien d'accord.
 *
 * Ces deux nombres ne sont pas choisis, ils sont **ajustés** sur le butin réel
 * des étages : régression sur l'XP cumulée de vingt étages tués entièrement,
 * de sorte que le niveau atteint suive l'étage. Ils changent donc chaque fois
 * que le peuplement change — l'ancienne paire (30, 2.15) était calée sur un
 * étage qui triplait ses effectifs entre le premier et le vingtième ; avec une
 * réserve constante ils ne varient plus que de moitié, et la courbe devait
 * s'aplatir d'autant. Sans ce réajustement, les deux premiers étages
 * rapportaient deux niveaux chacun et le héros prenait une avance qu'il ne
 * rendait jamais.
 */
export const XP_CURVE_SCALE = 107
export const XP_CURVE_EXPONENT = 1.69

export function xpForLevel(level: number): number {
  return Math.round(XP_CURVE_SCALE * (level - 1) ** XP_CURVE_EXPONENT)
}

/** Un cœur rend une fraction des PV max : sinon il devient dérisoire en profondeur. */
export const HEART_HEAL_RATIO = 0.22
export const HEART_HEAL_MIN = 8

// --- Mise à terre et relève -------------------------------------------------

/** Temps avant de mourir pour de bon quand on est à terre. */
export const BLEED_OUT_TICKS = ticks(25)
/** Durée pour relever un coéquipier, en restant à côté de lui. */
export const REVIVE_TICKS = ticks(2.5)
export const REVIVE_RANGE = 1.1
/** Vitesse d'un joueur à terre : il rampe vers ses coéquipiers. */
export const DOWNED_SPEED = 1.3
export const REVIVE_HP_RATIO = 0.45

export const RESPAWN_TICKS = ticks(8)
export const RESPAWN_GRACE = ticks(2)

// --- Combat -----------------------------------------------------------------

/** Durée visuelle du swing d'un monstre. Les armes des joueurs ont la leur. */
export const ATTACK_SWING = ticks(0.18)
export const MONSTER_HALF_ARC = deg(45)

export const FOV_RADIUS = 9
export const AGGRO_MEMORY = ticks(3)
export const AGGRO_MAX_DIST = 14

// --- Recul ------------------------------------------------------------------

/**
 * Rendements décroissants du recul. C'est le réglage le plus important du jeu.
 *
 * Sans lui, un joueur qui enchaîne les coups repousse sa cible juste assez vite
 * pour qu'elle n'ait jamais le temps de terminer sa préparation : n'importe
 * quel monstre au corps à corps devient incapable de toucher, et la meilleure
 * stratégie du jeu est « avancer tout droit en cliquant ». Chaque coup
 * consécutif sur la même cible pousse donc de moins en moins, et le compteur
 * retombe si on arrête de frapper une seconde.
 */
export const KB_STACK_FALLOFF = 1.0
export const KB_STACK_RESET = ticks(1.1)
/** Les gros encaissent le recul : un boss ne se repousse pas. */
export const ELITE_WEIGHT_MULT = 2.0
export const BOSS_WEIGHT_MULT = 4.0

// --- Montée en difficulté ---------------------------------------------------

/**
 * La montée des monstres n'est pas choisie, elle est **dérivée**.
 *
 * Ce sont exactement les facteurs qui gardent TTK et TTD constants quand le
 * joueur progresse au rythme prévu : les monstres doivent gagner en PV ce que
 * le joueur gagne en dégâts sur un étage, et en dégâts ce qu'il gagne en PV
 * effectifs. Toucher à ATK_GROWTH ou à LEVELS_PER_FLOOR recalcule le donjon
 * tout seul, et c'est le but — un seul endroit où mentir devient impossible.
 *
 * On ne fait jamais croître le temps de préparation : le télégraphe doit rester
 * aussi lisible à l'étage 20 qu'au premier, sinon la difficulté cesse d'être
 * juste.
 */
export const FLOOR_HP_GROWTH = ATK_GROWTH ** LEVELS_PER_FLOOR
export const FLOOR_ATK_GROWTH = HP_GROWTH ** LEVELS_PER_FLOOR
/** L'XP par monstre suit les PV : un étage doit rapporter LEVELS_PER_FLOOR. */
export const FLOOR_XP_GROWTH = FLOOR_HP_GROWTH
export const FLOOR_COOLDOWN_TIGHTEN = 0.03
export const FLOOR_COOLDOWN_MIN = 0.6

/** Facteur de puissance d'un étage. Géométrique, comme celui du joueur. */
export function floorScale(floor: number, growth: number): number {
  return powerScale(floor - 1, growth)
}

/**
 * Le peuplement d'un étage se fait en deux parts qui ne jouent pas du tout le
 * même rôle.
 *
 * `PLACED_*` — ce qui est posé sur la carte. On le rencontre en explorant, et
 * on le rencontre presque toujours **seul**, même quand c'est posé en meute :
 * les espèces n'ont pas la même vitesse, donc une meute s'étire pendant
 * l'approche et se présente en file indienne. C'est le décor du donjon, ce
 * n'est pas sa difficulté.
 *
 * La réserve de la Directrice — ce qui n'est pas posé, et qui sera livré en
 * vague. C'est de là que vient la difficulté.
 *
 * La mesure qui a imposé ce partage : avec une réserve calculée comme une part
 * (45 %) d'un budget de quatorze, la Directrice avait de quoi livrer **une**
 * vague par étage. Elle fonctionnait — les relevés le montraient — et
 * l'effectif médian des rencontres restait à 1.3, parce que tout le reste de
 * l'étage était fait de monstres isolés. Une part d'un total est un mauvais
 * réglage : c'est le nombre de vagues qu'on veut choisir.
 */
export const PLACED_BASE_COUNT = 7
export const PLACED_PER_FLOOR = 2
export const PLACED_MAX_COUNT = 26
/**
 * Part des monstres posés dans les couloirs plutôt que dans les salles.
 * Tomber sur un archer ou un chargeur dans un couloir d'une tuile de large est
 * le meilleur moment du jeu : on ne peut pas le contourner, on ne peut pas
 * reculer sans se faire rattraper, il faut décider tout de suite.
 */
export const CORRIDOR_SPAWN_SHARE = 0.35

/**
 * Taille des meutes. Un monstre isolé n'est jamais une menace, quels que soient
 * ses points de vie : on le frappe, il recule, on recommence. C'est à trois
 * qu'ils obligent à choisir lequel gérer d'abord, à reculer, à utiliser la
 * géométrie de la pièce. La difficulté vient du nombre simultané, pas du total.
 */
export const PACK_MIN = 2
export const PACK_MAX = 4
/** Rayon dans lequel les membres d'une meute sont dispersés. */
export const PACK_SPREAD = 2.5

/**
 * Poursuite : les monstres laissés en vie descendent l'escalier derrière vous.
 *
 * Les mesures ont montré que le vrai problème n'était pas la force des
 * monstres mais le fait que rien n'obligeait à les affronter : on trouvait la
 * clé, on descendait, et on ignorait 60 % de l'étage sans conséquence. Une
 * dette qui suit règle ça sans toucher à un seul chiffre de statistique — et
 * elle reste entièrement sous contrôle du joueur, puisqu'il suffit de tuer
 * pour ne rien devoir.
 *
 * Ils ne débouchent pas à l'escalier d'arrivée : ils sont versés à la réserve
 * de la Directrice, qui les livrera quand elle jugera le moment venu. La
 * première version les faisait sortir un par un au pied de l'escalier, ce qui
 * s'est révélé être exactement le mauvais choix : il suffisait d'attendre sur
 * place et de les cueillir à la sortie, isolés, sans jamais en affronter deux.
 * Confiée à la Directrice, la dette redevient ce qu'elle devait être — ce qu'on
 * a laissé en vie revient en groupe, ailleurs, et au pire moment.
 */
export const PURSUE_MAX = 16
/** Répit accordé à celui qui débouche, pour qu'il ne frappe pas dès l'apparition. */
export const PURSUE_STRIKE_GRACE = ticks(0.6)

/** Un monstre de l'étage précédent, en attente d'être renvoyé au front. */
export interface Pursuer {
  actor: Actor
}

// --- La Directrice ----------------------------------------------------------

/**
 * Pilotage de l'intensité, sur le modèle de l'IA Directrice de Left 4 Dead.
 *
 * La difficulté ne doit pas être une rampe mais une **onde** : montée, pic,
 * décompression, repos. Une pression constante cesse d'être perçue au bout de
 * quelques minutes — c'est le creux qui donne sa valeur au pic.
 *
 * La mesure qui l'a rendue nécessaire : sur de vraies parties, l'effectif
 * médian des rencontres valait 1 et les deux tiers du temps de combat se
 * passaient en tête-à-tête. Les meutes posées sur la carte s'étirent pendant
 * l'approche. Une Directrice ne place pas les monstres, elle les **livre**,
 * groupés, quand il ne se passe rien.
 */
export interface DirectorState {
  phase: 'buildup' | 'peak' | 'fade' | 'rest'
  /** Intensité perçue du joueur le plus sous pression, entre 0 et 1. */
  intensity: number
  /** Tick d'entrée dans la phase courante. */
  since: number
}

/** Seuil d'intensité au-delà duquel on considère être au pic. */
export const DIRECTOR_PEAK = 0.8
/** Seuil en deçà duquel on considère que le joueur souffle. */
export const DIRECTOR_CALM = 0.25
/** Décroissance de l'intensité par tick : ~2 s pour retomber de moitié. */
export const DIRECTOR_DECAY = 0.988
/** Durée du pic tenu avant de laisser retomber. */
export const DIRECTOR_PEAK_HOLD = ticks(6)
/** Repos garanti après une décompression. Rien ne peut le raccourcir. */
export const DIRECTOR_REST = ticks(10)
/** Temps de calme continu avant de livrer une vague. */
export const DIRECTOR_PATIENCE = ticks(6)

/** Intensité gagnée par fraction de PV max perdue d'un coup. */
export const INTENSITY_PER_DAMAGE = 2.2
/** Intensité gagnée par tick et par ennemi à portée. */
export const INTENSITY_PER_FOE = 0.004
/** Une mise à terre est le pic d'intensité le plus fort du jeu. */
export const INTENSITY_DOWNED = 0.7

/**
 * Taille d'une vague. C'est le seul chiffre qui décide vraiment de la
 * difficulté : trois monstres simultanés forcent à choisir lequel gérer, à
 * reculer, à utiliser la géométrie de la pièce. Un seul ne force rien.
 */
export const HORDE_MIN = 3
export const HORDE_MAX = 6
/** Rayon de dispersion d'une vague. Serré : ils doivent arriver ensemble. */
export const HORDE_SPREAD = 1.6
/** Distance de livraison : assez loin pour être vue venir, assez près pour arriver. */
export const HORDE_MIN_DIST = 7
export const HORDE_MAX_DIST = 15

/**
 * Vagues que la Directrice doit pouvoir livrer sur un étage, et la réserve qui
 * s'en déduit.
 *
 * La réserve ne grandit **pas** avec l'étage, et c'est volontaire : le modèle
 * de puissance tient K constant, donc le nombre d'ennemis simultanés qu'on peut
 * gérer est le même à l'étage 20 qu'à l'étage 2. Une vague de l'étage 20 n'est
 * pas plus nombreuse, elle est plus forte — et c'est le scaling des statistiques
 * qui s'en charge, pas le compte.
 */
export const DIRECTOR_WAVES = 5
export const DIRECTOR_RESERVE = Math.round((DIRECTOR_WAVES * (HORDE_MIN + HORDE_MAX)) / 2)

// --- Monstres ---------------------------------------------------------------

/**
 * Le comportement, pas les statistiques, est ce qui rend un combat différent
 * du précédent. Chaque archétype exige une réponse distincte du joueur.
 */
export type Behavior =
  /** Avance et frappe au contact. */
  | 'melee'
  /** Garde ses distances et tire : il faut fermer l'écart. */
  | 'archer'
  /** Télégraphie puis fonce en ligne droite : il faut se décaler sur le côté. */
  | 'charger'
  /** S'approche et explose : il faut reculer, ou le tuer de loin. */
  | 'bomber'
  /** Rapide et fragile, en nombre : il faut de l'arc large. */
  | 'swarm'

export interface SpeciesDef {
  label: string
  behavior: Behavior
  maxHp: number
  atk: number
  speed: number
  /** Distance de déclenchement de l'attaque. */
  reach: number
  /** Temps d'immobilité avant que le coup parte : la fenêtre d'esquive. */
  windup: number
  cooldown: number
  knockback: number
  /** Résistance au recul : une chauve-souris s'envole, un orc guerrier bouge à peine. */
  weight: number
  xp: number
  color: number
  /** archer : vitesse du projectile en tuiles/seconde. */
  projectileSpeed?: number
  /** archer : distance en dessous de laquelle il recule au lieu d'avancer. */
  keepAway?: number
  /** charger : vitesse et durée de la ruée. */
  dashSpeed?: number
  dashTicks?: number
  /** bomber : rayon de l'explosion. */
  blastRadius?: number
}

export const MONSTERS: Record<string, SpeciesDef> = {
  skeleton:         { label: 'Squelette',          behavior: 'melee',   maxHp: 12, atk: 3, speed: 2.2, reach: 1.0,  windup: ticks(0.40), cooldown: ticks(0.9),  knockback: 3.5, weight: 0.9, xp: 4,  color: 0xd8d8c0 },
  skeleton_warrior: { label: 'Squelette guerrier', behavior: 'melee',   maxHp: 26, atk: 5, speed: 1.9, reach: 1.1,  windup: ticks(0.55), cooldown: ticks(1.1),  knockback: 5.5, weight: 1.6, xp: 9,  color: 0xbfc4a8 },
  orc:              { label: 'Orc',                behavior: 'melee',   maxHp: 18, atk: 4, speed: 2.4, reach: 1.05, windup: ticks(0.45), cooldown: ticks(1.0),  knockback: 4.5, weight: 1.2, xp: 6,  color: 0x7ba05b },

  skeleton_mage:    { label: 'Squelette mage',     behavior: 'archer',  maxHp: 10, atk: 5, speed: 1.9, reach: 7.5,  windup: ticks(0.75), cooldown: ticks(1.6),  knockback: 3.0, weight: 0.8, xp: 11, color: 0xc0a8d8,
                      projectileSpeed: 8.5,  keepAway: 4.5 },
  orc_mage:         { label: 'Orc mage',           behavior: 'archer',  maxHp: 14, atk: 7, speed: 1.7, reach: 8.5,  windup: ticks(0.90), cooldown: ticks(1.9),  knockback: 4.0, weight: 0.9, xp: 14, color: 0x9b8a5f,
                      projectileSpeed: 7.0,  keepAway: 5.5 },

  skeleton_rogue:   { label: 'Squelette rôdeur',   behavior: 'charger', maxHp: 14, atk: 6, speed: 2.6, reach: 5.0,  windup: ticks(0.50), cooldown: ticks(1.5),  knockback: 6.0, weight: 1.0, xp: 10, color: 0xa8c4bf,
                      dashSpeed: 13, dashTicks: ticks(0.42) },
  orc_warrior:      { label: 'Orc guerrier',       behavior: 'charger', maxHp: 34, atk: 9, speed: 2.0, reach: 6.0,  windup: ticks(0.70), cooldown: ticks(1.9),  knockback: 11,  weight: 2.2, xp: 18, color: 0x5f8a44,
                      dashSpeed: 11, dashTicks: ticks(0.55) },

  orc_bomber:       { label: 'Orc kamikaze',       behavior: 'bomber',  maxHp: 16, atk: 14, speed: 2.7, reach: 1.4, windup: ticks(1.0),  cooldown: ticks(1.0),  knockback: 12,  weight: 1.0, xp: 13, color: 0xd2694a,
                      blastRadius: 2.6 },

  // Les essaims doivent survivre à un coup, sinon ils n'existent pas : mesuré
  // sur une descente complète, 26 d'entre eux étaient morts sans avoir infligé
  // un seul point de dégât. Leur identité, c'est le harcèlement, pas le sac de
  // points de vie — mais du harcèlement qui meurt avant d'avoir frappé n'est
  // que du décor.
  bat:              { label: 'Chauve-souris',      behavior: 'swarm',   maxHp: 10, atk: 2, speed: 3.6, reach: 0.85, windup: ticks(0.22), cooldown: ticks(0.6),  knockback: 1.5, weight: 0.5, xp: 3,  color: 0x8a7bb0 },
  orc_rogue:        { label: 'Orc rôdeur',         behavior: 'swarm',   maxHp: 15, atk: 3, speed: 3.3, reach: 0.9,  windup: ticks(0.26), cooldown: ticks(0.65), knockback: 2.5, weight: 0.6, xp: 5,  color: 0x8fb36a },
}

/** Le porteur de clé : plus gros, plus coriace, il verrouille l'escalier. */
export const ELITE_HP_MULT = 3.2
export const ELITE_ATK_MULT = 1.5
export const ELITE_XP_MULT = 4

export const BOSS_SPECIES = 'orc_warrior'
export const BOSS_HP_MULT = 9
export const BOSS_ATK_MULT = 1.8
export const BOSS_XP_MULT = 12
/** Un boss remplace l'élite tous les N étages. */
export const BOSS_EVERY = 5

// --- Acteurs ----------------------------------------------------------------

export interface Actor {
  id: string
  kind: 'player' | 'monster'
  species: string
  name: string
  x: number
  y: number
  /** Recul en cours, en tuiles/seconde. Décroît tout seul. */
  kx: number
  ky: number
  hp: number
  maxHp: number
  atk: number
  /**
   * Armure. Personne n'en porte encore : le champ existe pour que les armures
   * s'ajoutent sans toucher au modèle d'équilibrage, qui raisonne déjà en PV
   * effectifs. Voir `mitigation()`.
   */
  armor?: number
  /** Direction de visée, en radians. */
  aim: number
  alive: boolean
  swingUntil: number
  readyAt: number
  windupUntil?: number
  aggroUntil?: number
  respawnAt?: number
  invulnUntil?: number

  /** Joueurs. */
  weapon?: string
  level?: number
  xp?: number
  /** À terre : vivant mais hors de combat, en attente d'être relevé. */
  downed?: boolean
  bleedOutAt?: number
  /** Progression de la relève en cours, de 0 à 1. */
  reviveProgress?: number

  /** Monstres. */
  elite?: boolean
  boss?: boolean
  /** charger : tick de fin de la ruée en cours. */
  dashUntil?: number
  dashVx?: number
  dashVy?: number

  /** Coups de recul encaissés d'affilée, et quand. Voir KB_STACK_FALLOFF. */
  kbStacks?: number
  kbStackAt?: number
}

export interface Projectile {
  id: string
  ownerId: string
  /**
   * Espèce du tireur, figée au départ. Une flèche survit à son archer : sans
   * ça, tuer l'archer puis se prendre sa flèche n'est imputé à personne et
   * disparaît des mesures — or c'est précisément un moment intéressant.
   */
  ownerSpecies: string
  /** Un projectile de monstre ne touche que les joueurs, et inversement. */
  hostileToPlayers: boolean
  x: number
  y: number
  vx: number
  vy: number
  damage: number
  knockback: number
  ttl: number
  color: number
}

export const PROJECTILE_RADIUS = 0.18

export type ItemKind = 'heart' | 'xp' | 'weapon' | 'chest' | 'key'

export interface GroundItem {
  id: string
  kind: ItemKind
  x: number
  y: number
  /** kind === 'weapon' */
  weapon?: string
  /** kind === 'xp' */
  amount?: number
  /**
   * Joueur qui vient de faire apparaître cet objet et ne peut pas le reprendre
   * tant qu'il ne s'en est pas éloigné. Sans ça, échanger d'arme sur place
   * boucle indéfiniment : on repose la sienne et on la reprend au tick suivant.
   */
  lockedFor?: string
}

/** Distance de ramassage automatique. Les coffres, eux, s'ouvrent au contact. */
export const PICKUP_RANGE = 0.75
export const XP_MAGNET_RANGE = 3.0
export const XP_MAGNET_SPEED = 6

// --- Entrées ----------------------------------------------------------------

export interface PlayerInput {
  mx: number
  my: number
  aim: number
  attack: boolean
}

export const NEUTRAL_INPUT: PlayerInput = { mx: 0, my: 0, aim: 0, attack: false }

// --- Événements -------------------------------------------------------------

export type GameEvent =
  /**
   * `fromSpecies` / `species` sont portés par l'événement plutôt que résolus
   * après coup : l'auteur du coup peut avoir disparu avant la fin du tick (un
   * kamikaze meurt de sa propre explosion), et sans ça la télémétrie perdrait
   * exactement les dégâts les plus intéressants à mesurer.
   */
  | { t: 'swing'; id: string; x: number; y: number; aim: number; reach: number; halfArc: number }
  | {
      t: 'hit'
      from: string
      fromSpecies: string
      to: string
      toSpecies: string
      dmg: number
      x: number
      y: number
    }
  | { t: 'blast'; x: number; y: number; radius: number }
  /** Émis à la descente : voilà ce qu'on a laissé derrière soi, et qui suit. */
  | { t: 'pursuit'; count: number }
  /** Un poursuivant vient de déboucher de l'escalier. */
  | { t: 'arrive'; id: string; species: string; x: number; y: number }
  /** La Directrice vient de livrer une vague. */
  | { t: 'horde'; count: number; x: number; y: number }
  /**
   * Un objet vient d'apparaître au sol. Sans cet événement on ne peut pas
   * distinguer « aucun cœur n'est tombé » de « ils sont tous encore par terre »,
   * ni compter ceux ramassés dans le tick même où ils tombent — deux situations
   * opposées, et la deuxième est une stratégie de réserve à part entière.
   */
  | { t: 'drop'; kind: ItemKind; x: number; y: number }
  | { t: 'death'; id: string; kind: Actor['kind']; species: string; x: number; y: number }
  | { t: 'downed'; id: string; x: number; y: number }
  | { t: 'revived'; id: string; x: number; y: number }
  | { t: 'respawn'; id: string; x: number; y: number }
  | { t: 'pickup'; id: string; kind: ItemKind; x: number; y: number; label?: string }
  | { t: 'levelup'; id: string; level: number; x: number; y: number }
  | { t: 'keydrop'; x: number; y: number }
  | { t: 'unlock' }
  | { t: 'descend'; floor: number }

export interface GameState {
  tick: number
  floor: number
  seed: number
  rng: number
  width: number
  height: number
  tiles: Uint8Array
  actors: Record<string, Actor>
  projectiles: Projectile[]
  items: GroundItem[]
  /** Compteur d'identifiants pour les projectiles et objets. */
  nextId: number
  stairs: { x: number; y: number }
  spawn: { x: number; y: number }
  /** L'escalier ne s'ouvre qu'une fois la clé récupérée. */
  stairsLocked: boolean
  /** Monstres de l'étage précédent, en attente d'être renvoyés au front. */
  pursuers: Pursuer[]
  /** Monstres de cet étage gardés en réserve, à livrer par la Directrice. */
  reserve: string[]
  director: DirectorState
  /** Profil de style de chaque joueur, cumulé sur toute la partie. */
  profiles: Record<string, PlayerProfile>
  /** Monstres tués sur l'étage courant — le dénominateur de la patience. */
  floorKills: number
  events: GameEvent[]
}

// --- Profils de style ---------------------------------------------------------

/**
 * Ce que l'engine sait du style d'un joueur — la matière première de la future
 * adaptation (player modeling). L'engine ne fait que mesurer : aucune décision
 * de gameplay ne se prend là-dessus pour l'instant, et aucun de ces champs ne
 * touche au RNG — deux parties de même graine restent identiques au bit près.
 *
 * Tout est en sommes + comptes plutôt qu'en moyennes mobiles : les moyennes
 * sont exactes, l'ordre d'accumulation ne compte pas, et une room rechargée
 * trois jours plus tard reprend son profil exactement où il en était — une EMA
 * pèserait encore le style d'avant-hier. Les seules EMA sont les vecteurs de
 * direction, parce que là c'est précisément la récence qui est l'information.
 */
export interface PlayerProfile {
  /** Portée : somme des distances attaquant → victime à chaque coup infligé. */
  hitDistSum: number
  hitCount: number
  /** Mobilité : distance parcourue et ticks passés en combat. */
  combatMoveSum: number
  combatTicks: number
  /** Encombrement : ennemis engagés aux moments où le joueur encaisse. */
  crowdSum: number
  hitsTakenCount: number
  /** Cohésion : distance au coéquipier le plus proche, en combat, s'il existe. */
  allyDistSum: number
  allyTicks: number
  /** Patience : part de l'étage tuée avant de descendre, par descente vécue. */
  clearedSum: number
  floorsSeen: number
  /** Direction de déplacement en combat (EMA) : où ce joueur fuit d'habitude. */
  fleeX: number
  fleeY: number
  /**
   * Direction de déplacement tout court (EMA). C'est elle que lira une recette
   * qui coupe la route : la Directrice livre pendant le calme, donc au moment
   * de la décision le vecteur de fuite date du dernier combat — il est périmé.
   */
  moveX: number
  moveY: number
}

/** Lissage des EMA de direction : environ 0,7 s de demi-vie à 30 ticks/s. */
export const PROFILE_EMA_ALPHA = 0.033

/** Portée à laquelle un monstre pèse sur la décision immédiate du joueur. */
export const DIRECTOR_ENGAGE_RANGE = 6
