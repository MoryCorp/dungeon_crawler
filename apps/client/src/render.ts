/**
 * Rendu Pixi.
 *
 * Deux cadences : `applyState()` au rythme du réseau (30 Hz), `render()` à
 * chaque frame. Le joueur local n'est jamais interpolé — il est dessiné à sa
 * position prédite, sinon on sentirait un aller-retour à chaque paquet.
 */
import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import type { ActorView, Decor, GameEvent, ItemView, ProjectileView, Room } from '@dc/engine'
import {
  MONSTERS, MONSTER_HALF_ARC, PICKUP_RANGE, ROLL_TICKS, TICK_RATE, WEAPONS, biomeOf, chestPrice,
} from '@dc/engine'
import { Tile } from '@dc/engine'
import {
  WEAPON_ATTACK,
  packAnim,
  packItemTexture,
  packNpcImage,
  packReady,
  paintPackTile,
  paintRoomFloors,
  type AnimSet,
  type AttackKind,
  type Dir,
} from './pack.js'
import {
  SCALE,
  TILE,
  makeActorTexture,
  makeCanvas,
  makeItemTexture,
  makeProjectileTexture,
  paintDecor,
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
  /** Vitesse rendue lissée (tuiles/s) et état de course avec hystérésis :
   * sans elle, un déplacement au seuil fait clignoter idle/course à chaque
   * frame — le glitch de jambes qui se superposent. */
  speed: number
  moving: boolean
  /** Direction de déplacement lissée : c'est elle qui oriente le sprite en
   * course, pas la visée — sinon on marche à reculons. */
  mvx: number
  mvy: number
  /** Geste d'attaque en cours : temps écoulé et durée d'une passe. */
  attackT: number
  attackDur: number
  attackKind: AttackKind | null
  /** Orientation retenue du sprite : elle ne revient jamais d'elle-même au
   * curseur, elle attend qu'un mouvement ou un coup lui donne une raison. */
  facing: number
  /** Secondes pendant lesquelles la visée garde la main sur l'orientation. */
  aimHold: number
  /** Miroir retenu, pour ne pas basculer sur un mouvement quasi vertical. */
  flip: 1 | -1
  /** Temps écoulé dans la roulade en cours — pilote le tour complet du sprite. */
  rollT: number
  /** Horloge du dernier fantôme déposé derrière une roulade. */
  ghostAt: number
}

/** Cadavre : l'animation de mort du pack, jouée une fois puis retirée. */
interface Corpse {
  sprite: Sprite
  frames: Texture[]
  t: number
}

interface Effect {
  node: Container
  ttl: number
  life: number
  vy: number
  /** Grossissement appliqué sur la durée de vie (explosions). */
  grow?: number
  /** Opacité de départ : les fantômes de roulade naissent déjà translucides. */
  fade?: number
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
const ROLL_SECONDS = ROLL_TICKS / TICK_RATE

/** Un élite se repère à sa taille avant même de lire son nom. */
const RANK_SCALE: Record<string, number> = { elite: 1.35, boss: 1.9 }

/**
 * Les pieds des cadres du pack touchent le bord bas : le sprite est ancré là,
 * et posé ce décalage sous le centre de l'acteur pour que le point de contact
 * visuel coïncide avec le bas du cercle de collision (rayon 0.33 tuile). C'est
 * ce qui rend les couloirs honnêtes : ce sont les pieds qui doivent passer.
 */
const FEET_OFFSET = 5

/**
 * Le geste dure exactement la fenêtre de frappe de l'arme : ce qu'on voit à
 * l'écran et ce qui est en train de blesser sont la même chose. L'estoc de
 * l'épée est bref, la taille de la hache s'étire — c'est déjà l'identité des
 * armes, il n'y avait pas de raison de la réinventer côté client.
 */
function attackSeconds(weapon: string | undefined): number {
  return (WEAPONS[weapon ?? '']?.swing ?? 6) / TICK_RATE
}

const CORPSE_FPS = 12

/** Rémanence de la visée sur l'orientation, en secondes. */
const AIM_HOLD = 1
/** En deçà, la composante horizontale est trop faible pour changer de profil. */
const FLIP_DEADZONE = 0.2
/**
 * Au-delà de ce rapport |dy|/|dx| on prend la feuille de face ou de dos : c'est
 * un cône de 30° autour de la verticale, pas la moitié du cercle. Le pack n'a
 * que trois feuilles, et une diagonale rendue de dos se lit très mal — on tourne
 * autour d'un monstre bien plus souvent qu'on ne l'aborde plein nord.
 */
const VERTICAL_CONE = 1.73

/** Direction de feuille selon la visée. Écran : y croît vers le bas. */
function dirFromAim(aim: number): Dir {
  const dx = Math.cos(aim)
  const dy = Math.sin(aim)
  if (Math.abs(dy) > Math.abs(dx) * VERTICAL_CONE) return dy > 0 ? 'down' : 'up'
  return 'side'
}

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
  /** Tuiles de l'étage courant — la minicarte les relit chaque rafraîchissement. */
  private tiles: Uint8Array = new Uint8Array(0)
  private entities = new Map<string, Entity>()
  private items = new Map<string, Mover>()
  private projectiles = new Map<string, Mover>()
  private effects: Effect[] = []
  private corpses: Corpse[] = []
  private clock = 0

