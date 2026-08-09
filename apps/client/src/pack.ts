/**
 * Pack de sprites Pixel Crawler (Anokolisa) — chargement et découpage.
 *
 * Tout est optionnel : si les feuilles manquent (dépôt cloné sans les assets),
 * `loadPack()` rend false et le jeu retombe sur l'atlas procédural — il reste
 * jouable partout, juste moins beau. La correspondance espèce → fichiers est
 * produite par `scripts/pack-assets.py`, seule vérité sur le contenu du pack.
 *
 * Les cadres s'enchaînent de gauche à droite, mais leur largeur ne se devine
 * pas : les animations de mort où le corps s'effondre en travers sont plus
 * larges que hautes. Le nombre de cadres vient de `manifest.json`, mesuré à la
 * copie ; sans lui, rien n'est chargé — un découpage faux vaut moins que le
 * repli procédural.
 *
 * Les cadres d'une même espèce changent de taille selon l'animation (idle
 * 32 px, course 64 px chez les mobs) mais **les pieds touchent toujours le bord
 * bas du cadre** : c'est l'invariant d'alignement. Le rendu ancre donc les
 * personnages aux pieds — jamais au centre, sinon le corps saute de plusieurs
 * pixels à chaque changement d'animation. Exception : la chauve-souris vole,
 * ses cadres sont centrés.
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
  // La garde royale du Château — même liste que CREWS dans pack-assets.py,
  // qui reste la seule vérité sur la provenance des feuilles.
  'soldat',
  'archer_royal',
  'pretre',
  'chevalier',
  // Le Gardien de pierre, boss d'arène — le golem du pack Forge, nulle part
  // ailleurs dans le donjon.
  'gardien',
]

const DIRS: Dir[] = ['down', 'side', 'up']
const ATTACKS: AttackKind[] = ['slice', 'pierce', 'crush']

/**
 * Arme du joueur → geste du héros.
 *
 * Le Chasseur n'a que trois gestes, et l'outil y est peint : une épée dans
 * l'estoc, un couperet dans la taille, une pioche dans l'écrasement. On avait
 * d'abord réservé le geste aux deux armes dont l'outil correspond, pour ne pas
 * mentir sur ce qu'on tient. Manette en main, c'était le mauvais arbitrage : à
 * la dague on frappait sans que rien ne bouge, et un personnage figé au milieu
 * d'un combat se lit comme un bug, pas comme une nuance.
 *
 * Donc les armes d'estoc prennent l'estoc — la lame dessinée est trop longue
 * pour une dague et trop courte pour une lance, à 64 px et en mouvement ça ne
 * se voit pas. L'arc reste à part : bander une corde ne ressemble à aucun des
 * trois, et la flèche qui part suffit à dire que le coup est parti.
 */
export const WEAPON_ATTACK: Record<string, AttackKind> = {
  sword: 'pierce',
  dagger: 'pierce',
  spear: 'pierce',
  axe: 'slice',
}

const sets = new Map<string, AnimSet>()
const items = new Map<string, Texture>()
/** Une feuille de tuiles par biome — 'cachot' est la feuille historique. */
const tileSheets = new Map<string, HTMLImageElement>()
let npcMarchand: HTMLImageElement | null = null
let ready = false

/** Nombre de cadres par feuille, mesuré à la copie. */
let manifest: Record<string, number> = {}

function slice(name: string, sheet: Texture): Texture[] {
  const count = Math.max(1, manifest[name] ?? Math.floor(sheet.width / sheet.height))
  const w = Math.floor(sheet.width / count)
  const frames: Texture[] = []
  for (let i = 0; i < count; i++) {
    frames.push(
      new Texture({ source: sheet.source, frame: new Rectangle(i * w, 0, w, sheet.height) }),
    )
  }
  return frames
}

