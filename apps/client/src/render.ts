/**
 * Rendu Pixi.
 *
 * Deux cadences distinctes, et c'est là que se joue la fluidité :
 *  - `applyState()` est appelé au rythme du réseau (15 Hz) : positions cibles,
 *    brouillard, effets.
 *  - `render()` est appelé à chaque frame (60 Hz+) : interpolation et caméra.
 *
 * Le résultat : un jeu discret au tick près côté règles, mais qui bouge de
 * façon continue à l'écran.
 */
import { Application, Container, Sprite, Text, Texture } from 'pixi.js'
import type { ActorView, GameEvent } from '@dc/engine'
import {
  SCALE,
  TILE,
  makeActorTexture,
  makeCanvas,
  nearestTexture,
  paintTile,
  whiteTexture,
} from './atlas.js'

interface Entity {
  sprite: Sprite
  hpBg: Sprite
  hpFill: Sprite
  /** Position affichée, interpolée vers (view.x, view.y). */
  rx: number
  ry: number
  view: ActorView
}

interface FloatingText {
  text: Text
  ttl: number
  vy: number
}

const FOG_UNKNOWN = 255
const FOG_EXPLORED = 165
const FOG_VISIBLE = 0

export class Renderer {
  readonly world = new Container()
  private readonly mapLayer = new Container()
  private readonly entityLayer = new Container()
  private readonly fxLayer = new Container()

  private mapSprite: Sprite | null = null
  private fogSprite: Sprite | null = null
  private fogCanvas: HTMLCanvasElement | null = null
  private fogCtx: CanvasRenderingContext2D | null = null
  private fogImage: ImageData | null = null
  private fogTexture: Texture | null = null

  private explored = new Uint8Array(0)
  private entities = new Map<string, Entity>()
  private floaters: FloatingText[] = []

  private width = 0
  private height = 0
  selfId = ''

  constructor(private readonly app: Application) {
    this.entityLayer.sortableChildren = true
    this.world.addChild(this.mapLayer, this.entityLayer, this.fxLayer)
    this.world.scale.set(SCALE)
    app.stage.addChild(this.world)
  }