  private width = 0
  private height = 0
  selfId = ''
  /** Position prédite du joueur local, en tuiles. */
  predicted: { x: number; y: number } | null = null
  /** Bourse d'équipe et étage courant : pour l'étiquette de prix des coffres. */
  bones = 0
  floor = 1
  private priceTags = new Map<string, Text>()
  private takeTag: Text | null = null
  private takeGauge: Graphics | null = null
  private takeHoverId: string | null = null
  private takeHoldProgress = 0
  private lastItems: ItemView[] = []

  constructor(private readonly app: Application) {
    this.entityLayer.sortableChildren = true
    this.world.addChild(this.mapLayer, this.itemLayer, this.entityLayer, this.fxLayer)
    this.world.scale.set(SCALE)
    app.stage.addChild(this.world)
  }

  setFloor(
    width: number,
    height: number,
    tiles: Uint8Array,
    keepExplored = false,
    decor: readonly Decor[] = [],
    floor = 1,
    rooms: readonly Room[] = [],
    scene?: 'sas' | 'boss',
  ): void {
    this.width = width
    this.height = height
    this.tiles = tiles
    // Repeindre le même étage (la grille du piège vient de bouger) ne doit
    // pas effacer ce qu'on a déjà exploré.
    if (!keepExplored || this.explored.length !== width * height) {
      this.explored = new Uint8Array(width * height)
    }

    // Le SAS est verdoyant quel que soit l'acte : c'est un jardin suspendu
    // entre deux biomes, pas un étage du biome courant. L'arène, elle, garde
    // les tuiles de l'acte qu'elle conclut.
    const biome = scene === 'sas' ? 'jardin' : biomeOf(floor).tileset
    const canvas = makeCanvas(width * TILE, height * TILE)
    const ctx = canvas.getContext('2d')!
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Le pack rend faux pour porte/escalier/grille après avoir posé la
        // dalle du biome : le peintre procédural n'ajoute alors que le glyphe.
        const packed = paintPackTile(ctx, tiles, width, height, x, y, biome)
        if (!packed) {
          const tile = tiles[y * width + x]!
          const overlayOnly = tile !== Tile.Floor && tile !== Tile.Wall && packReady()
          paintTile(ctx, tile, x * TILE, y * TILE, overlayOnly)
        }
      }
    }
    // Chaque salle reçoit son matériau de sol (parquet, tapis…) par-dessus le
    // sol commun — les couloirs restent en pierre, et c'est ce contraste qui
    // fait lire les pièces comme des pièces.
    paintRoomFloors(ctx, tiles, width, height, rooms, biome)
    // Le décor est cuit dans la même image que le sol : rien à animer, rien à
    // trier en profondeur, et le brouillard le masque sans code en plus.
    for (const d of decor) {
      // Le marchand du SAS : le vrai PNJ du pack si on l'a, ancré pieds au bas
      // de sa tuile — son cadre de 64 px déborde vers le haut, sur le mur.
      const npc = d.kind === 'marchand' ? packNpcImage() : null
      if (npc) {
        ctx.drawImage(npc, d.x * TILE + TILE / 2 - npc.width / 2, (d.y + 1) * TILE - npc.height)
      } else {
        paintDecor(ctx, d.kind, d.x, d.y)
      }
    }
    // `destroy(true)` : la texture de carte (un canvas plein écran) part avec
    // le sprite — sinon chaque étage en laissait une de plus sur le GPU.
    this.mapSprite?.destroy(true)
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
    // Tout ce qui vit dans fxLayer et qu'on référence encore doit repartir à
    // null : le removeChildren vient de les détacher, et une référence vers un
    // nœud orphelin passe le `if (!this.takeTag)` sans jamais réapparaître à
    // l'écran — le prompt « clic droit · arme » mourait à la première descente.
    this.takeTag?.destroy()
    this.takeTag = null
    this.takeGauge?.destroy()
    this.takeGauge = null
    for (const tag of this.priceTags.values()) tag.destroy()
    this.priceTags.clear()
    for (const c of this.corpses) c.sprite.destroy()
    this.corpses = []
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
      const packed = item.kind === 'weapon' ? packItemTexture(item.weapon) : null
      const sprite = new Sprite(packed ?? makeItemTexture(item.kind, item.weapon))
      sprite.anchor.set(0.5, 0.5)
      return sprite
    })

    // Un cœur qu'on ne peut pas prendre (plafond de soin atteint) s'éteint :
    // un soin refusé sans le dire ressemble à un bug, pas à une règle.
    const me = actors.find((a) => a.id === this.selfId)
    const capped = me !== undefined && me.hpCeil !== undefined && me.hp >= me.hpCeil
    for (const item of items) {
      if (item.kind !== 'heart') continue
      const mover = this.items.get(item.id)
      if (mover) mover.sprite.alpha = capped ? 0.35 : 1
    }

    this.lastItems = items
    this.syncPriceTags(items)

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
    const sprite = new Sprite(anim ? anim.idle.side[0] : makeActorTexture(view.species, view.kind === 'player'))
    // Marcheurs ancrés aux pieds : les cadres idle et course n'ont pas la même
    // taille, seul le bord bas est un invariant. Volants et repli : au centre.
    sprite.anchor.set(0.5, anim?.grounded ? 1 : 0.5)
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
      speed: 0, moving: false, mvx: 1, mvy: 0,
      attackT: Infinity, attackDur: 1, attackKind: null,
      facing: view.aim, aimHold: 0, flip: 1,
      rollT: 0, ghostAt: 0,
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
        const entity = this.entities.get(ev.id)
        const isPlayer = entity?.view.kind === 'player'

        // Déclenche le geste d'arme du pack ; l'arc du coup est dans les
        // cadres, le secteur reste dessiné (plus discret) car lui seul montre
        // la vraie portée — le geste d'une lance est plus court que sa pique.
        let animated = false
        if (entity && isPlayer && entity.anim?.attack) {
          const kind = WEAPON_ATTACK[entity.view.weapon ?? '']
          if (kind) {
            entity.attackKind = kind
            entity.attackT = 0
            entity.attackDur = attackSeconds(entity.view.weapon)
            animated = true
          }
        }

        const g = new Graphics()
        drawWedge(g, ev.reach * TILE, ev.aim, ev.halfArc, isPlayer ? 0xfff2c4 : 0xff9a76, animated ? 0.22 : 0.5)
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
        else this.spawnCorpse(ev.species, ev.x, ev.y)
        break

      // La récompense d'un coup bien placé doit se voir, sinon le joueur ne
      // saura jamais que couper une préparation est une option.
      case 'stagger': {
        this.spawnFloater('interrompu !', ev.x, ev.y, 0xbfe3ff)
        const g = new Graphics()
        g.circle(0, 0, TILE * 0.6)
        g.stroke({ color: 0xbfe3ff, width: 2, alpha: 0.9 })
        g.x = ev.x * TILE
        g.y = ev.y * TILE
        this.fxLayer.addChild(g)
        this.effects.push({ node: g, ttl: 0.25, life: 0.25, vy: 0, grow: 1.6 })
        break
      }

      case 'parry': {
        // L'étincelle du renvoi : brève, dorée, à l'endroit de l'impact.
        const g = new Graphics()
        g.circle(0, 0, TILE * 0.35)
        g.stroke({ color: 0xf3d06a, width: 2, alpha: 0.95 })
        g.x = ev.x * TILE
        g.y = ev.y * TILE
        this.fxLayer.addChild(g)
        this.effects.push({ node: g, ttl: 0.2, life: 0.2, vy: 0, grow: 1.8 })
        break
      }

      case 'dashbreak': {
        this.spawnFloater('stoppé !', ev.x, ev.y, 0xf3d06a)
        const g = new Graphics()
        g.circle(0, 0, TILE * 0.5)
        g.stroke({ color: 0xf3d06a, width: 2, alpha: 0.9 })
        g.x = ev.x * TILE
        g.y = ev.y * TILE
        this.fxLayer.addChild(g)
        this.effects.push({ node: g, ttl: 0.25, life: 0.25, vy: 0, grow: 1.4 })
        break
      }

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

      case 'spend':
        this.spawnFloater(`−${ev.amount} os`, ev.x, ev.y, 0xe8c95a)
        break

      case 'trapwarn':
        this.spawnFloater('les braseros s\'allument…', ev.x, ev.y, 0xe8845a)
        break

      case 'trapclose':
        this.spawnFloater('LA GRILLE TOMBE', ev.x, ev.y, 0xe2686d)
        break

      case 'trapclear':
        this.spawnFloater('la grille se relève', ev.x, ev.y, 0x8ee6a0)
        break

      case 'rest':
        this.spawnFloater('la Directrice se tait ici', ev.x, ev.y, 0x9ecbe8)
        break

      case 'drink':
        this.spawnFloater(ev.potion === 'souffle' ? 'souffle !' : 'vitesse !', ev.x, ev.y, 0x9ecbe8)
        break

      case 'pickup': {
        // Les orbes et les ossements tombent à chaque mort : le compteur du
        // HUD suffit, un flottant par ramassage serait du bruit.
        if (ev.kind === 'xp' || ev.kind === 'bone') break
        const label =
          ev.kind === 'heart' ? '+soin'
          : ev.kind === 'key' ? 'clé'
          : ev.kind === 'chest' ? 'coffre !'
          : ev.kind === 'cap' ? 'plafond de soin +10 %'
          : ev.kind === 'soin' ? 'soigné'
          : ev.kind === 'fiole_souffle' || ev.kind === 'fiole_vitesse' ? 'fiole en poche'
          : (ev.label ?? 'arme')
        this.spawnFloater(label, ev.x, ev.y, 0xbfe8d8)
        break
      }

      default:
        break
    }
  }

  /**
   * L'animation de mort du pack, jouée une fois à l'endroit de la disparition.
   * L'acteur n'est déjà plus dans l'état serveur à ce moment-là : le cadavre
   * est un pur effet client, retourné au hasard pour varier les charniers.
   */
  private spawnCorpse(species: string, x: number, y: number): void {
    const anim = packAnim(species, false)
    if (!anim?.death?.length) return
    const sprite = new Sprite(anim.death[0])
    sprite.anchor.set(0.5, anim.grounded ? 1 : 0.5)
    sprite.x = x * TILE
    sprite.y = y * TILE + (anim.grounded ? FEET_OFFSET : 0)
    sprite.zIndex = y - 0.03
    if (Math.random() < 0.5) sprite.scale.x = -1
    this.entityLayer.addChild(sprite)
    this.corpses.push({ sprite, frames: anim.death, t: 0 })
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

  /**
   * Étiquette de prix au-dessus de chaque coffre visible : dorée quand
   * l'équipe peut payer, éteinte sinon. Le refus d'ouverture n'a pas besoin
   * de message — le prix affiché est déjà l'explication.
   */
  private syncPriceTags(items: ItemView[]): void {
    const seen = new Set<string>()
    for (const item of items) {
      const price = item.kind === 'chest' ? chestPrice(this.floor) : item.price
      if (price === undefined) continue
      seen.add(item.id)
      let tag = this.priceTags.get(item.id)
      if (!tag) {
        tag = new Text({
          text: '',
          style: {
            fontFamily: 'ui-monospace, monospace',
            fontSize: 7,
            fill: 0xffffff,
            stroke: { color: 0x000000, width: 2 },
          },
        })
        tag.anchor.set(0.5, 1)
        this.fxLayer.addChild(tag)
        this.priceTags.set(item.id, tag)
      }
      tag.text = `${price} os`
      tag.style.fill = this.bones >= price ? 0xe8c95a : 0x8a90a2
      tag.x = item.x * TILE
      tag.y = item.y * TILE - TILE * 0.55
    }
    for (const [id, tag] of this.priceTags) {
      if (seen.has(id)) continue
      tag.destroy()
      this.priceTags.delete(id)
    }
    this.syncTakePrompt(items)
  }

  /**
   * Invite au-dessus de l'arme visée. Une arme se ramasse en gardant le
   * curseur dessus et le clic droit enfoncé : l'invite dit laquelle et
   * comment, et la jauge montre la prise en cours. Une seule invite à la
   * fois — deux étiquettes superposées dans un couloir ne se lisent pas.
   */
  private syncTakePrompt(items: ItemView[]): void {
    const px = this.predicted?.x ?? this.entities.get(this.selfId)?.view.x
    const py = this.predicted?.y ?? this.entities.get(this.selfId)?.view.y

    // L'arme sous le curseur d'abord — c'est elle qu'on est en train de
    // prendre. À défaut, la plus proche à portée, comme rappel du geste.
    let best: ItemView | null = this.takeHoverId
      ? items.find((i) => i.id === this.takeHoverId && i.kind === 'weapon') ?? null
      : null
    if (!best && px !== undefined && py !== undefined) {
      let bestD = PICKUP_RANGE
      for (const item of items) {
        if (item.kind !== 'weapon') continue
        const d = Math.hypot(item.x - px, item.y - py)
        if (d <= bestD) {
          bestD = d
          best = item
        }
      }
    }

    if (!best) {
      if (this.takeTag) this.takeTag.visible = false
      if (this.takeGauge) this.takeGauge.visible = false
      return
    }
    if (!this.takeTag) {
      this.takeTag = new Text({
        text: '',
        style: {
          fontFamily: 'ui-monospace, monospace',
          fontSize: 7,
          fill: 0xf0e6d2,
          stroke: { color: 0x000000, width: 2 },
        },
      })
      this.takeTag.anchor.set(0.5, 1)
      this.fxLayer.addChild(this.takeTag)
    }
    if (!this.takeGauge) {
      this.takeGauge = new Graphics()
      this.fxLayer.addChild(this.takeGauge)
    }
    const inRange =
      px !== undefined && py !== undefined &&
      Math.hypot(best.x - px, best.y - py) <= PICKUP_RANGE
    const label = WEAPONS[best.weapon ?? '']?.label ?? 'arme'
    this.takeTag.text = `clic droit · ${label}`
    this.takeTag.alpha = inRange ? 1 : 0.5
    this.takeTag.visible = true
    this.takeTag.x = best.x * TILE
    this.takeTag.y = best.y * TILE - TILE * 0.55

    // La jauge : un trait qui se remplit sous l'étiquette pendant la prise.
    this.takeGauge.clear()
    if (this.takeHoldProgress > 0 && best.id === this.takeHoverId) {
      const w = TILE * 0.9
      const x0 = best.x * TILE - w / 2
      const y0 = best.y * TILE - TILE * 0.45
      this.takeGauge.rect(x0, y0, w, 1.5).fill({ color: 0x000000, alpha: 0.6 })
      this.takeGauge
        .rect(x0, y0, w * Math.min(1, this.takeHoldProgress), 1.5)
        .fill({ color: 0xf0c86a })
      this.takeGauge.visible = true
    } else {
      this.takeGauge.visible = false
    }
  }

  /** L'arme au sol sous le curseur (coordonnées écran), s'il y en a une. */
  weaponUnderCursor(sx: number, sy: number): ItemView | null {
    const local = this.world.toLocal({ x: sx, y: sy })
    const wx = local.x / TILE
    const wy = local.y / TILE
    let best: ItemView | null = null
    let bestD = 0.6
    for (const item of this.lastItems) {
      if (item.kind !== 'weapon') continue
      const d = Math.hypot(item.x - wx, item.y - wy)
      if (d <= bestD) {
        bestD = d
        best = item
      }
    }
    return best
  }

  /** La prise en cours, affichée par syncTakePrompt : arme visée + jauge 0-1. */
  setTakeHold(id: string | null, progress: number): void {
    this.takeHoverId = id
    this.takeHoldProgress = progress
  }

  /**
   * Peint la minicarte dans le contexte fourni.
   *
   * Elle ne montre que l'exploré — jamais le donjon entier. Sa raison d'être
   * n'est pas de révéler la carte mais d'empêcher de repasser deux fois au
   * même endroit sans le savoir, ce que le champ de vision de neuf tuiles rend
   * autrement inévitable. L'escalier n'apparaît qu'une fois vu : le trouver
   * reste le travail du joueur.
   */
  paintMinimap(ctx: CanvasRenderingContext2D, cell: number): void {
    const w = this.width
    const h = this.height
    ctx.clearRect(0, 0, w * cell, h * cell)
    if (w === 0 || this.tiles.length !== w * h) return

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (!this.explored[i]) continue
        const t = this.tiles[i]!
        if (t === 0) ctx.fillStyle = '#1b1e28'
        else if (t === 3) ctx.fillStyle = '#e8c95a'
        else if (t === 4) ctx.fillStyle = '#6b4a4a'
        else ctx.fillStyle = '#48506250'
        ctx.fillRect(x * cell, y * cell, cell, cell)
      }
    }

    // Les coéquipiers d'abord, soi-même par-dessus : on doit toujours pouvoir
    // se trouver, même superposé à quelqu'un.
    const dot = (px: number, py: number, color: string, size: number): void => {
      ctx.fillStyle = color
      ctx.fillRect(
        Math.round(px * cell) - size / 2,
        Math.round(py * cell) - size / 2,
        size, size,
      )
    }
    for (const e of this.entities.values()) {
      if (e.view.kind !== 'player' || e.view.id === this.selfId) continue
      dot(e.view.x, e.view.y, e.view.alive && !e.view.downed ? '#7fb2e8' : '#8a5a5a', cell * 2)
    }
    const selfEntity = this.entities.get(this.selfId)
    const sx = this.predicted?.x ?? selfEntity?.view.x
    const sy = this.predicted?.y ?? selfEntity?.view.y
    if (sx !== undefined && sy !== undefined) dot(sx, sy, '#f0e6d2', cell * 2 + 1)
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
      const wasY = entity.sprite.y - (entity.anim?.grounded ? FEET_OFFSET : 0)
      entity.sprite.x = px
      entity.sprite.y = py + (entity.anim?.grounded ? FEET_OFFSET : 0)
      entity.sprite.zIndex = entity.ry

      let dir: Dir = 'side'
      let facing = entity.facing

      if (entity.anim) {
        // Vitesse rendue lissée + hystérésis : on n'entre en course qu'au-delà
        // de 1.4 t/s et on n'en sort que sous 0.7 — un pas au seuil ne fait
        // plus clignoter les jambes entre deux animations.
        const dx = px - wasX
        const dy = py - wasY
        const step = Math.hypot(dx, dy)
        const teleported = step > TILE * 2
        const inst = dt > 0 && !teleported ? step / TILE / dt : 0
        entity.speed += (Math.min(inst, 15) - entity.speed) * Math.min(1, dt * 14)
        entity.moving = view.alive && entity.speed > (entity.moving ? 0.7 : 1.4)
        if (step > 0.05 && !teleported) {
          const k2 = Math.min(1, dt * 12)
          entity.mvx += (dx / step - entity.mvx) * k2
          entity.mvy += (dy / step - entity.mvy) * k2
        }

        entity.animT += dt
        entity.attackT += dt
        const attacking =
          entity.attackKind !== null &&
          entity.anim.attack !== undefined &&
          entity.attackT < entity.attackDur

        // Trois règles, dans cet ordre. Au combat on regarde sa cible, et on
        // continue de la regarder un instant après le coup : sans cette
        // rémanence, kiter vers la droite en frappant vers la gauche faisait
        // pivoter le personnage à chaque geste. En déplacement seul, on regarde
        // où l'on va — viser à droite en courant à gauche donnait une marche à
        // reculons. À l'arrêt, on ne fait rien : l'orientation reste où elle
        // était au lieu de revenir se coller au curseur.
        if (view.winding || view.swinging) entity.aimHold = AIM_HOLD
        entity.aimHold = Math.max(0, entity.aimHold - dt)
        if (attacking || entity.aimHold > 0) entity.facing = view.aim
        else if (entity.moving) entity.facing = Math.atan2(entity.mvy, entity.mvx)
        facing = entity.facing
        dir = dirFromAim(facing)

        let frame: Texture
        if (attacking) {
          // Une passe complète du geste sur la durée du coup, sans boucler.
          const frames = entity.anim.attack![entity.attackKind!][dir]
          const i = Math.floor((entity.attackT / entity.attackDur) * frames.length)
          frame = frames[Math.min(i, frames.length - 1)]!
        } else {
          const frames = entity.moving ? entity.anim.run[dir] : entity.anim.idle[dir]
          const fps = entity.moving ? 11 : 6
          frame = frames[Math.floor(entity.animT * fps) % frames.length]!
        }
        if (entity.sprite.texture !== frame) entity.sprite.texture = frame
      }

      entity.shadow.x = px
      entity.shadow.y = py + FEET_OFFSET
      entity.shadow.zIndex = entity.ry - 0.02
      entity.shadow.visible = entity.anim !== null && view.alive

      const scale = view.rank ? (RANK_SCALE[view.rank] ?? 1) : 1
      // Les feuilles de face et de dos ne se retournent pas : seule la vue de
      // côté a un miroir. On ne rebascule que sur une composante horizontale
      // franche, sinon un déplacement presque vertical fait clignoter le
      // personnage entre ses deux profils.
      const cos = Math.cos(facing)
      if (Math.abs(cos) > FLIP_DEADZONE) entity.flip = cos < 0 ? -1 : 1
      entity.sprite.scale.x = entity.flip * scale
      entity.sprite.scale.y = scale
      // Roulade : un tour complet dans le sens du regard, sprite légèrement
      // tassé, et des images rémanentes déposées derrière — c'est ce qui rend
      // l'i-frame lisible pour les autres joueurs comme pour soi.
      const grounded = entity.anim?.grounded === true
      if (view.rolling === true && view.alive) {
        entity.rollT += dt
        const spin = Math.min(1, entity.rollT / ROLL_SECONDS)
        // Le pivot doit être le centre du corps. Ancré aux pieds — ce qu'il
        // est le reste du temps, pour que le point de contact au sol soit
        // juste — la rotation faisait décrire au personnage un arc de la
        // hauteur de son sprite : une toupie géante autour de ses chevilles.
        // On bascule l'ancrage au centre le temps de la roulade et on remonte
        // la position d'autant, pour que rien ne bouge à l'écran.
        const half = grounded ? (entity.sprite.texture.height * scale) / 2 : 0
        if (grounded) {
          entity.sprite.anchor.set(0.5, 0.5)
          entity.sprite.y = py + FEET_OFFSET - half
        }
        entity.sprite.rotation = spin * Math.PI * 2 * entity.flip
        entity.sprite.scale.y = scale * 0.9
        if (this.clock - entity.ghostAt > 0.05) {
          entity.ghostAt = this.clock
          const ghost = new Sprite(entity.sprite.texture)
          ghost.anchor.set(0.5, grounded ? 0.5 : 0.5)
          ghost.x = entity.sprite.x
          ghost.y = entity.sprite.y
          ghost.rotation = entity.sprite.rotation
          ghost.scale.set(entity.sprite.scale.x, entity.sprite.scale.y)
          ghost.tint = 0x9aa8c0
          ghost.zIndex = entity.ry - 0.01
          this.entityLayer.addChild(ghost)
          this.effects.push({ node: ghost, ttl: 0.18, life: 0.18, vy: 0, fade: 0.45 })
        }
      } else {
        if (grounded && entity.sprite.anchor.y !== 1) entity.sprite.anchor.set(0.5, 1)
        entity.rollT = 0
        // Un joueur à terre est couché : lisible d'un coup d'œil à travers la pièce.
        entity.sprite.rotation = view.downed ? Math.PI / 2 : 0
      }

      const dimmed = !view.visible && !isSelf
      // Un coéquipier déconnecté reste visible mais fantomatique : on sait
      // où l'attendre sans le confondre avec un joueur en jeu.
      entity.sprite.alpha = !view.alive ? 0.3 : view.offline ? 0.35 : dimmed ? 0.4 : 1
      entity.sprite.tint = this.spriteTint(view)

      // Télégraphe : l'arc rouge qui annonce le coup et laisse le temps de
      // sortir. La géométrie vient du serveur (telegraphReach/HalfArc) : lui
      // seul connaît le pattern figé — la déduire de l'espèce faisait mentir
      // les deux patterns du colosse. Repli espèce pour un vieux serveur.
      const reach =
        view.telegraphReach ??
        (MONSTERS[view.species]?.behavior === 'charger'
          ? (MONSTERS[view.species]!.dashSpeed ?? 10) *
            ((MONSTERS[view.species]!.dashTicks ?? 12) / TICK_RATE)
          : MONSTERS[view.species]?.reach ?? 1)
      const halfArc =
        view.telegraphHalfArc ??
        (MONSTERS[view.species]?.behavior === 'charger' ? 0.16 : MONSTER_HALF_ARC)
      const key = view.winding
        ? `${view.aim.toFixed(2)}:${reach.toFixed(2)}:${halfArc.toFixed(3)}:${scale}`
        : ''
      if (key !== entity.telegraphKey) {
        entity.telegraphKey = key
        entity.telegraph.visible = view.winding
        if (view.winding) {
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

    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i]!
      c.t += dt
      const idx = Math.floor(c.t * CORPSE_FPS)
      if (idx >= c.frames.length) {
        c.sprite.destroy()
        this.corpses.splice(i, 1)
      } else if (c.sprite.texture !== c.frames[idx]) {
        c.sprite.texture = c.frames[idx]!
      }
    }

    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i]!
      fx.ttl -= dt
      fx.node.y += fx.vy * dt
      const t = Math.max(0, Math.min(1, fx.ttl / fx.life))
      fx.node.alpha = t * (fx.fade ?? 1)
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
    // Les personnages du pack sont presque deux tuiles de haut : la barre se
    // place au-dessus de la tête, pas à mi-corps.
    const top = py - (entity.anim?.grounded ? TILE * 1.6 : TILE * 0.75) * scale
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