async function sheet(name: string): Promise<Texture[]> {
  const tex = await Assets.load<Texture>(`${BASE}${name}.png`)
  tex.source.scaleMode = 'nearest'
  return slice(name, tex)
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
    const res = await fetch(`${BASE}manifest.json`)
    if (!res.ok) throw new Error(`manifest ${res.status}`)
    manifest = (await res.json()) as Record<string, number>

    tileSheets.set('cachot', await loadImage(`${BASE}tiles.png`))
    // Les feuilles des autres biomes sont facultatives une à une : un biome
    // absent retombe sur le thème cachot sans faire tomber tout le pack.
    for (const biome of Object.keys(THEMES)) {
      if (biome === 'cachot') continue
      try {
        tileSheets.set(biome, await loadImage(`${BASE}tiles_${biome}.png`))
      } catch {
        console.warn(`tuiles du biome ${biome} indisponibles, thème cachot utilisé`)
      }
    }
    try {
      npcMarchand = await loadImage(`${BASE}npc_marchand.png`)
    } catch {
      npcMarchand = null
    }
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

    for (const weapon of Object.keys(WEAPON_ICONS)) {
      const tex = await Assets.load<Texture>(`${BASE}weapon_${weapon}.png`)
      tex.source.scaleMode = 'nearest'
      items.set(weapon, tex)
    }

    ready = true
    return true
  } catch (err) {
    // Repli silencieux pour le joueur, mais traçable pour le développeur.
    console.warn('pack de sprites indisponible, atlas procédural utilisé', err)
    sets.clear()
    items.clear()
    tileSheets.clear()
    npcMarchand = null
    return false
  }
}

/** Le pack est-il chargé ? Le rendu adapte ses replis procéduraux. */
export function packReady(): boolean {
  return ready
}

export function packAnim(species: string, isPlayer: boolean): AnimSet | null {
  if (!ready) return null
  return sets.get(isPlayer ? 'hero' : species) ?? null
}

/** Armes dont le pack fournit l'icône au sol. */
const WEAPON_ICONS: Record<string, true> = {
  sword: true,
  dagger: true,
  axe: true,
  spear: true,
  bow: true,
}

/** L'arme posée au sol, dans le même acier que celle qu'on aura en main. */
export function packItemTexture(weapon: string | undefined): Texture | null {
  if (!ready || !weapon) return null
  return items.get(weapon) ?? null
}

// --- Tuiles du donjon ---------------------------------------------------------

/** Cases de 16 px dans toutes les feuilles de tuiles. */
const T = 16

/**
 * Le thème d'un biome : où piocher, dans sa feuille, les dalles de sol, leurs
 * variantes ombrées (posées au contact d'un mur), les tranches de brique des
 * murs, et la couleur du dessus des blocs. `floorShaded` vide signifie que la
 * feuille n'a pas de rangée ombrée dédiée : l'ombre de contact est alors un
 * voile peint par-dessus la dalle normale — même relief, autre technique.
 */
interface TileTheme {
  floor: readonly (readonly [number, number])[]
  floorShaded: readonly (readonly [number, number])[]
  wallFaces: readonly (readonly [number, number])[]
  wallTop: string
  /**
   * Sol en motif continu : un bloc répétable posé en coordonnées absolues,
   * qui remplace le tirage tuile à tuile de `floor` — c'est ce qu'exige un
   * tapis à losanges, où le motif traverse les tuiles. L'ombre de contact
   * devient un voile peint par-dessus.
   */
  floorPattern?: { ox: number; oy: number; pw: number; ph: number }
  /**
   * Corniche : posée dans la tuile de mur juste au-dessus d'une tranche —
   * c'est elle qui donne l'épaisseur des murs des maquettes du pack, la
   * tranche seule ressemble à une plinthe.
   */
  cornice?: readonly (readonly [number, number])[]
  /**
   * Matériaux de salle : des blocs répétables de la feuille (origine + période
   * en cases), posés en coordonnées absolues pour que le motif continue d'une
   * tuile à l'autre. Chaque salle en tire un au hasard de sa géométrie — les
   * couloirs restent sur `floor`. Vide : les salles gardent le sol commun.
   */
  materials?: readonly { ox: number; oy: number; pw: number; ph: number }[]
  /**
   * Le tapis d'apparat des salles de repos et du SAS : même format qu'un
   * matériau, plus un liseré peint par-dessus (la bordure dorée de la feuille
   * n'est pas alignée sur la grille, on la redessine).
   */
  sanctuary?: { ox: number; oy: number; pw: number; ph: number; trim: string }
}

