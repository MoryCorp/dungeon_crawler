/**
 * Rendu Pixi.
 *
 * Deux cadences : `applyState()` au rythme du réseau (30 Hz), `render()` à
 * chaque frame. Le joueur local n'est jamais interpolé — il est dessiné à sa
 * position prédite, sinon on sentirait un aller-retour à chaque paquet.
 */
import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import type { ActorView, GameEvent, ItemView, ProjectileView } from '@dc/engine'
import { MONSTERS, MONSTER_HALF_ARC } from '@dc/engine'
import { packAnim, type AnimSet } from './pack.js'
import {
  SCALE,
  TILE,
  makeActorTexture,
  makeCanvas,
  makeItemTexture,
  makeProjectileTexture,
  nearestTexture,
  paintTile,
  whiteTexture,
} from './atlas.js'

interface Entity {
  sprite: Sprite
  shadow: Sprite
  hpBg: Sprite
  hpFill: Sprite
  telegraph: Graphics
  rx: number
  ry: number
  view: ActorView
  telegraphKey: string
  /** Animations du pack de sprites — null en repli procédural. */
  anim: AnimSet | null
  animT: number
}

interface Effect {
  node: Container
  ttl: number
  life: number
  vy: number
  /** Grossissement appliqué sur la durée de vie (explosions). */
  grow?: number
}

interface Mover {
  sprite: Sprite
  rx: number
  ry: number
}

const FOG_UNKNOWN = 255
const FOG_EXPLORED = 165
const FOG_VISIBLE = 0

const SWING_SECONDS = 0.22

