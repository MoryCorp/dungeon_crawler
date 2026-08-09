/**
 * Textures du jeu — pixel art « maison », généré au chargement.
 *
 * Tout est dessiné en code, aucun fichier à télécharger : chaque sprite est une
 * matrice de caractères 16×16 et une petite palette. C'est un choix, pas un
 * pis-aller — le jeu garde une identité à lui plutôt que le tileset qu'on a vu
 * dans cent jeux, l'ensemble pèse zéro octet de plus, et modifier un monstre
 * se fait dans ce fichier au même titre qu'une statistique dans `types.ts`.
 *
 * Conventions des matrices : `.` = transparent, chaque autre caractère pointe
 * dans la palette du sprite. Les silhouettes tiennent dans les rangées 2-13,
 * pieds vers le bas — l'ombre est ajoutée séparément, et le retournement
 * gauche/droite est fait par le rendu selon la visée.
 */
import { CanvasSource, Texture } from 'pixi.js'
import { Tile, WEAPONS, type ItemKind } from '@dc/engine'

/** Taille d'une tuile en pixels source. */
export const TILE = 16
/** Facteur d'agrandissement. Entier obligatoire, sinon les pixels bavent. */
export const SCALE = 3

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

export function nearestTexture(canvas: HTMLCanvasElement): Texture {
  const source = new CanvasSource({ resource: canvas, scaleMode: 'nearest' })
  return new Texture({ source })
}

type Palette = Record<string, string>

/** Peint une matrice de pixels dans un contexte, à l'échelle 1 pixel = 1 case. */
function paint(ctx: CanvasRenderingContext2D, rows: string[], palette: Palette, ox = 0, oy = 0): void {
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]!
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!
      if (ch === '.') continue
      const color = palette[ch]
      if (!color) continue
      ctx.fillStyle = color
      ctx.fillRect(ox + x, oy + y, 1, 1)
    }
  }
}

// --- Palettes partagées -------------------------------------------------------

/** Contour commun : plus sombre que n'importe quel aplat, jamais noir pur. */
const OUT = '#131521'

const BONE: Palette = {
  o: OUT,
  w: '#e8e2d0', // os
  s: '#b5ad96', // os ombré
  k: '#22242e', // orbites
}

const ORC: Palette = {
  o: OUT,
  g: '#5d9048', // peau
  d: '#3e6832', // peau ombrée
  t: '#e8e2d0', // défenses
  r: '#d9524a', // yeux
  b: '#2e2331', // cuir
}

// --- Acteurs ------------------------------------------------------------------

interface SpriteDef {
  rows: string[]
  palette: Palette
}

const HERO: SpriteDef = {
  palette: {
    o: OUT,
    h: '#6b4a2f', // cheveux
    f: '#e8b88a', // peau
    e: '#22242e', // yeux
    t: '#3f6fa8', // tunique
    l: '#5b8fc9', // tunique éclairée
    c: '#7a5230', // ceinture
    m: '#4a3524', // bottes
  },
  rows: [
    '................',
    '................',
    '.....oooooo.....',
    '....ohhhhhho....',
    '....ohffffho....',
    '....offeffeo....',
    '....offffffo....',
    '.....offffo.....',
    '....oolllloo....',
    '...ofotltltfo...',
    '...ofottttofo...',
    '....ooccccoo....',
    '.....ott.to.....',
    '.....omo.omo....',
    '................',
    '................',
  ],
}