const THEMES: Record<string, TileTheme> = {
  // Dungeon_Tiles : dalles au centre de la grande zone dallée, rangée du haut
  // ombrée, tranches de brique, noir bleuté du haut de la feuille.
  cachot: {
    floor: [[5, 1], [6, 1], [7, 1], [5, 2], [6, 2], [4, 1]],
    floorShaded: [[5, 0], [6, 0], [7, 0]],
    wallFaces: [[0, 1], [1, 1], [2, 1]],
    wallTop: '#0b0d13',
  },
  // Tiles château, calé sur les maquettes du pack (Social/MockUp_0*.png) :
  // sol commun = tapis navy à losanges, murs = panneaux crème surmontés de la
  // corniche à denticules, et le navy-violet du fond des maquettes en dessus
  // de bloc — la corniche s'y fond, les murs prennent de l'épaisseur.
  chateau: {
    floor: [[5, 12], [4, 11], [5, 11], [6, 11], [4, 12], [6, 12]],
    floorShaded: [],
    floorPattern: { ox: 15, oy: 17, pw: 3, ph: 3 },
    wallFaces: [[1, 6], [2, 6], [3, 6]],
    cornice: [[4, 3], [5, 3], [6, 3]],
    wallTop: '#1c172c',
    // Les dalles kaki et le tapis gris de la feuille sont écartés : posés en
    // grand, ils éteignent tout (vu sur maquette) — et le kaki est la couleur
    // des murs, un sol assorti brouille la lecture.
    materials: [
      { ox: 6, oy: 17, pw: 3, ph: 2 },   // parquet chaud
      { ox: 12, oy: 17, pw: 3, ph: 3 },  // tapis à losanges bleu-violet
      { ox: 15, oy: 17, pw: 3, ph: 3 },  // le sol commun — continuité avec le couloir
    ],
    sanctuary: { ox: 19, oy: 18, pw: 1, ph: 1, trim: '#d69000' },
  },
  // Tiles jardin (Garden Environment), calé sur Social/MockUp_01 : herbe
  // sombre en sol, murs = haies vert clair (la tranche vive coiffée du bord
  // supérieur, comme la corniche du château), et le tapis de fleurs roses de
  // la feuille en sol de sanctuaire — le SAS est la seule salle du biome,
  // c'est lui qui doit être chatoyant.
  jardin: {
    floor: [[2, 2], [3, 2], [4, 2], [2, 3], [3, 3], [4, 3]],
    floorShaded: [],
    wallFaces: [[4, 13], [5, 13], [6, 13]],
    cornice: [[4, 12], [5, 12], [6, 12]],
    wallTop: '#141a0e',
    sanctuary: { ox: 0, oy: 25, pw: 3, ph: 3, trim: '#e8dcc0' },
  },
}

/**
 * Peint sols et murs depuis la feuille du biome. Contrairement au peintre
 * procédural, celui-ci regarde les voisins : un mur montre sa tranche de
 * brique quand une case praticable le longe par le bas, un sol prend sa
 * variante ombrée sous un mur — c'est cette ombre de contact qui donne du
 * relief à la pièce. Portes, escaliers et grilles reçoivent la dalle de sol
 * du biome en fond, puis rendent faux : leur glyphe reste au peintre
 * procédural (voir paintTile, mode overlay). Rend faux si la tuile n'est pas
 * prise en charge (ou pack absent).
 */