/** Un élite se repère à sa taille avant même de lire son nom. */
const RANK_SCALE: Record<string, number> = { elite: 1.35, boss: 1.9 }

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
  private readonly itemLayer = new Container()
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
  private items = new Map<string, Mover>()
  private projectiles = new Map<string, Mover>()
  private effects: Effect[] = []
  private clock = 0

  private width = 0
  private height = 0
  selfId = ''
  /** Position prédite du joueur local, en tuiles. */
  predicted: { x: number; y: number } | null = null

  constructor(private readonly app: Application) {
    this.entityLayer.sortableChildren = true
    this.world.addChild(this.mapLayer, this.itemLayer, this.entityLayer, this.fxLayer)
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
    for (const m of this.items.values()) m.sprite.destroy()
    this.items.clear()
    this.itemLayer.removeChildren()
    for (const m of this.projectiles.values()) m.sprite.destroy()
    this.projectiles.clear()
    for (const fx of this.effects) fx.node.destroy()
    this.effects = []
    this.fxLayer.removeChildren()
  }

  /** `visible` est nul sur les paquets où le brouillard n'est pas renvoyé. */
  applyState(
    actors: ActorView[],
    projectiles: ProjectileView[],
    items: ItemView[],
    visible: Uint8Array | null,
    events: GameEvent[],
  ): void {
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

    this.syncMovers(this.items, items, this.itemLayer, (item) => {
      const sprite = new Sprite(makeItemTexture(item.kind, item.weapon))
      sprite.anchor.set(0.5, 0.5)
      return sprite
    })

    this.syncMovers(this.projectiles, projectiles, this.fxLayer, (p) => {
      const sprite = new Sprite(makeProjectileTexture())
      sprite.anchor.set(0.5, 0.5)
      sprite.tint = p.color
      return sprite
    })

    for (const ev of events) this.handleEvent(ev)
  }

  /**
   * Réconcilie une collection de sprites purement positionnels (objets au sol,
   * projectiles) avec la liste reçue du serveur.
   */
  private syncMovers<T extends { id: string; x: number; y: number }>(
    store: Map<string, Mover>,
    views: T[],
    layer: Container,
    create: (view: T) => Sprite,
  ): void {
    const seen = new Set<string>()
    for (const view of views) {
      seen.add(view.id)
      let mover = store.get(view.id)
      if (!mover) {
        const sprite = create(view)
        layer.addChild(sprite)
        mover = { sprite, rx: view.x, ry: view.y }
        store.set(view.id, mover)
      }
      mover.sprite.x = view.x * TILE
      mover.sprite.y = view.y * TILE
      mover.rx = view.x
      mover.ry = view.y
    }
    for (const [id, mover] of store) {
      if (seen.has(id)) continue
      mover.sprite.destroy()
      store.delete(id)
    }
  }

  private createEntity(view: ActorView): Entity {
    const anim = packAnim(view.species, view.kind === 'player')
    const sprite = new Sprite(anim ? anim.idle[0] : makeActorTexture(view.species, view.kind === 'player'))
    // Les cadres du pack posent les pieds vers le bas du cadre : l'ancre est un
    // peu sous le centre pour que le personnage repose sur sa tuile.
    sprite.anchor.set(0.5, anim ? 0.62 : 0.5)
    this.entityLayer.addChild(sprite)

    // Les cadres du pack n'ont pas d'ombre incorporée, contrairement à l'atlas
    // procédural : on la pose nous-mêmes, sinon tout le monde flotte.
    const shadow = new Sprite(whiteTexture())
    shadow.anchor.set(0.5, 0.5)
    shadow.width = 10
    shadow.height = 3.5
    shadow.alpha = anim ? 0.28 : 0
    shadow.tint = 0x000000
    this.entityLayer.addChild(shadow)

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

    return {
      sprite, shadow, hpBg, hpFill, telegraph,
      rx: view.x, ry: view.y, view, telegraphKey: '',
      anim, animT: Math.random() * 10,
    }
  }

  private destroyEntity(e: Entity): void {
    e.sprite.destroy()
    e.shadow.destroy()
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
        // L'événement porte lui-même la portée et l'ouverture : le client n'a
        // pas à savoir quelle arme a frappé.
        const isPlayer = this.entities.get(ev.id)?.view.kind === 'player'
        const g = new Graphics()
        drawWedge(g, ev.reach * TILE, ev.aim, ev.halfArc, isPlayer ? 0xfff2c4 : 0xff9a76, 0.5)
        g.x = ev.x * TILE
        g.y = ev.y * TILE
        this.fxLayer.addChild(g)
        this.effects.push({ node: g, ttl: SWING_SECONDS, life: SWING_SECONDS, vy: 0 })
        break
      }

      case 'blast': {
        const g = new Graphics()
        g.circle(0, 0, ev.radius * TILE)
        g.fill({ color: 0xff7a3c, alpha: 0.45 })
        g.x = ev.x * TILE
        g.y = ev.y * TILE
        g.scale.set(0.4)
        this.fxLayer.addChild(g)
        this.effects.push({ node: g, ttl: 0.35, life: 0.35, vy: 0, grow: 1 })
        break
      }

      case 'hit':
        this.spawnFloater(`-${ev.dmg}`, ev.x, ev.y, 0xff8e8e)
        break

      case 'death':
        if (ev.kind === 'player') this.spawnFloater('mort', ev.x, ev.y, 0xe2686d)
        break

      case 'downed':
        this.spawnFloater('à terre !', ev.x, ev.y, 0xffd166)
        break

      case 'revived':
        this.spawnFloater('relevé !', ev.x, ev.y, 0x8ee6a0)
        break

      case 'respawn':
        this.spawnFloater('debout !', ev.x, ev.y, 0x8ee6a0)
        break

      case 'levelup':
        this.spawnFloater(`niveau ${ev.level}`, ev.x, ev.y, 0xffe08a)
        break

      case 'keydrop':
        this.spawnFloater('la clé !', ev.x, ev.y, 0xe8c95a)
        break

      case 'pickup': {
        if (ev.kind === 'xp') break // les orbes sont déjà lisibles, inutile de spammer
        const label =
          ev.kind === 'heart' ? '+soin'
          : ev.kind === 'key' ? 'clé'
          : ev.kind === 'chest' ? 'coffre !'
          : (ev.label ?? 'arme')
        this.spawnFloater(label, ev.x, ev.y, 0xbfe8d8)
        break
      }

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
    this.clock += dt
    const k = 1 - Math.exp(-18 * dt)
    // Les objets au sol flottent légèrement : ça les distingue du décor peint.
    const bob = Math.sin(this.clock * 3) * 1.2

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
      const wasX = entity.sprite.x
      const wasY = entity.sprite.y
      entity.sprite.x = px
      entity.sprite.y = py
      entity.sprite.zIndex = entity.ry

      // Animation : idle au repos, course dès que la position rendue bouge.
      if (entity.anim) {
        const moving = view.alive && Math.hypot(px - wasX, py - wasY) > 0.35
        const frames = moving ? entity.anim.run : entity.anim.idle
        const fps = moving ? 11 : 6
        entity.animT += dt
        const frame = frames[Math.floor(entity.animT * fps) % frames.length]!
        if (entity.sprite.texture !== frame) entity.sprite.texture = frame
      }

      entity.shadow.x = px
      entity.shadow.y = py + 5
      entity.shadow.zIndex = entity.ry - 0.02
      entity.shadow.visible = entity.anim !== null && view.alive

      const scale = view.rank ? (RANK_SCALE[view.rank] ?? 1) : 1
      // On retourne le sprite selon la visée plutôt que selon le déplacement :
      // le personnage regarde sa cible même en reculant.
      entity.sprite.scale.x = (Math.cos(view.aim) < 0 ? -1 : 1) * scale
      entity.sprite.scale.y = scale
      // Un joueur à terre est couché : lisible d'un coup d'œil à travers la pièce.
      entity.sprite.rotation = view.downed ? Math.PI / 2 : 0

      const dimmed = !view.visible && !isSelf
      entity.sprite.alpha = !view.alive ? 0.3 : dimmed ? 0.4 : 1
      entity.sprite.tint = this.spriteTint(view)

      // Télégraphe : l'arc rouge qui annonce le coup et laisse le temps de sortir.
      const key = view.winding ? `${view.aim.toFixed(2)}:${view.species}:${scale}` : ''
      if (key !== entity.telegraphKey) {
        entity.telegraphKey = key
        entity.telegraph.visible = view.winding
        if (view.winding) {
          const def = MONSTERS[view.species]
          // Le chargeur annonce sa trajectoire, pas une zone de frappe : un
          // long couloir étroit devant lui.
          const isCharge = def?.behavior === 'charger'
          const reach = isCharge
            ? (def.dashSpeed ?? 10) * ((def.dashTicks ?? 12) / 30)
            : (def?.reach ?? 1)
          const halfArc = isCharge ? 0.16 : MONSTER_HALF_ARC
          drawWedge(entity.telegraph, reach * TILE, view.aim, halfArc, 0xff5252, 0.28)
        }
      }
      entity.telegraph.x = px
      entity.telegraph.y = py
      entity.telegraph.zIndex = entity.ry - 0.01

      this.layoutBar(entity, px, py, scale, dimmed)
    }

    for (const [, mover] of this.items) {
      mover.sprite.y = mover.ry * TILE + bob
    }

    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i]!
      fx.ttl -= dt
      fx.node.y += fx.vy * dt
      const t = Math.max(0, Math.min(1, fx.ttl / fx.life))
      fx.node.alpha = t
      // L'explosion s'ouvre jusqu'à son rayon réel pendant qu'elle s'efface.
      if (fx.grow) fx.node.scale.set(0.4 + (1 - t) * 0.6 * fx.grow)
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

  private spriteTint(view: ActorView): number {
    if (!view.alive) return 0x8899aa
    if (view.downed) return 0x9a6a6a
    if (view.dashing) return 0xffd0b0
    if (view.invuln && Math.floor(performance.now() / 90) % 2 === 0) return 0x8fb6ff
    return 0xffffff
  }

  /**
   * Barre sous le nom : vie en temps normal, progression de la relève quand le
   * joueur est à terre. Une seule barre, jamais deux à interpréter.
   */
  private layoutBar(entity: Entity, px: number, py: number, scale: number, dimmed: boolean): void {
    const { view } = entity
    const reviving = view.downed === true
    const ratio = reviving
      ? Math.max(0, Math.min(1, view.revive ?? 0))
      : Math.max(0, Math.min(1, view.hp / view.maxHp))

    const show = view.alive && !dimmed && (reviving || ratio < 1 || view.kind === 'player')
    entity.hpBg.visible = show
    entity.hpFill.visible = show
    if (!show) return

    const width = (TILE - 4) * scale
    const top = py - TILE * 0.75 * scale
    entity.hpFill.tint = reviving ? 0xffd166 : view.kind === 'player' ? 0x6ec06e : 0xd9605f
    entity.hpBg.width = width
    entity.hpBg.x = px
    entity.hpBg.y = top
    entity.hpBg.zIndex = entity.ry
    entity.hpFill.x = px - width / 2
    entity.hpFill.y = top
    entity.hpFill.width = width * ratio
    entity.hpFill.zIndex = entity.ry
  }
}