const ACTORS: Record<string, SpriteDef> = {
  hero: HERO,

  skeleton: {
    palette: BONE,
    rows: [
      '................',
      '................',
      '.....oooo.......',
      '....owwwwo......',
      '....okwkwo......',
      '....owwwwo......',
      '.....osso.......',
      '....owwwwoo.....',
      '...oswswswo.....',
      '....owwwwo......',
      '.....osso.......',
      '....oww.wo......',
      '....ows.so......',
      '...oww..wwo.....',
      '................',
      '................',
    ],
  },

  skeleton_warrior: {
    palette: { ...BONE, a: '#8a93a8', h: '#5d6578', r: '#a83a3a' },
    rows: [
      '................',
      '.....ohhho......',
      '....ohhhhho.....',
      '....owwwwo.aa...',
      '....okwkwo.oa...',
      '....owwwwo.oa...',
      '.....osso..aa...',
      '....oaaaaoaao...',
      '...osaraaoaao...',
      '....oaaaao.a....',
      '.....osso.......',
      '....oww.wo......',
      '....ows.so......',
      '...oww..wwo.....',
      '................',
      '................',
    ],
  },

  skeleton_mage: {
    palette: { ...BONE, p: '#6a4a8f', q: '#8a63b5', y: '#c9a84a' },
    rows: [
      '................',
      '......oo........',
      '.....oppo.......',
      '....oppppo......',
      '...opwwwwpo.....',
      '...opkwkwpo.....',
      '...opwwwwpo..y..',
      '....oppppo...y..',
      '...opqppqpo..y..',
      '...opppppppo.y..',
      '...oppppppo..y..',
      '....oppppo...y..',
      '....opppppo.....',
      '...oppppppo.....',
      '................',
      '................',
    ],
  },

  skeleton_rogue: {
    palette: { ...BONE, n: '#3a3f52', v: '#525a73' },
    rows: [
      '................',
      '................',
      '................',
      '.....onnno......',
      '....onnnnno.....',
      '....okwkwo......',
      '....owwwwo......',
      '.....osso.......',
      '....onnnno......',
      '...ownvnvwo.....',
      '....onnnno......',
      '.....osso.......',
      '....ow..wo......',
      '...oww..wwo.....',
      '................',
      '................',
    ],
  },

  orc: {
    palette: ORC,
    rows: [
      '................',
      '................',
      '.....ooooo......',
      '....oggggggo....',
      '....ogggggggo...',
      '....ordggdro....',
      '....oggggggo....',
      '....otgggtoo....',
      '....ooggggo.....',
      '...ogobbbbogo...',
      '...ogobbbbogo...',
      '....oogggoo.....',
      '.....ogo.go.....',
      '....oddo.oddo...',
      '................',
      '................',
    ],
  },

  orc_warrior: {
    palette: { ...ORC, a: '#6d7688', h: '#454c5e', y: '#c9a84a' },
    rows: [
      '................',
      '....ohhhhho.....',
      '...ohhyhyhho....',
      '...oggggggggo...',
      '...oggggggggo...',
      '...ordggggdro...',
      '...ogggggggo....',
      '...otggggto.a...',
      '...ooaaaaoo.oa..',
      '..ogoaahaaooao..',
      '..ogoaaaaao.a...',
      '...ooagggao.a...',
      '....ogo.ogo.....',
      '...oddo..oddo...',
      '................',
      '................',
    ],
  },

  orc_mage: {
    palette: { ...ORC, p: '#8f3a5f', q: '#b55a80', y: '#e8c95a' },
    rows: [
      '................',
      '......oo........',
      '.....oppo.......',
      '....opppppo.....',
      '...opggggpo.....',
      '...oprggrpo..y..',
      '...opggggpo..y..',
      '...otggggto..y..',
      '....oppppo...y..',
      '...opqppqpo..y..',
      '...opppppppo.y..',
      '...oppppppo..y..',
      '....opppppo.....',
      '...oppppppo.....',
      '................',
      '................',
    ],
  },

  orc_rogue: {
    palette: { ...ORC, n: '#33502c' },
    rows: [
      '................',
      '................',
      '................',
      '.....onnno......',
      '....onnnnno.....',
      '....orggro......',
      '....oggggo......',
      '.....otto.......',
      '....obbbbo......',
      '...ogbnbngo.....',
      '....obbbbo......',
      '.....oggo.......',
      '....og..go......',
      '...odd..ddo.....',
      '................',
      '................',
    ],
  },

  orc_bomber: {
    palette: { ...ORC, x: '#2a2d3a', z: '#3d4152', f: '#e8934a', y: '#e8c95a' },
    rows: [
      '................',
      '..........yf....',
      '.........of.....',
      '.....ooooxo.....',
      '....oxxxxxxo....',
      '...oxzxxxxzxo...',
      '...oxxxxxxxxo...',
      '..oxxrxxxxrxxo..',
      '..oxxxxxxxxxxo..',
      '..oxxtxxxxtxxo..',
      '...oxxxxxxxxo...',
      '...ozxxxxxxzo...',
      '....oxxxxxxo....',
      '.....og..go.....',
      '................',
      '................',
    ],
  },

  bat: {
    palette: { o: OUT, v: '#5b4a73', w: '#7a659c', r: '#d9524a', k: '#2c2438' },
    rows: [
      '................',
      '................',
      '................',
      '................',
      '.oo..........oo.',
      'ovvo...oo...ovvo',
      'ovvvo.ovvo.ovvvo',
      '.ovvvovvvvovvvo.',
      '..ovvvwvvwvvvo..',
      '...ovvrvvrvvo...',
      '....ovvvvvvo....',
      '.....okokoo.....',
      '................',
      '................',
      '................',
      '................',
    ],
  },
}

