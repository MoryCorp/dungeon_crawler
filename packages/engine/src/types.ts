/**
 * Types et constantes partagés client <-> serveur.
 *
 * Le monde est fait de tuiles, mais les acteurs s'y déplacent en coordonnées
 * continues (comme Necesse) : positions flottantes exprimées en tuiles, 1.0 =
 * une tuile. La grille ne sert plus qu'aux murs, au pathfinding et au champ de
 * vision — jamais à contraindre un déplacement.
 *
 * La visée est un angle libre (souris ou stick droit), et les attaques frappent
 * un arc devant le personnage. Plus aucune notion de "case ciblée".
 */

export const TICK_RATE = 30
export const TICK_MS = 1000 / TICK_RATE
export const DT = 1 / TICK_RATE

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
export const PLAYER_SPEED = 4.2 // tuiles/seconde
/** Décroissance exponentielle du recul, par seconde. */
export const KNOCKBACK_DECAY = 9

// --- Combat -----------------------------------------------------------------

/** Portée du coup d'épée, mesurée depuis le centre du personnage. */
export const ATTACK_REACH = 1.45
/** Demi-angle de l'arc touché, en radians (±55° = 110° au total). */
export const ATTACK_HALF_ARC = (55 * Math.PI) / 180
export const ATTACK_COOLDOWN = Math.round(0.42 * TICK_RATE)
/** Durée visuelle du swing, pendant laquelle l'arc est affiché. */
export const ATTACK_SWING = Math.round(0.18 * TICK_RATE)
export const ATTACK_KNOCKBACK = 7.5
/** Demi-angle des coups de monstre : plus étroit que celui du joueur, donc esquivable. */
export const MONSTER_HALF_ARC = (45 * Math.PI) / 180

export const FOV_RADIUS = 9
export const AGGRO_MEMORY = TICK_RATE * 3
export const AGGRO_MAX_DIST = 14
export const RESPAWN_TICKS = TICK_RATE * 8
/** Invulnérabilité après réapparition : évite de mourir en boucle sur un camper. */
export const RESPAWN_GRACE = TICK_RATE * 2

export interface SpeciesDef {
  label: string
  maxHp: number
  atk: number
  speed: number
  /** Distance à laquelle il déclenche son attaque. */
  reach: number
  /** Temps de préparation avant que le coup parte : c'est la fenêtre d'esquive. */
  windup: number
  cooldown: number
  knockback: number
  color: number
}

const windup = (seconds: number) => Math.round(seconds * TICK_RATE)

/**
 * Noms alignés sur le pack Pixel Crawler.
 *
 * Chaque monstre télégraphie son coup : le `windup` est le temps pendant lequel
 * il est immobile et visible avant de frapper. Sans ça on prend des dégâts sans
 * avoir rien pu faire, ce qui est la définition d'un coup gratuit.
 */
export const MONSTERS: Record<string, SpeciesDef> = {
  skeleton:         { label: 'Squelette',          maxHp: 12, atk: 3, speed: 2.2, reach: 1.0, windup: windup(0.40), cooldown: windup(0.9), knockback: 3.5, color: 0xd8d8c0 },
  skeleton_warrior: { label: 'Squelette guerrier', maxHp: 20, atk: 5, speed: 1.9, reach: 1.1, windup: windup(0.55), cooldown: windup(1.1), knockback: 5.5, color: 0xbfc4a8 },
  skeleton_rogue:   { label: 'Squelette rôdeur',   maxHp: 10, atk: 4, speed: 3.1, reach: 0.9, windup: windup(0.28), cooldown: windup(0.7), knockback: 2.5, color: 0xa8c4bf },
  skeleton_mage:    { label: 'Squelette mage',     maxHp: 9,  atk: 6, speed: 1.7, reach: 1.2, windup: windup(0.70), cooldown: windup(1.4), knockback: 4.0, color: 0xc0a8d8 },
  orc:              { label: 'Orc',                maxHp: 18, atk: 4, speed: 2.4, reach: 1.05, windup: windup(0.45), cooldown: windup(1.0), knockback: 4.5, color: 0x7ba05b },
  orc_warrior:      { label: 'Orc guerrier',       maxHp: 28, atk: 7, speed: 2.0, reach: 1.2, windup: windup(0.65), cooldown: windup(1.2), knockback: 7.0, color: 0x5f8a44 },
  orc_rogue:        { label: 'Orc rôdeur',         maxHp: 14, atk: 5, speed: 3.3, reach: 0.9, windup: windup(0.30), cooldown: windup(0.65), knockback: 3.0, color: 0x8fb36a },
  orc_mage:         { label: 'Orc mage',           maxHp: 12, atk: 8, speed: 1.6, reach: 1.3, windup: windup(0.80), cooldown: windup(1.5), knockback: 5.0, color: 0x9b8a5f },
}

export const PLAYER_MAX_HP = 40
export const PLAYER_ATK = 6

export interface Actor {
  id: string
  kind: 'player' | 'monster'
  species: string
  name: string
  /** Position continue, en tuiles. */
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
  /** Tick jusqu'auquel le swing est visible (0 = pas d'attaque en cours). */
  swingUntil: number
  /** Tick à partir duquel il peut attaquer de nouveau. */
  readyAt: number
  /** Monstres : tick auquel le coup préparé part. 0 = pas de préparation en cours. */
  windupUntil?: number
  aggroUntil?: number
  respawnAt?: number
  /** Tick jusqu'auquel l'acteur ne peut pas être blessé. */
  invulnUntil?: number
}

/**
 * Entrée d'un joueur. Contrairement au système précédent, c'est un état continu
 * réémis régulièrement, pas un ordre discret.
 */
export interface PlayerInput {
  /** Vecteur de déplacement, non normalisé (le moteur s'en charge). */
  mx: number
  my: number
  /** Angle de visée en radians. */
  aim: number
  attack: boolean
}

export const NEUTRAL_INPUT: PlayerInput = { mx: 0, my: 0, aim: 0, attack: false }

export type GameEvent =
  | { t: 'swing'; id: string; x: number; y: number; aim: number }
  | { t: 'hit'; from: string; to: string; dmg: number; x: number; y: number }
  | { t: 'windup'; id: string; x: number; y: number; aim: number }
  | { t: 'death'; id: string; kind: Actor['kind']; x: number; y: number }
  | { t: 'respawn'; id: string; x: number; y: number }
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
  stairs: { x: number; y: number }
  spawn: { x: number; y: number }
  events: GameEvent[]
}
