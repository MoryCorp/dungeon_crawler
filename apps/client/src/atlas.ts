/**
 * Textures du jeu.
 *
 * Pour l'instant tout est généré à la volée (rectangles colorés) : le jeu
 * tourne sans avoir à télécharger quoi que ce soit. C'est la seule couche à
 * remplacer pour brancher un vrai pack de sprites.
 *
 * === Brancher Pixel Crawler ===
 * 1. Déposer le pack dans `apps/client/public/assets/packs/pixelcrawler/`
 * 2. Remplacer `makeActorTexture` par un découpage du spritesheet :
 *      const sheet = await Assets.load('/assets/packs/pixelcrawler/heroes.png')
 *      new Texture({ source: sheet.source, frame: new Rectangle(x, y, 16, 16) })
 * 3. Remplacer `paintTile` par un drawImage depuis le tileset.
 * Rien d'autre dans le projet ne connaît la provenance des textures.
 */
import { CanvasSource, Texture } from 'pixi.js'
import { MONSTERS, Tile } from '@dc/engine'

/** Taille d'une tuile en pixels source (Pixel Crawler est en 16x16). */
export const TILE = 16
/** Facteur d'agrandissement. Entier obligatoire, sinon les pixels bavent. */
export const SCALE = 3

const TILE_COLORS: Record<number, string> = {
  [Tile.Wall]: '#171a23',
  [Tile.Floor]: '#39404f',
  [Tile.Door]: '#6b4f2a',
  [Tile.Stairs]: '#d9a441',
}

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

/** Peint une tuile dans le canvas de fond (coordonnées en pixels). */
export function paintTile(
  ctx: CanvasRenderingContext2D,
  tile: number,
  px: number,
  py: number,
): void {
  ctx.fillStyle = TILE_COLORS[tile] ?? '#000000'
  ctx.fillRect(px, py, TILE, TILE)

  if (tile === Tile.Floor) {
    // Léger grain pour que le sol ne soit pas un aplat uniforme.
    ctx.fillStyle = 'rgba(255,255,255,0.025)'
    ctx.fillRect(px, py, TILE, 1)
  } else if (tile === Tile.Wall) {
    ctx.fillStyle = '#20242f'
    ctx.fillRect(px, py + TILE - 3, TILE, 3)
  } else if (tile === Tile.Stairs) {
    ctx.fillStyle = '#8a6420'
    for (let i = 0; i < 4; i++) ctx.fillRect(px + 2, py + 3 + i * 3, TILE - 4, 2)
  }
}

const cache = new Map<string, Texture>()

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

/** Silhouette placeholder : corps + tête, lisible à 16x16. */
export function makeActorTexture(species: string, isPlayer: boolean): Texture {
  const key = `${species}:${isPlayer}`
  const cached = cache.get(key)
  if (cached) return cached

  const color = isPlayer ? 0x4ea3d9 : (MONSTERS[species]?.color ?? 0xcccccc)
  const canvas = makeCanvas(TILE, TILE)
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = 'rgba(0,0,0,0.35)'
  ctx.beginPath()
  ctx.ellipse(TILE / 2, TILE - 2, 5, 2, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = hex(color)
  ctx.fillRect(4, 6, 8, 8)
  ctx.fillRect(5, 3, 6, 4)

  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  ctx.fillRect(4, 6, 8, 1)

  ctx.fillStyle = '#101319'
  ctx.fillRect(6, 5, 1, 1)
  ctx.fillRect(9, 5, 1, 1)

  const texture = nearestTexture(canvas)
  cache.set(key, texture)
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