const cache = new Map<string, Texture>()

/** Sprite d'un acteur, ombre portée comprise. */
export function makeActorTexture(species: string, isPlayer: boolean): Texture {
  const key = `${species}:${isPlayer}`
  const cached = cache.get(key)
  if (cached) return cached

  const def = (isPlayer ? ACTORS.hero : ACTORS[species]) ?? ACTORS.skeleton!
  const canvas = makeCanvas(TILE, TILE)
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = 'rgba(0,0,0,0.35)'
  ctx.beginPath()
  ctx.ellipse(TILE / 2, TILE - 1.5, 5, 1.8, 0, 0, Math.PI * 2)
  ctx.fill()

  paint(ctx, def.rows, def.palette)

  const texture = nearestTexture(canvas)
  cache.set(key, texture)
  return texture
}

// --- Tuiles -------------------------------------------------------------------

const FLOOR_BASE = '#333947'
const FLOOR_DARK = '#303543'
const FLOOR_LIGHT = '#3a4152'
const WALL_TOP = '#20242f'
const WALL_TOP_EDGE = '#272c39'
const WALL_FACE = '#181b24'
const WALL_JOINT = '#131521'

/**
 * Peint une tuile. Le sol varie selon sa position — trois motifs discrets qui
 * cassent l'aplat sans devenir du bruit — et les murs ont une face : le haut
 * du bloc est plus clair que sa tranche, ce qui suffit à donner du relief à
 * tout le donjon sans calculer quoi que ce soit sur les voisins.
 */
/**
 * Décor de repérage, peint directement dans la carte cuite de l'étage.
 *
 * Aucun sprite, aucun acteur : ce sont des pixels du sol, donc coût nul au
 * rendu et masquage par le brouillard offert. Chaque motif se lit à la
 * silhouette plus qu'à la couleur — c'est ce qui permet de reconnaître une
 * salle du coin de l'œil, sans la regarder.
 */
