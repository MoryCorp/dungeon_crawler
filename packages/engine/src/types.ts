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
 */
export const WEAPONS: Record<string, WeaponDef> = {
  sword:  { label: 'Épée',    reach: 1.45, halfArc: deg(55), cooldown: ticks(0.42), damage: 6,  knockback: 7.5, color: 0xd8dde8 },
  dagger: { label: 'Dague',   reach: 1.00, halfArc: deg(40), cooldown: ticks(0.18), damage: 3,  knockback: 2.5, color: 0xbfe8d8 },
  axe:    { label: 'Hache',   reach: 1.60, halfArc: deg(85), cooldown: ticks(0.78), damage: 13, knockback: 13,  color: 0xe8b48a },
  spear:  { label: 'Lance',   reach: 2.40, halfArc: deg(22), cooldown: ticks(0.55), damage: 8,  knockback: 6,   color: 0xc9d8f0 },
  bow:    { label: 'Arc',     reach: 0.9,  halfArc: deg(30), cooldown: ticks(0.50), damage: 7,  knockback: 4,
            ranged: { speed: 15, ttl: ticks(1.2) }, color: 0xe8dca0 },
}

export const STARTING_WEAPON = 'sword'
/** Armes trouvables dans les coffres. */
export const LOOT_WEAPONS = ['dagger', 'axe', 'spear', 'bow']

// --- Progression ------------------------------------------------------------

export const PLAYER_BASE_HP = 40
export const PLAYER_BASE_ATK = 2
/** Gain par niveau. */
export const HP_PER_LEVEL = 7
export const ATK_PER_LEVEL = 1

/** XP cumulée nécessaire pour atteindre un niveau donné. */
export function xpForLevel(level: number): number {
  return Math.round(18 * (level - 1) ** 1.45)
}

export const HEART_HEAL = 10

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

/** Durée visuelle du swing. */
export const ATTACK_SWING = ticks(0.18)
export const MONSTER_HALF_ARC = deg(45)

export const FOV_RADIUS = 9
export const AGGRO_MEMORY = ticks(3)
export const AGGRO_MAX_DIST = 14

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
  skeleton:         { label: 'Squelette',          behavior: 'melee',   maxHp: 12, atk: 3, speed: 2.2, reach: 1.0,  windup: ticks(0.40), cooldown: ticks(0.9),  knockback: 3.5, xp: 4,  color: 0xd8d8c0 },
  skeleton_warrior: { label: 'Squelette guerrier', behavior: 'melee',   maxHp: 26, atk: 5, speed: 1.9, reach: 1.1,  windup: ticks(0.55), cooldown: ticks(1.1),  knockback: 5.5, xp: 9,  color: 0xbfc4a8 },
  orc:              { label: 'Orc',                behavior: 'melee',   maxHp: 18, atk: 4, speed: 2.4, reach: 1.05, windup: ticks(0.45), cooldown: ticks(1.0),  knockback: 4.5, xp: 6,  color: 0x7ba05b },

  skeleton_mage:    { label: 'Squelette mage',     behavior: 'archer',  maxHp: 10, atk: 5, speed: 1.9, reach: 7.5,  windup: ticks(0.75), cooldown: ticks(1.6),  knockback: 3.0, xp: 11, color: 0xc0a8d8,
                      projectileSpeed: 8.5,  keepAway: 4.5 },
  orc_mage:         { label: 'Orc mage',           behavior: 'archer',  maxHp: 14, atk: 7, speed: 1.7, reach: 8.5,  windup: ticks(0.90), cooldown: ticks(1.9),  knockback: 4.0, xp: 14, color: 0x9b8a5f,
                      projectileSpeed: 7.0,  keepAway: 5.5 },

  skeleton_rogue:   { label: 'Squelette rôdeur',   behavior: 'charger', maxHp: 14, atk: 6, speed: 2.6, reach: 5.0,  windup: ticks(0.50), cooldown: ticks(1.5),  knockback: 6.0, xp: 10, color: 0xa8c4bf,
                      dashSpeed: 13, dashTicks: ticks(0.42) },
  orc_warrior:      { label: 'Orc guerrier',       behavior: 'charger', maxHp: 34, atk: 9, speed: 2.0, reach: 6.0,  windup: ticks(0.70), cooldown: ticks(1.9),  knockback: 11,  xp: 18, color: 0x5f8a44,
                      dashSpeed: 11, dashTicks: ticks(0.55) },

  orc_bomber:       { label: 'Orc kamikaze',       behavior: 'bomber',  maxHp: 16, atk: 14, speed: 2.7, reach: 1.4, windup: ticks(1.0),  cooldown: ticks(1.0),  knockback: 12,  xp: 13, color: 0xd2694a,
                      blastRadius: 2.6 },

  bat:              { label: 'Chauve-souris',      behavior: 'swarm',   maxHp: 6,  atk: 2, speed: 3.6, reach: 0.85, windup: ticks(0.22), cooldown: ticks(0.6),  knockback: 1.5, xp: 3,  color: 0x8a7bb0 },
  orc_rogue:        { label: 'Orc rôdeur',         behavior: 'swarm',   maxHp: 11, atk: 3, speed: 3.3, reach: 0.9,  windup: ticks(0.26), cooldown: ticks(0.65), knockback: 2.5, xp: 5,  color: 0x8fb36a },
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
}

export interface Projectile {
  id: string
  ownerId: string
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
  | { t: 'swing'; id: string; x: number; y: number; aim: number; reach: number; halfArc: number }
  | { t: 'hit'; from: string; to: string; dmg: number; x: number; y: number }
  | { t: 'blast'; x: number; y: number; radius: number }
  | { t: 'death'; id: string; kind: Actor['kind']; x: number; y: number }
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
