/**
 * Pack de sprites Pixel Crawler (Anokolisa) — chargement et découpage.
 *
 * Tout est optionnel : si les feuilles manquent (dépôt cloné sans les assets),
 * `loadPack()` rend false et le jeu retombe sur l'atlas procédural — il reste
 * jouable partout, juste moins beau. La correspondance espèce → fichiers est
 * produite par `scripts/pack-assets.py`, seule vérité sur le contenu du pack.
 *
 * Convention des feuilles : cadres carrés, côté = hauteur de l'image, animation
 * de gauche à droite. Les cadres d'une même espèce changent de taille selon
 * l'animation (idle 32 px, course 64 px chez les mobs) mais **les pieds
 * touchent toujours le bord bas du cadre** : c'est l'invariant d'alignement.
 * Le rendu ancre donc les personnages aux pieds — jamais au centre, sinon le
 * corps saute de plusieurs pixels à chaque changement d'animation.
 * Exception : la chauve-souris vole, ses cadres sont centrés.
 */
import { Assets, Rectangle, Texture } from 'pixi.js'
import { Tile, isWalkable } from '@dc/engine'

export type Dir = 'down' | 'side' | 'up'
export type AttackKind = 'slice' | 'pierce' | 'crush'

/**
 * Un jeu d'animations. Toutes les listes sont indexées par direction pour que
 * le rendu n'ait qu'un chemin ; les mobs, dessinés de côté et retournés selon
 * la visée, répètent la même feuille sur les trois directions.
 */
export interface AnimSet {
  idle: Record<Dir, Texture[]>
  run: Record<Dir, Texture[]>
  /** Jouée une fois à la mort, puis le sprite disparaît. Vue de côté. */
  death?: Texture[]
  /** Héros uniquement : le geste d'arme, arc de coup inclus dans les cadres. */
  attack?: Record<AttackKind, Record<Dir, Texture[]>>
  /** Ancré aux pieds (marcheurs) ou au centre (volants). */
  grounded: boolean
}

const BASE = '/assets/pack/'

/** Espèces couvertes par le pack. Le kamikaze garde son sprite maison : une
 * bombe ronde reste plus lisible que n'importe quel monstre à pattes. */
const MOBS = [
  'skeleton',
  'skeleton_warrior',
  'skeleton_mage',
  'skeleton_rogue',
  'orc',
  'orc_warrior',
  'orc_mage',
  'orc_rogue',
  'bat',
]

const DIRS: Dir[] = ['down', 'side', 'up']
const ATTACKS: AttackKind[] = ['slice', 'pierce', 'crush']

/** Arme du joueur → geste du héros. L'arc n'a pas de geste : la flèche qui
 * part est déjà toute la lisibilité nécessaire. */
export const WEAPON_ATTACK: Record<string, AttackKind> = {
  sword: 'slice',
  axe: 'crush',
  dagger: 'pierce',
  spear: 'pierce',
}

const sets = new Map<string, AnimSet>()
let tileSheet: HTMLImageElement | null = null
let ready = false

function slice(sheet: Texture): Texture[] {
  const side = sheet.height
  const count = Math.max(1, Math.floor(sheet.width / side))
  const frames: Texture[] = []
  for (let i = 0; i < count; i++) {
    frames.push(
      new Texture({ source: sheet.source, frame: new Rectangle(i * side, 0, side, side) }),
    )
  }
  return frames
}

async function sheet(name: string): Promise<Texture[]> {
  const tex = await Assets.load<Texture>(`${BASE}${name}.png`)
  tex.source.scaleMode = 'nearest'
  return slice(tex)
}

const allDirs = (frames: Texture[]): Record<Dir, Texture[]> => ({
  down: frames,
  side: frames,
  up: frames,
})

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })
}