export function paintDecor(
  ctx: CanvasRenderingContext2D,
  kind: string,
  tx: number,
  ty: number,
): void {
  const px = tx * TILE
  const py = ty * TILE
  // Deux variantes par motif, tirées de la position : une rangée de pots
  // strictement identiques trahirait la génération.
  const v = ((tx * 7) ^ (ty * 13)) & 1
  const shade = 'rgba(0,0,0,0.30)'

  switch (kind) {
    case 'pot': {
      ctx.fillStyle = shade
      ctx.fillRect(px + 5, py + 13, 7, 2)
      ctx.fillStyle = '#7a5b46'
      ctx.fillRect(px + 5, py + 7, 6, 6)
      ctx.fillRect(px + 6, py + 5, 4, 2)
      ctx.fillStyle = '#8f6c52'
      ctx.fillRect(px + 6, py + 8, 2, 4)
      ctx.fillStyle = '#241a15'
      // Ébréché : le morceau manquant change de côté selon la variante.
      if (v === 0) ctx.fillRect(px + 9, py + 5, 2, 3)
      else ctx.fillRect(px + 5, py + 6, 2, 3)
      break
    }
    case 'caillou': {
      ctx.fillStyle = shade
      ctx.fillRect(px + 3, py + 12, 9, 2)
      ctx.fillStyle = '#4a5162'
      ctx.fillRect(px + 4, py + 8, 6, 4)
      ctx.fillRect(px + 5, py + 7, 4, 1)
      ctx.fillStyle = '#5b6376'
      ctx.fillRect(px + 5, py + 8, 3, 2)
      ctx.fillStyle = '#3b4150'
      ctx.fillRect(px + 10 - v, py + 10, 3, 2)
      break
    }
    case 'os': {
      ctx.fillStyle = shade
      ctx.fillRect(px + 3, py + 11, 10, 2)
      ctx.fillStyle = '#b9b7a6'
      // Deux fémurs croisés : la silhouette la plus reconnaissable du lot.
      ctx.fillRect(px + 3, py + 9, 9, 1)
      ctx.fillRect(px + 3, py + 8, 1, 1)
      ctx.fillRect(px + 11, py + 10, 1, 1)
      ctx.fillRect(px + 4 + v, py + 11, 7, 1)
      ctx.fillStyle = '#8d8b7d'
      ctx.fillRect(px + 5, py + 6, 4, 3)
      ctx.fillRect(px + 6, py + 9, 2, 1)
      break
    }
    case 'champignon': {
      ctx.fillStyle = shade
      ctx.fillRect(px + 4, py + 12, 8, 2)
      ctx.fillStyle = '#cfd8e8'
      ctx.fillRect(px + 6, py + 9, 1, 3)
      ctx.fillRect(px + 10, py + 10, 1, 2)
      ctx.fillStyle = v === 0 ? '#6fbfa0' : '#7fae6f'
      ctx.fillRect(px + 4, py + 7, 5, 2)
      ctx.fillRect(px + 5, py + 6, 3, 1)
      ctx.fillRect(px + 9, py + 9, 4, 1)
      ctx.fillStyle = '#3f6a58'
      ctx.fillRect(px + 5, py + 8, 1, 1)
      ctx.fillRect(px + 7, py + 7, 1, 1)
      break
    }
    case 'colonne': {
      ctx.fillStyle = shade
      ctx.fillRect(px + 3, py + 12, 10, 2)
      ctx.fillStyle = '#6d7386'
      ctx.fillRect(px + 5, py + 4 + v, 6, 8 - v)
      ctx.fillStyle = '#848b9e'
      ctx.fillRect(px + 5, py + 4 + v, 2, 8 - v)
      ctx.fillStyle = '#565c6d'
      ctx.fillRect(px + 4, py + 11, 8, 2)
      // Fût brisé net : le sommet est plus clair, comme une cassure fraîche.
      ctx.fillStyle = '#9aa2b6'
      ctx.fillRect(px + 5, py + 4 + v, 6, 1)
      break
    }
    case 'caisse': {
      ctx.fillStyle = shade
      ctx.fillRect(px + 3, py + 13, 10, 2)
      ctx.fillStyle = '#6b5334'
      ctx.fillRect(px + 4, py + 5, 8, 8)
      ctx.fillStyle = '#846741'
      ctx.fillRect(px + 4, py + 5, 8, 1)
      ctx.fillRect(px + 4, py + 8 + v, 8, 1)
      ctx.fillStyle = '#4a3823'
      ctx.fillRect(px + 4, py + 12, 8, 1)
      ctx.fillRect(px + 7, py + 6, 1, 6)
      break
    }
  }
}

