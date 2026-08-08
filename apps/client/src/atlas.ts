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
import { MONSTERS, Tile, WEAPONS, type ItemKind } from '@dc/engine'

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

/**
 * Objets au sol. Chacun doit être identifiable d'un coup d'œil à 16x16 sans
 * texte : c'est la seule information dont le joueur dispose en courant.
 */
export function makeItemTexture(kind: ItemKind, weapon?: string): Texture {
  const key = `item:${kind}:${weapon ?? ''}`
  const cached = cache.get(key)
  if (cached) return cached

  const canvas = makeCanvas(TILE, TILE)
  const ctx = canvas.getContext('2d')!

  switch (kind) {
    case 'heart':
      ctx.fillStyle = '#e2686d'
      ctx.fillRect(4, 5, 3, 3)
      ctx.fillRect(9, 5, 3, 3)
      ctx.fillRect(4, 7, 8, 3)
      ctx.fillRect(5, 10, 6, 1)
      ctx.fillRect(6, 11, 4, 1)
      ctx.fillRect(7, 12, 2, 1)
      ctx.fillStyle = 'rgba(255,255,255,0.5)'
      ctx.fillRect(5, 6, 2, 1)
      break

    case 'xp':
      ctx.fillStyle = '#7fd8ff'
      ctx.fillRect(7, 4, 2, 8)
      ctx.fillRect(5, 6, 6, 4)
      ctx.fillStyle = 'rgba(255,255,255,0.7)'
      ctx.fillRect(7, 6, 1, 2)
      break

    case 'key':
      ctx.fillStyle = '#e8c95a'
      ctx.fillRect(4, 5, 4, 4)
      ctx.fillRect(8, 6, 5, 2)
      ctx.fillRect(11, 8, 2, 2)
      ctx.fillStyle = '#2a2412'
      ctx.fillRect(5, 6, 2, 2)
      break

    case 'chest':
      ctx.fillStyle = '#6b4f2a'
      ctx.fillRect(2, 6, 12, 8)
      ctx.fillStyle = '#8a6a3a'
      ctx.fillRect(2, 6, 12, 3)
      ctx.fillStyle = '#e8c95a'
      ctx.fillRect(7, 9, 2, 3)
      ctx.fillStyle = 'rgba(0,0,0,0.4)'
      ctx.fillRect(2, 9, 12, 1)
      break

    case 'weapon': {
      const color = WEAPONS[weapon ?? '']?.color ?? 0xd8dde8
      ctx.fillStyle = '#3a2f22'
      ctx.fillRect(6, 11, 4, 2)
      ctx.fillStyle = hex(color)
      ctx.fillRect(7, 3, 2, 8)
      ctx.fillRect(5, 10, 6, 1)
      ctx.fillStyle = 'rgba(255,255,255,0.6)'
      ctx.fillRect(7, 4, 1, 5)
      break
    }
  }

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