/** Charge toutes les feuilles. Rend false si le pack n'est pas là — sans bruit. */
export async function loadPack(): Promise<boolean> {
  try {
    tileSheet = await loadImage(`${BASE}tiles.png`)
    for (const sp of MOBS) {
      const [idle, run, death] = await Promise.all([
        sheet(`${sp}_idle`),
        sheet(`${sp}_run`),
        sheet(`${sp}_death`),
      ])
      sets.set(sp, { idle: allDirs(idle), run: allDirs(run), death, grounded: sp !== 'bat' })
    }

    const hero: AnimSet = {
      idle: { down: [], side: [], up: [] },
      run: { down: [], side: [], up: [] },
      attack: {
        slice: { down: [], side: [], up: [] },
        pierce: { down: [], side: [], up: [] },
        crush: { down: [], side: [], up: [] },
      },
      grounded: true,
    }
    for (const d of DIRS) {
      hero.idle[d] = await sheet(`hero_idle_${d}`)
      hero.run[d] = await sheet(`hero_run_${d}`)
      for (const a of ATTACKS) hero.attack![a][d] = await sheet(`hero_${a}_${d}`)
    }
    sets.set('hero', hero)

    ready = true
    return true
  } catch (err) {
    // Repli silencieux pour le joueur, mais traçable pour le développeur.
    console.warn('pack de sprites indisponible, atlas procédural utilisé', err)
    sets.clear()
    tileSheet = null
    return false
  }
}

export function packAnim(species: string, isPlayer: boolean): AnimSet | null {
  if (!ready) return null
  return sets.get(isPlayer ? 'hero' : species) ?? null
}

// --- Tuiles du donjon ---------------------------------------------------------

/** Coordonnées (col, ligne) dans la feuille Dungeon_Tiles, cases de 16 px. */
const T = 16
/** Dalles de sol, au centre de la grande zone dallée de la feuille. */
const FLOOR_TILES = [[5, 1], [6, 1], [7, 1], [5, 2], [6, 2], [4, 1]] as const
/** Mêmes dalles, rangée du haut : ombrées, posées au contact d'un mur. */
const FLOOR_SHADED = [[5, 0], [6, 0], [7, 0]] as const
/** Tranches de brique du mur, trois variantes. */
const WALL_FACES = [[0, 1], [1, 1], [2, 1]] as const
/** Dessus des blocs : le noir bleuté du haut de la feuille. */
const WALL_TOP = '#0b0d13'

/**
 * Peint sols et murs depuis la feuille du pack. Contrairement au peintre
 * procédural, celui-ci regarde les voisins : un mur montre sa tranche de
 * brique quand une case praticable le longe par le bas, un sol prend sa
 * variante ombrée sous un mur — c'est cette ombre de contact qui donne du
 * relief à la pièce. Portes et escaliers restent au peintre procédural.
 * Rend faux si la tuile n'est pas prise en charge (ou pack absent).
 */
export function paintPackTile(
  ctx: CanvasRenderingContext2D,
  tiles: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): boolean {
  if (!ready || !tileSheet) return false
  const tile = tiles[y * width + x]!
  const h = (x * 7 + y * 13 + ((x * 31) ^ (y * 17))) & 0x7fffffff

  const blit = (src: readonly [number, number] | readonly number[]) =>
    ctx.drawImage(tileSheet!, src[0]! * T, src[1]! * T, T, T, x * T, y * T, T, T)

  if (tile === Tile.Floor) {
    const shaded = y > 0 && tiles[(y - 1) * width + x] === Tile.Wall
    const pool = shaded ? FLOOR_SHADED : FLOOR_TILES
    blit(pool[h % pool.length]!)
    return true
  }
  if (tile === Tile.Wall) {
    const below = y + 1 < height ? tiles[(y + 1) * width + x]! : Tile.Wall
    if (isWalkable(below)) {
      blit(WALL_FACES[h % WALL_FACES.length]!)
    } else {
      ctx.fillStyle = WALL_TOP
      ctx.fillRect(x * T, y * T, T, T)
    }
    return true
  }
  return false
}