export function paintPackTile(
  ctx: CanvasRenderingContext2D,
  tiles: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  biome = 'cachot',
): boolean {
  const sheet = tileSheets.get(biome) ?? tileSheets.get('cachot')
  const theme = (tileSheets.has(biome) ? THEMES[biome] : undefined) ?? THEMES.cachot!
  if (!ready || !sheet) return false
  const tile = tiles[y * width + x]!
  const h = (x * 7 + y * 13 + ((x * 31) ^ (y * 17))) & 0x7fffffff

  const blit = (src: readonly [number, number]) =>
    ctx.drawImage(sheet, src[0] * T, src[1] * T, T, T, x * T, y * T, T, T)

  const paintFloor = () => {
    const shaded = y > 0 && tiles[(y - 1) * width + x] === Tile.Wall
    if (theme.floorPattern) {
      const p = theme.floorPattern
      ctx.drawImage(sheet, (p.ox + (x % p.pw)) * T, (p.oy + (y % p.ph)) * T, T, T, x * T, y * T, T, T)
      if (shaded) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.22)'
        ctx.fillRect(x * T, y * T, T, T)
      }
      return
    }
    if (shaded && theme.floorShaded.length > 0) {
      blit(theme.floorShaded[h % theme.floorShaded.length]!)
      return
    }
    blit(theme.floor[h % theme.floor.length]!)
    if (shaded) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)'
      ctx.fillRect(x * T, y * T, T, T)
    }
  }

  if (tile === Tile.Floor) {
    paintFloor()
    return true
  }
  if (tile === Tile.Wall) {
    const below = y + 1 < height ? tiles[(y + 1) * width + x]! : Tile.Wall
    if (isWalkable(below)) {
      blit(theme.wallFaces[h % theme.wallFaces.length]!)
      // La corniche coiffe la tranche : peinte dans la tuile du dessus, déjà
      // remplie en dessus-de-bloc par le balayage (il descend ligne à ligne).
      if (theme.cornice && y > 0 && tiles[(y - 1) * width + x] === Tile.Wall) {
        const c = theme.cornice[h % theme.cornice.length]!
        ctx.drawImage(sheet, c[0] * T, c[1] * T, T, T, x * T, (y - 1) * T, T, T)
      }
    } else {
      ctx.fillStyle = theme.wallTop
      ctx.fillRect(x * T, y * T, T, T)
    }
    return true
  }
  // Porte, escalier, grille : le fond prend la dalle du biome pour que le
  // glyphe procédural ne traîne plus les couleurs du cachot dans le Château.
  paintFloor()
  return false
}

/** Le marchand du SAS, cuit dans la carte par le rendu. Null sans pack. */
export function packNpcImage(): HTMLImageElement | null {
  return ready ? npcMarchand : null
}

/**
 * Habille chaque salle de son matériau : parquet, tapis, ou le sol commun.
 * Ce qui fait un château plutôt qu'une grotte, c'est que les pièces sont
 * meublées — un donjon d'un seul sol se lit comme un labyrinthe de pierre.
 * Le matériau se tire de la géométrie de la salle (stable d'une visite à
 * l'autre), le motif se pose en coordonnées absolues pour rester continu.
 * Les salles de repos et le SAS reçoivent le tapis d'apparat, liseré doré
 * compris. Les couloirs ne sont pas touchés. Sans pack ni matériaux : no-op.
 */
export function paintRoomFloors(
  ctx: CanvasRenderingContext2D,
  tiles: Uint8Array,
  width: number,
  height: number,
  rooms: readonly { x: number; y: number; w: number; h: number; kind: string }[],
  biome: string,
): void {
  const sheet = tileSheets.get(biome)
  const theme = THEMES[biome]
  if (!ready || !sheet || !theme?.materials?.length) return

  const blitPattern = (
    mat: { ox: number; oy: number; pw: number; ph: number },
    x: number,
    y: number,
  ) => {
    const sx = (mat.ox + (x % mat.pw)) * T
    const sy = (mat.oy + (y % mat.ph)) * T
    ctx.drawImage(sheet, sx, sy, T, T, x * T, y * T, T, T)
    // L'ombre de contact sous les murs vaut pour tous les matériaux : c'est
    // elle qui donne le relief, pas la couleur du sol.
    if (y > 0 && tiles[(y - 1) * width + x] === Tile.Wall) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)'
      ctx.fillRect(x * T, y * T, T, T)
    }
  }

  for (const room of rooms) {
    const sanctuary = room.kind === 'repos' && theme.sanctuary
    const h =
      (Math.imul(room.x * 53 + room.y * 97, 2654435761) ^ (room.w * 31 + room.h * 7)) >>> 0
    const mat = sanctuary ? theme.sanctuary! : theme.materials[h % theme.materials.length]!
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        if (tiles[y * width + x] !== Tile.Floor) continue
        blitPattern(mat, x, y)
      }
    }
    if (sanctuary) {
      // Le liseré doré, redessiné : la bordure de la feuille n'est pas
      // alignée sur la grille de 16. Deux pixels, en retrait d'un pixel.
      ctx.strokeStyle = theme.sanctuary!.trim
      ctx.lineWidth = 2
      ctx.strokeRect(room.x * T + 2, room.y * T + 2, room.w * T - 4, room.h * T - 4)
    }
  }
}
