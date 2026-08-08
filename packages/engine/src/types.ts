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
 * Chaque arme impose un style de jeu différent, pas juste un chiffre :
 * la hache oblige à s'engager, la lance à tenir la distance, l'arc à kiter.
 *
 * `swing` est ce qui rend le choix réel : frapper immobilise partiellement. Une
 * hache ouvre un arc énorme mais te cloue sur place presque une demi-seconde ;
 * une dague ne t'engage presque pas mais gratte. Sans ce coût, toutes les armes
 * reviennent à « avancer en cliquant » et n'ont plus d'identité.
 */
export const WEAPONS: Record<string, WeaponDef> = {
  sword:  { label: 'Épée',    reach: 1.45, halfArc: deg(55), cooldown: ticks(0.42), swing: ticks(0.18), movePenalty: 0.45, damage: 6,  knockback: 5,   color: 0xd8dde8 },
  dagger: { label: 'Dague',   reach: 1.00, halfArc: deg(40), cooldown: ticks(0.18), swing: ticks(0.08), movePenalty: 0.85, damage: 3,  knockback: 1.5, color: 0xbfe8d8 },
  axe:    { label: 'Hache',   reach: 1.60, halfArc: deg(85), cooldown: ticks(0.78), swing: ticks(0.40), movePenalty: 0.12, damage: 13, knockback: 9,   color: 0xe8b48a },
  spear:  { label: 'Lance',   reach: 2.40, halfArc: deg(22), cooldown: ticks(0.55), swing: ticks(0.26), movePenalty: 0.35, damage: 8,  knockback: 3.5, color: 0xc9d8f0 },
  bow:    { label: 'Arc',     reach: 0.9,  halfArc: deg(30), cooldown: ticks(0.50), swing: ticks(0.16), movePenalty: 0.55, damage: 7,  knockback: 2,
            ranged: { speed: 15, ttl: ticks(1.2) }, color: 0xe8dca0 },
}

export const STARTING_WEAPON = 'sword'
/** Armes trouvables dans les coffres. */
export const LOOT_WEAPONS = ['dagger', 'axe', 'spear', 'bow']

// --- Progression ------------------------------------------------------------

export const PLAYER_BASE_HP = 32
export const PLAYER_BASE_ATK = 2
/** Gain par niveau. */
export const HP_PER_LEVEL = 5
export const ATK_PER_LEVEL = 1

/**
 * XP cumulée nécessaire pour atteindre un niveau donné.
 *
 * L'exposant est ce qui décide du rythme de la partie. Trop plat et on gagne
 * trois niveaux au premier étage : les monstres deviennent décoratifs et il n'y
 * a plus de tension jusqu'au bout. La courbe doit rester légèrement en retard
 * sur la montée en puissance des étages — c'est ce retard qui fait qu'on doit
 * jouer correctement plutôt que d'encaisser.
 */
export function xpForLevel(level: number): number {
  return Math.round(36 * (level - 1) ** 1.9)
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
 * Les monstres montent avec l'étage, les joueurs avec les niveaux. On fait
 * croître PV, dégâts et cadence — jamais le temps de préparation : le
 * télégraphe doit rester lisible à l'étage 20 comme à l'étage 1, sinon la
 * difficulté cesse d'être juste.
 */
export const FLOOR_HP_GROWTH = 0.22
export const FLOOR_ATK_GROWTH = 0.15
export const FLOOR_XP_GROWTH = 0.3
export const FLOOR_COOLDOWN_TIGHTEN = 0.03
export const FLOOR_COOLDOWN_MIN = 0.6

export function floorScale(floor: number, growth: number): number {
  return 1 + growth * Math.max(0, floor - 1)
}

export const MONSTER_BASE_COUNT = 11
export const MONSTER_PER_FLOOR = 3
export const MONSTER_MAX_COUNT = 46
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
  events: GameEvent[]
}
