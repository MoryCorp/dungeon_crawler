/**
 * Types et constantes partagés client <-> serveur.
 *
 * Le jeu tourne sur une horloge à ticks (pas de tour par tour) : chaque acteur
 * agit dès que son cooldown est écoulé. Personne n'attend personne.
 */

export const TICK_RATE = 15
export const TICK_MS = 1000 / TICK_RATE

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

/** Les murs bloquent la vue ; le reste non. */
export function blocksSight(t: number): boolean {
  return t === Tile.Wall
}

export type Dir = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW'

export const DIR_VEC = {
  N: [0, -1],
  NE: [1, -1],
  E: [1, 0],
  SE: [1, 1],
  S: [0, 1],
  SW: [-1, 1],
  W: [-1, 0],
  NW: [-1, -1],
} as const satisfies Record<Dir, readonly [number, number]>

export const DIRS = Object.keys(DIR_VEC) as Dir[]

/** Coûts d'action, exprimés en ticks. C'est ici qu'on règle le "game feel". */
export const COST = {
  playerMove: 2, // ~133 ms
  playerAttack: 6, // ~400 ms
} as const

export const FOV_RADIUS = 9
export const AGGRO_MEMORY = 45 // ticks (~3 s) pendant lesquels un monstre poursuit après avoir perdu la vue
export const AGGRO_MAX_DIST = 14
export const RESPAWN_TICKS = TICK_RATE * 8
export const MAP_W = 64
export const MAP_H = 64

export interface SpeciesDef {
  label: string
  maxHp: number
  atk: number
  moveCost: number
  attackCost: number
  /** Couleur du placeholder tant qu'on n'a pas branché les sprites. */
  color: number
}

/** Noms alignés sur le pack Pixel Crawler (skeleton/orc x base/warrior/mage/rogue). */
export const MONSTERS: Record<string, SpeciesDef> = {
  skeleton: { label: 'Squelette', maxHp: 12, atk: 3, moveCost: 4, attackCost: 9, color: 0xd8d8c0 },
  skeleton_warrior: { label: 'Squelette guerrier', maxHp: 20, atk: 5, moveCost: 5, attackCost: 10, color: 0xbfc4a8 },
  skeleton_rogue: { label: 'Squelette rôdeur', maxHp: 10, atk: 4, moveCost: 2, attackCost: 7, color: 0xa8c4bf },
  skeleton_mage: { label: 'Squelette mage', maxHp: 9, atk: 6, moveCost: 5, attackCost: 12, color: 0xc0a8d8 },
  orc: { label: 'Orc', maxHp: 18, atk: 4, moveCost: 4, attackCost: 9, color: 0x7ba05b },
  orc_warrior: { label: 'Orc guerrier', maxHp: 28, atk: 7, moveCost: 5, attackCost: 11, color: 0x5f8a44 },
  orc_rogue: { label: 'Orc rôdeur', maxHp: 14, atk: 5, moveCost: 3, attackCost: 7, color: 0x8fb36a },
  orc_mage: { label: 'Orc mage', maxHp: 12, atk: 8, moveCost: 5, attackCost: 13, color: 0x9b8a5f },
}

export const PLAYER_MAX_HP = 40
export const PLAYER_ATK = 6

export interface Actor {
  id: string
  kind: 'player' | 'monster'
  species: string
  name: string
  x: number
  y: number
  hp: number
  maxHp: number
  atk: number
  facing: Dir
  /** Tick à partir duquel l'acteur peut agir de nouveau. */
  readyAt: number
  alive: boolean
  /** Monstres : tick jusqu'auquel il poursuit sans voir sa cible. */
  aggroUntil?: number
  /** Joueurs : tick auquel il réapparaît. */
  respawnAt?: number
}

export type Intent =
  | { type: 'move'; dir: Dir }
  | { type: 'attack'; dir: Dir }
  | { type: 'wait' }

export type GameEvent =
  | { t: 'hit'; from: string; to: string; dmg: number; x: number; y: number }
  | { t: 'death'; id: string; kind: Actor['kind']; x: number; y: number }
  | { t: 'respawn'; id: string; x: number; y: number }
  | { t: 'descend'; floor: number }

export interface GameState {
  tick: number
  floor: number
  seed: number
  /** État interne du PRNG — sérialisé avec la partie pour rester déterministe. */
  rng: number
  width: number
  height: number
  tiles: Uint8Array
  actors: Record<string, Actor>
  stairs: { x: number; y: number }
  spawn: { x: number; y: number }
  /** Vidés à chaque tick, diffusés aux clients pour le feedback (dégâts, sons). */
  events: GameEvent[]
}