export function paintTile(
  ctx: CanvasRenderingContext2D,
  tile: number,
  px: number,
  py: number,
): void {
  const tx = px / TILE
  const ty = py / TILE
  const h = (tx * 7 + ty * 13 + ((tx * 31) ^ (ty * 17))) % 5

  if (tile === Tile.Floor) {
    ctx.fillStyle = h === 4 ? FLOOR_DARK : FLOOR_BASE
    ctx.fillRect(px, py, TILE, TILE)
    // Joints de dalles, une case sur deux, à peine visibles.
    ctx.fillStyle = 'rgba(0,0,0,0.08)'
    if ((tx + ty) % 2 === 0) {
      ctx.fillRect(px, py + TILE - 1, TILE, 1)
      ctx.fillRect(px + TILE - 1, py, 1, TILE)
    }
    if (h === 1) {
      // Fissure.
      ctx.fillStyle = FLOOR_DARK
      ctx.fillRect(px + 3, py + 9, 4, 1)
      ctx.fillRect(px + 6, py + 10, 3, 1)
    } else if (h === 2) {
      // Caillou.
      ctx.fillStyle = FLOOR_LIGHT
      ctx.fillRect(px + 10, py + 5, 2, 1)
    } else if (h === 3) {
      ctx.fillStyle = 'rgba(255,255,255,0.03)'
      ctx.fillRect(px, py, TILE, 1)
    }
  } else if (tile === Tile.Wall) {
    // Haut du bloc.
    ctx.fillStyle = WALL_TOP
    ctx.fillRect(px, py, TILE, TILE - 5)
    ctx.fillStyle = WALL_TOP_EDGE
    ctx.fillRect(px, py, TILE, 1)
    // Tranche en briques.
    ctx.fillStyle = WALL_FACE
    ctx.fillRect(px, py + TILE - 5, TILE, 5)
    ctx.fillStyle = WALL_JOINT
    ctx.fillRect(px, py + TILE - 5, TILE, 1)
    ctx.fillRect(px, py + TILE - 2, TILE, 1)
    const shift = ty % 2 === 0 ? 4 : 9
    ctx.fillRect(px + shift, py + TILE - 4, 1, 2)
    ctx.fillRect(px + ((shift + 7) % TILE), py + TILE - 1, 1, 1)
  } else if (tile === Tile.Door) {
    ctx.fillStyle = FLOOR_DARK
    ctx.fillRect(px, py, TILE, TILE)
    // Cadre de pierre + planches.
    ctx.fillStyle = WALL_TOP
    ctx.fillRect(px, py, 2, TILE)
    ctx.fillRect(px + TILE - 2, py, 2, TILE)
    ctx.fillStyle = '#5d4426'
    ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4)
    ctx.fillStyle = '#4a3520'
    for (let i = 0; i < 3; i++) ctx.fillRect(px + 4 + i * 4, py + 2, 1, TILE - 4)
    ctx.fillStyle = '#7a5a32'
    ctx.fillRect(px + 2, py + 2, TILE - 4, 1)
    ctx.fillStyle = '#8a8f9e'
    ctx.fillRect(px + 11, py + 8, 2, 2)
  } else if (tile === Tile.Gate) {
    // La grille de la salle piégée : des barreaux sur fond de sol — on voit
    // au travers, on ne passe pas.
    ctx.fillStyle = FLOOR_DARK
    ctx.fillRect(px, py, TILE, TILE)
    ctx.fillStyle = '#23252e'
    ctx.fillRect(px, py, TILE, 2)
    ctx.fillRect(px, py + TILE - 2, TILE, 2)
    ctx.fillStyle = '#8a8f9e'
    for (let i = 0; i < 4; i++) ctx.fillRect(px + 2 + i * 4, py, 2, TILE)
    ctx.fillStyle = '#b8bdc9'
    for (let i = 0; i < 4; i++) ctx.fillRect(px + 2 + i * 4, py, 1, 1)
  } else if (tile === Tile.Stairs) {
    // Marches qui s'enfoncent dans le noir : la destination est l'obscurité.
    ctx.fillStyle = FLOOR_BASE
    ctx.fillRect(px, py, TILE, TILE)
    const shades = ['#767887', '#5c5e6d', '#454754', '#30323d', '#1d1f27', '#0e1015']
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = shades[i]!
      ctx.fillRect(px + 1 + i, py + 1 + Math.floor(i * 2.5), TILE - 2 - i * 2, 3)
    }
  } else {
    ctx.fillStyle = '#000000'
    ctx.fillRect(px, py, TILE, TILE)
  }
}

// --- Objets au sol ------------------------------------------------------------

