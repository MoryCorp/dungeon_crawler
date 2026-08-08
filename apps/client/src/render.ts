/**
 * Rendu Pixi.
 *
 * Deux cadences : `applyState()` au rythme du réseau (30 Hz), `render()` à
 * chaque frame. Le joueur local n'est jamais interpolé — il est dessiné à sa
 * position prédite, sinon on sentirait un aller-retour à chaque paquet.
 */
import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import type { ActorView, GameEvent } from '@dc/engine'
import { ATTACK_HALF_ARC, ATTACK_REACH, MONSTERS, MONSTER_HALF_ARC } from '@dc/engine'
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
  telegraph: Graphics
  rx: number
  ry: number
  view: ActorView
  telegraphKey: string
}

interface Effect {
  node: Container
  ttl: number
  life: number
  vy: number
}

const FOG_UNKNOWN = 255
const FOG_EXPLORED = 165
const FOG_VISIBLE = 0

const SWING_SECONDS = 0.22

function drawWedge(
  g: Graphics,
  radius: number,
  aim: number,
  halfArc: number,
  color: number,
  alpha: number,
): void {
  g.clear()
  g.moveTo(0, 0)
  g.arc(0, 0, radius, aim - halfArc, aim + halfArc)
  g.lineTo(0, 0)
  g.fill({ color, alpha })
}

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
  private effects: Effect[] = []

  private width = 0
  private height = 0
  selfId = ''
  /** Position prédite du joueur local, en tuiles. */
  predicted: { x: number; y: number } | null = null

  constructor(private readonly app: Application) {
    this.entityLayer.sortableChildren = true
    this.world.addChild(this.mapLayer, this.entityLayer, this.fxLayer)
    this.world.scale.set(SCALE)
    app.stage.addChild(this.world)
  }

  setFloor(width: number, height: number, tiles: Uint8Array): void {
    this.width = width
    this.height = height
    this.explored = new Uint8Array(width * height)

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

    this.fogCanvas = makeCanvas(width, height)
    this.fogCtx = this.fogCanvas.getContext('2d')!
    this.fogImage = this.fogCtx.createImageData(width, height)
    this.fogTexture?.destroy(true)
    this.fogTexture = nearestTexture(this.fogCanvas)
    this.fogSprite?.destroy()
    this.fogSprite = new Sprite(this.fogTexture)
    this.fogSprite.scale.set(TILE)
    this.mapLayer.addChild(this.fogSprite)

    for (const e of this.entities.values()) this.destroyEntity(e)
    this.entities.clear()
    this.entityLayer.removeChildren()
    for (const fx of this.effects) fx.node.destroy()
    this.effects = []
    this.fxLayer.removeChildren()
  }

  /** `visible` est nul sur les paquets où le brouillard n'est pas renvoyé. */
  applyState(actors: ActorView[], visible: Uint8Array | null, events: GameEvent[]): void {
    if (this.width === 0) return

    if (visible) {
      for (let i = 0; i < this.explored.length; i++) {
        if (visible[i]) this.explored[i] = 1
      }
      this.paintFog(visible)
    }

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
      this.destroyEntity(entity)
      this.entities.delete(id)
    }

    for (const ev of events) this.handleEvent(ev)
  }

  private createEntity(view: ActorView): Entity {
    const sprite = new Sprite(makeActorTexture(view.species, view.kind === 'player'))
    sprite.anchor.set(0.5, 0.5)
    this.entityLayer.addChild(sprite)

    const telegraph = new Graphics()
    telegraph.visible = false
    this.entityLayer.addChild(telegraph)

    const hpBg = new Sprite(whiteTexture())
    hpBg.tint = 0x000000
    hpBg.alpha = 0.6
    hpBg.height = 2
    hpBg.width = TILE - 4
    hpBg.anchor.set(0.5, 0.5)
    const hpFill = new Sprite(whiteTexture())
    hpFill.tint = view.kind === 'player' ? 0x6ec06e : 0xd9605f
    hpFill.height = 2
    hpFill.anchor.set(0, 0.5)
    this.entityLayer.addChild(hpBg, hpFill)

    return { sprite, hpBg, hpFill, telegraph, rx: view.x, ry: view.y, view, telegraphKey: '' }
  }

  private destroyEntity(e: Entity): void {
    e.sprite.destroy()
    e.hpBg.destroy()
    e.hpFill.destroy()
    e.telegraph.destroy()
  }

  private paintFog(visible: Uint8Array): void {
    if (!this.fogImage || !this.fogCtx || !this.fogTexture) return
    const data = this.fogImage.data
    for (let i = 0; i < this.explored.length; i++) {
      data[i * 4 + 3] = visible[i] ? FOG_VISIBLE : this.explored[i] ? FOG_EXPLORED : FOG_UNKNOWN
    }
    this.fogCtx.putImageData(this.fogImage, 0, 0)
    this.fogTexture.source.update()
  }

  private handleEvent(ev: GameEvent): void {
    switch (ev.t) {
      case 'swing': {
        const actor = this.entities.get(ev.id)?.view
        const isPlayer = actor?.kind === 'player'
        const reach = isPlayer
          ? ATTACK_REACH
          : (MONSTERS[actor?.species ?? '']?.reach ?? 1)
        const halfArc = isPlayer ? ATTACK_HALF_ARC : MONSTER_HALF_ARC
        const g = new Graphics()
        drawWedge(g, reach * TILE, ev.aim, halfArc, isPlayer ? 0xfff2c4 : 0xff9a76, 0.5)
        g.x = ev.x * TILE
        g.y = ev.y * TILE
        this.fxLayer.addChild(g)
        this.effects.push({ node: g, ttl: SWING_SECONDS, life: SWING_SECONDS, vy: 0 })
        break
      }
      case 'hit':
        this.spawnFloater(`-${ev.dmg}`, ev.x, ev.y, 0xff8e8e)
        break
      case 'death':
        if (ev.kind === 'player') this.spawnFloater('K.O.', ev.x, ev.y, 0xffd166)
        break
      case 'respawn':
        this.spawnFloater('debout !', ev.x, ev.y, 0x8ee6a0)
        break
      default:
        break
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
    text.x = x * TILE
    text.y = y * TILE - TILE / 2
    this.fxLayer.addChild(text)
    this.effects.push({ node: text, ttl: 0.9, life: 0.9, vy: -14 })
  }

  /** Nombre d'effets visuels actifs — utile pour vérifier que les swings sortent. */
  get effectCount(): number {
    return this.effects.length
  }

  render(dt: number): void {
    const k = 1 - Math.exp(-18 * dt)

    for (const [, entity] of this.entities) {
      const { view } = entity
      const isSelf = view.id === this.selfId

      if (isSelf && this.predicted) {
        // Position prédite localement : aucune interpolation, sinon le
        // personnage traîne derrière la souris.
        entity.rx = this.predicted.x
        entity.ry = this.predicted.y
      } else {
        entity.rx += (view.x - entity.rx) * k
        entity.ry += (view.y - entity.ry) * k
        if (Math.abs(view.x - entity.rx) > 3 || Math.abs(view.y - entity.ry) > 3) {
          entity.rx = view.x
          entity.ry = view.y
        }
      }

      const px = entity.rx * TILE
      const py = entity.ry * TILE
      entity.sprite.x = px
      entity.sprite.y = py
      entity.sprite.zIndex = entity.ry
      // On retourne le sprite selon la visée plutôt que selon le déplacement :
      // le personnage regarde sa cible même en reculant.
      entity.sprite.scale.x = Math.cos(view.aim) < 0 ? -1 : 1

      const dimmed = !view.visible && !isSelf
      entity.sprite.alpha = !view.alive ? 0.3 : dimmed ? 0.4 : 1
      entity.sprite.tint = view.alive
        ? view.invuln && Math.floor(performance.now() / 90) % 2 === 0
          ? 0x8fb6ff
          : 0xffffff
        : 0x8899aa

      // Télégraphe : l'arc rouge qui annonce le coup et laisse le temps de sortir.
      const key = view.winding ? `${view.aim.toFixed(2)}:${view.species}` : ''
      if (key !== entity.telegraphKey) {
        entity.telegraphKey = key
        entity.telegraph.visible = view.winding
        if (view.winding) {
          const reach = MONSTERS[view.species]?.reach ?? 1
          drawWedge(entity.telegraph, reach * TILE, view.aim, MONSTER_HALF_ARC, 0xff5252, 0.28)
        }
      }
      entity.telegraph.x = px
      entity.telegraph.y = py
      entity.telegraph.zIndex = entity.ry - 0.01

      const ratio = Math.max(0, Math.min(1, view.hp / view.maxHp))
      const showBar = view.alive && (ratio < 1 || view.kind === 'player') && !dimmed
      entity.hpBg.visible = showBar
      entity.hpFill.visible = showBar
      entity.hpBg.x = px
      entity.hpBg.y = py - TILE * 0.75
      entity.hpBg.zIndex = entity.ry
      entity.hpFill.x = px - (TILE - 4) / 2
      entity.hpFill.y = py - TILE * 0.75
      entity.hpFill.width = (TILE - 4) * ratio
      entity.hpFill.zIndex = entity.ry
    }

    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i]!
      fx.ttl -= dt
      fx.node.y += fx.vy * dt
      fx.node.alpha = Math.max(0, Math.min(1, fx.ttl / fx.life))
      if (fx.ttl <= 0) {
        fx.node.destroy()
        this.effects.splice(i, 1)
      }
    }

    const self = this.entities.get(this.selfId)
    const fx = this.predicted?.x ?? self?.rx
    const fy = this.predicted?.y ?? self?.ry
    if (fx !== undefined && fy !== undefined) {
      // Arrondi à l'entier : sans ça la caméra tombe entre deux pixels et
      // toute l'image scintille pendant le déplacement.
      this.world.x = Math.round(this.app.screen.width / 2 - fx * TILE * SCALE)
      this.world.y = Math.round(this.app.screen.height / 2 - fy * TILE * SCALE)
    }
  }
}