  /** Nouvel étage : on rebâtit la carte et on repart d'un brouillard complet. */
  setFloor(width: number, height: number, tiles: Uint8Array): void {
    this.width = width
    this.height = height
    this.explored = new Uint8Array(width * height)

    // La carte entière est cuite une fois dans une seule texture : un sprite
    // pour 4096 tuiles, au lieu de 4096 objets à parcourir chaque frame.
    const canvas = makeCanvas(width * TILE, height * TILE)
    const ctx = canvas.getContext('2d')!
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        paintTile(ctx, tiles[y * width + x]!, x * TILE, y * TILE)
      }
    }
    this.mapSprite?.destroy()
    this.mapSprite = new Sprite(nearestTexture(canvas))
    this.mapLayer.removeChildren()
    this.mapLayer.addChild(this.mapSprite)

    // Brouillard : une texture d'un pixel par tuile, agrandie x16. Mettre à
    // jour 4096 pixels par tick est négligeable, et le rendu reste aligné
    // sur la grille.
    this.fogCanvas = makeCanvas(width, height)
    this.fogCtx = this.fogCanvas.getContext('2d')!
    this.fogImage = this.fogCtx.createImageData(width, height)
    this.fogTexture?.destroy(true)
    this.fogTexture = nearestTexture(this.fogCanvas)
    this.fogSprite?.destroy()
    this.fogSprite = new Sprite(this.fogTexture)
    this.fogSprite.scale.set(TILE)
    this.mapLayer.addChild(this.fogSprite)

    for (const e of this.entities.values()) {
      e.sprite.destroy()
      e.hpBg.destroy()
      e.hpFill.destroy()
    }
    this.entities.clear()
    this.entityLayer.removeChildren()
  }

  /** Reçoit un état serveur (15 Hz). */
  applyState(actors: ActorView[], visible: Uint8Array, events: GameEvent[]): void {
    if (this.width === 0) return

    for (let i = 0; i < this.explored.length; i++) {
      if (visible[i]) this.explored[i] = 1
    }
    this.paintFog(visible)

    const seen = new Set<string>()
    for (const view of actors) {
      seen.add(view.id)
      let entity = this.entities.get(view.id)
      if (!entity) {
        entity = this.createEntity(view)
        this.entities.set(view.id, entity)
      }
      entity.view = view
    }

    for (const [id, entity] of this.entities) {
      if (seen.has(id)) continue
      entity.sprite.destroy()
      entity.hpBg.destroy()
      entity.hpFill.destroy()
      this.entities.delete(id)
    }

    for (const ev of events) this.handleEvent(ev)
  }

  private createEntity(view: ActorView): Entity {
    const sprite = new Sprite(makeActorTexture(view.species, view.kind === 'player'))
    sprite.x = view.x * TILE
    sprite.y = view.y * TILE
    this.entityLayer.addChild(sprite)

    const hpBg = new Sprite(whiteTexture())
    hpBg.tint = 0x000000
    hpBg.alpha = 0.6
    hpBg.height = 2
    hpBg.width = TILE - 4
    const hpFill = new Sprite(whiteTexture())
    hpFill.tint = view.kind === 'player' ? 0x6ec06e : 0xd9605f
    hpFill.height = 2
    this.entityLayer.addChild(hpBg, hpFill)

    return { sprite, hpBg, hpFill, rx: view.x, ry: view.y, view }
  }

  private paintFog(visible: Uint8Array): void {
    if (!this.fogImage || !this.fogCtx || !this.fogTexture) return
    const data = this.fogImage.data
    for (let i = 0; i < this.explored.length; i++) {
      const alpha = visible[i] ? FOG_VISIBLE : this.explored[i] ? FOG_EXPLORED : FOG_UNKNOWN
      data[i * 4 + 3] = alpha
    }
    this.fogCtx.putImageData(this.fogImage, 0, 0)
    this.fogTexture.source.update()
  }

  private handleEvent(ev: GameEvent): void {
    if (ev.t === 'hit') {
      this.spawnFloater(`-${ev.dmg}`, ev.x, ev.y, 0xff8e8e)
    } else if (ev.t === 'death' && ev.kind === 'player') {
      this.spawnFloater('K.O.', ev.x, ev.y, 0xffd166)
    } else if (ev.t === 'respawn') {
      this.spawnFloater('debout !', ev.x, ev.y, 0x8ee6a0)
    }
  }

  private spawnFloater(label: string, x: number, y: number, color: number): void {
    const text = new Text({
      text: label,
      style: {
        fontFamily: 'ui-monospace, monospace',
        fontSize: 8,
        fill: color,
        stroke: { color: 0x000000, width: 2 },
      },
    })
    text.anchor.set(0.5, 1)
    text.x = x * TILE + TILE / 2
    text.y = y * TILE
    this.fxLayer.addChild(text)
    this.floaters.push({ text, ttl: 0.9, vy: -14 })
  }

  /** Interpolation + caméra, appelé à chaque frame. */
  render(dt: number): void {
    // Facteur d'approche indépendant du framerate.
    const k = 1 - Math.exp(-16 * dt)

    for (const e of this.entities) {
      const entity = e[1]
      const { view } = entity
      entity.rx += (view.x - entity.rx) * k
      entity.ry += (view.y - entity.ry) * k

      // Au-delà d'un écart de 3 cases (téléportation, changement d'étage,
      // reconnexion), on coupe l'interpolation : glisser sur 40 cases est pire
      // que de sauter directement.
      if (Math.abs(view.x - entity.rx) > 3 || Math.abs(view.y - entity.ry) > 3) {
        entity.rx = view.x
        entity.ry = view.y
      }

      const px = entity.rx * TILE
      const py = entity.ry * TILE
      entity.sprite.x = px
      entity.sprite.y = py
      entity.sprite.zIndex = entity.ry

      const isSelf = view.id === this.selfId
      const dimmed = !view.visible && !isSelf
      entity.sprite.alpha = !view.alive ? 0.3 : dimmed ? 0.4 : 1
      entity.sprite.tint = view.alive ? 0xffffff : 0x8899aa

      const ratio = Math.max(0, Math.min(1, view.hp / view.maxHp))
      const showBar = view.alive && (ratio < 1 || view.kind === 'player')
      entity.hpBg.visible = showBar && !dimmed
      entity.hpFill.visible = showBar && !dimmed
      entity.hpBg.x = px + 2
      entity.hpBg.y = py - 3
      entity.hpBg.zIndex = entity.ry
      entity.hpFill.x = px + 2
      entity.hpFill.y = py - 3
      entity.hpFill.width = (TILE - 4) * ratio
      entity.hpFill.zIndex = entity.ry
    }

    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i]!
      f.ttl -= dt
      f.text.y += f.vy * dt
      f.text.alpha = Math.max(0, Math.min(1, f.ttl * 2))
      if (f.ttl <= 0) {
        f.text.destroy()
        this.floaters.splice(i, 1)
      }
    }

    const self = this.entities.get(this.selfId)
    if (self) {
      // Arrondi à l'entier : sans ça la caméra tombe entre deux pixels et
      // toute l'image scintille pendant le déplacement.
      this.world.x = Math.round(this.app.screen.width / 2 - (self.rx * TILE + TILE / 2) * SCALE)
      this.world.y = Math.round(this.app.screen.height / 2 - (self.ry * TILE + TILE / 2) * SCALE)
    }
  }
}