const ITEMS: Record<string, SpriteDef> = {
  heart: {
    palette: { o: OUT, r: '#d9524a', l: '#e8837a', d: '#a83a3a' },
    rows: [
      '................',
      '................',
      '................',
      '...ooo...ooo....',
      '..orrro.orrro...',
      '.orlrrrorrrdo...',
      '.orrrrrrrrrdo...',
      '.orrrrrrrrddo...',
      '..orrrrrrrdo....',
      '...orrrrrdo.....',
      '....orrrdo......',
      '.....ordo.......',
      '......oo........',
      '................',
      '................',
      '................',
    ],
  },
  xp: {
    palette: { o: OUT, c: '#5bc9e8', l: '#a8e8f5', d: '#3a8fb5' },
    rows: [
      '................',
      '................',
      '................',
      '................',
      '.......o........',
      '......oco.......',
      '.....oclco......',
      '....ocllcdo.....',
      '.....occdo......',
      '......odo.......',
      '.......o........',
      '................',
      '................',
      '................',
      '................',
      '................',
    ],
  },
  // L'étal de la salle de repos : un autel doré (plafond), une grande fiole
  // rouge (soin), deux petites fioles (souffle bleu, vitesse jaune).
  cap: {
    palette: { o: OUT, g: '#e8c95a', d: '#b8983a', l: '#f5e3a0', s: '#6a5a2a' },
    rows: [
      '................',
      '................',
      '................',
      '......olgo......',
      '.....olggdo.....',
      '.....ogggdo.....',
      '......ogdo......',
      '......ogdo......',
      '.....ogggdo.....',
      '....ogggggdo....',
      '...osssssssdo...',
      '...osssssssdo...',
      '....oooooooo....',
      '................',
      '................',
      '................',
    ],
  },
  soin: {
    palette: { o: OUT, r: '#d9524a', l: '#e8837a', v: '#8fd0c9', d: '#a83a3a' },
    rows: [
      '................',
      '................',
      '.......oo.......',
      '......ovvo......',
      '.......oo.......',
      '......ovvo......',
      '.....ovrrvo.....',
      '....ovrlrrvo....',
      '....ovrrrdvo....',
      '....ovrrrdvo....',
      '.....ovrdvo.....',
      '......ovvo......',
      '.......oo.......',
      '................',
      '................',
      '................',
    ],
  },
  fiole_souffle: {
    palette: { o: OUT, b: '#5bc9e8', l: '#a8e8f5', v: '#8fd0c9', d: '#3a8fb5' },
    rows: [
      '................',
      '................',
      '................',
      '.......oo.......',
      '......ovvo......',
      '.......oo.......',
      '......obbo......',
      '.....oblbbo.....',
      '.....obbbdo.....',
      '.....obbbdo.....',
      '......obdo......',
      '.......oo.......',
      '................',
      '................',
      '................',
      '................',
    ],
  },
  fiole_vitesse: {
    palette: { o: OUT, b: '#e8c95a', l: '#f5e3a0', v: '#8fd0c9', d: '#b8983a' },
    rows: [
      '................',
      '................',
      '................',
      '.......oo.......',
      '......ovvo......',
      '.......oo.......',
      '......obbo......',
      '.....oblbbo.....',
      '.....obbbdo.....',
      '.....obbbdo.....',
      '......obdo......',
      '.......oo.......',
      '................',
      '................',
      '................',
      '................',
    ],
  },
  bone: {
    // Un petit os croisé : la monnaie de la descente, discrète comme une orbe.
    palette: { o: OUT, b: '#e8e0cc', d: '#b8ae94' },
    rows: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '....oo....oo....',
      '...obbo..obbo...',
      '....obbobbdo....',
      '.....obbbdo.....',
      '.....obbbdo.....',
      '....obbobbdo....',
      '...obdo..oddo...',
      '....oo....oo....',
      '................',
      '................',
      '................',
    ],
  },
  key: {
    palette: { o: OUT, y: '#e8c95a', d: '#b5923a', k: '#2a2412' },
    rows: [
      '................',
      '................',
      '................',
      '................',
      '...oooo.........',
      '..oyyydo........',
      '..oykyyoooooo...',
      '..oykyyyyyyyyo..',
      '..oyyydododyo...',
      '...odddo.oyo....',
      '....ooo..oo.....',
      '................',
      '................',
      '................',
      '................',
      '................',
    ],
  },
  chest: {
    palette: { o: OUT, w: '#6d4d28', l: '#8a6535', d: '#4d3419', y: '#e8c95a', m: '#3a3f52' },
    rows: [
      '................',
      '................',
      '................',
      '....oooooooo....',
      '...owllllllwo...',
      '...olwwwwwwlo...',
      '...omoooooomo...',
      '...owwwoywwwo...',
      '...owwwyywwwo...',
      '...owwwoywwwo...',
      '...odddddddo....',
      '...omooooooml...',
      '....oooooooo....',
      '................',
      '................',
      '................',
    ],
  },
}

/** Armes au sol : chaque profil doit se reconnaître sans lire d'étiquette. */
function weaponRows(weapon: string): SpriteDef {
  const c = WEAPONS[weapon]?.color ?? 0xd8dde8
  const hexColor = `#${c.toString(16).padStart(6, '0')}`
  const base: Palette = { o: OUT, b: hexColor, h: '#5d4426', l: '#f0f2f7', d: '#8a8f9e' }
  switch (weapon) {
    case 'dagger':
      return {
        palette: base,
        rows: [
          '................', '................', '................', '................',
          '................', '......ob........', '.....oblo.......', '.....obo........',
          '....oho.........', '...oho..........', '................', '................',
          '................', '................', '................', '................',
        ],
      }
    case 'axe':
      return {
        palette: base,
        rows: [
          '................', '................', '................', '....obbo........',
          '...obbbbo.......', '...obblbbo......', '....obbbho......', '.....ooho.......',
          '......oho.......', '.......oho......', '........oho.....', '.........oho....',
          '................', '................', '................', '................',
        ],
      }
    case 'spear':
      return {
        palette: base,
        rows: [
          '................', '................', '..........ob....', '.........oblo...',
          '........obbo....', '.......oho......', '......oho.......', '.....oho........',
          '....oho.........', '...oho..........', '..oho...........', '................',
          '................', '................', '................', '................',
        ],
      }
    case 'bow':
      return {
        palette: base,
        rows: [
          '................', '................', '.....obo........', '....obo.........',
          '...obo..d.......', '...obo..d.......', '...obo..d.......', '...obbo.d.......',
          '...obo..d.......', '...obo..d.......', '...obo..d.......', '....obo.........',
          '.....obo........', '................', '................', '................',
        ],
      }
    default: // épée
      return {
        palette: base,
        rows: [
          '................', '................', '................', '.......obo......',
          '......oblo......', '......oblo......', '.....oblo.......', '.....obo........',
          '....odddo.......', '...ohoooddo.....', '..oho...........', '................',
          '................', '................', '................', '................',
        ],
      }
  }
}

export function makeItemTexture(kind: ItemKind, weapon?: string): Texture {
  const key = `item:${kind}:${weapon ?? ''}`
  const cached = cache.get(key)
  if (cached) return cached

  const canvas = makeCanvas(TILE, TILE)
  const ctx = canvas.getContext('2d')!

  // Petite ombre commune : l'objet est posé, pas flottant.
  ctx.fillStyle = 'rgba(0,0,0,0.25)'
  ctx.beginPath()
  ctx.ellipse(TILE / 2, TILE - 2.5, 4, 1.4, 0, 0, Math.PI * 2)
  ctx.fill()

  const def = kind === 'weapon' ? weaponRows(weapon ?? 'sword') : ITEMS[kind]
  if (def) paint(ctx, def.rows, def.palette)

  const texture = nearestTexture(canvas)
  cache.set(key, texture)
  return texture
}

/** Projectile : un simple point lumineux teinté par le tir d'origine. */
export function makeProjectileTexture(): Texture {
  const cached = cache.get('__proj')
  if (cached) return cached
  const size = 6
  const canvas = makeCanvas(size, size)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2 - 0.5, 0, Math.PI * 2)
  ctx.fill()
  const texture = nearestTexture(canvas)
  cache.set('__proj', texture)
  return texture
}

/** Pixel blanc réutilisable (barres de vie, marqueurs). */
export function whiteTexture(): Texture {
  const cached = cache.get('__white')
  if (cached) return cached
  const canvas = makeCanvas(1, 1)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 1, 1)
  const texture = nearestTexture(canvas)
  cache.set('__white', texture)
  return texture
}
