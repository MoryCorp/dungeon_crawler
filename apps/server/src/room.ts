import type { WebSocket } from 'ws'
import {
  MAP_H,
  MAP_W,
  TICK_RATE,
  addPlayer,
  buildActorViews,
  createGame,
  packBits,
  removePlayer,
  step,
  toBase64,
  type GameState,
  type Intent,
  type ServerMsg,
} from '@dc/engine'
import { saveRoom } from './persist.js'

interface Client {
  ws: WebSocket
  playerId: string
  name: string
  intent: Intent | null
}

/** Graine déterministe à partir du code de room : le même code rejoue le même donjon. */
function seedFromCode(code: string): number {
  let h = 2166136261
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Identifiant stable dérivé du pseudo : se reconnecter reprend son personnage. */
function playerIdFor(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 16)
  return `p_${slug || 'anon'}`
}

const SAVE_EVERY_TICKS = TICK_RATE * 10
export const MAX_PLAYERS = 4

export class Room {
  state: GameState
  clients = new Map<WebSocket, Client>()

  private scratch = {
    visible: new Uint8Array(MAP_W * MAP_H),
    flow: new Int16Array(MAP_W * MAP_H),
  }
  private floorDirty = true
  private lastSaveTick = 0

  constructor(
    public readonly code: string,
    state?: GameState | null,
  ) {
    this.state = state ?? createGame(seedFromCode(code))
  }

  get isEmpty(): boolean {
    return this.clients.size === 0
  }

  join(ws: WebSocket, name: string): { ok: true; playerId: string } | { ok: false; reason: string } {
    const playerId = playerIdFor(name)

    // Une reconnexion sous le même pseudo remplace l'ancienne socket plutôt que
    // d'occuper un deuxième slot — sinon un refresh de page consomme une place.
    for (const [sock, c] of this.clients) {
      if (c.playerId === playerId) {
        this.clients.delete(sock)
        try {
          sock.close(4000, 'reconnexion depuis un autre onglet')
        } catch {
          /* socket déjà morte */
        }
      }
    }

    if (this.clients.size >= MAX_PLAYERS) {
      return { ok: false, reason: `La partie ${this.code} est pleine (${MAX_PLAYERS} joueurs).` }
    }

    addPlayer(this.state, playerId, name)
    this.clients.set(ws, { ws, playerId, name, intent: null })

    this.send(ws, { t: 'welcome', selfId: playerId, room: this.code, tickRate: TICK_RATE })
    this.send(ws, this.floorMsg())
    return { ok: true, playerId }
  }

  leave(ws: WebSocket): void {
    const client = this.clients.get(ws)
    if (!client) return
    this.clients.delete(ws)
    // Le personnage reste dans le donjon : on veut pouvoir se reconnecter et
    // retrouver son perso où il était, pas repartir du spawn.
  }

  /** Retire définitivement le personnage (quitter la partie, pas juste fermer l'onglet). */
  forget(ws: WebSocket): void {
    const client = this.clients.get(ws)
    if (!client) return
    removePlayer(this.state, client.playerId)
    this.clients.delete(ws)
  }

  setIntent(ws: WebSocket, intent: Intent | null): void {
    const client = this.clients.get(ws)
    if (client) client.intent = intent
  }

  private floorMsg(): ServerMsg {
    return {
      t: 'floor',
      floor: this.state.floor,
      width: this.state.width,
      height: this.state.height,
      tiles: toBase64(this.state.tiles),
    }
  }

  tick(): void {
    const intents: Record<string, Intent | null> = {}
    for (const c of this.clients.values()) intents[c.playerId] = c.intent

    const floorBefore = this.state.floor
    const { visible } = step(this.state, intents, this.scratch)
    if (this.state.floor !== floorBefore) this.floorDirty = true

    if (this.floorDirty) {
      this.broadcast(this.floorMsg())
      this.floorDirty = false
    }

    this.broadcast({
      t: 'state',
      tick: this.state.tick,
      floor: this.state.floor,
      actors: buildActorViews(this.state, visible),
      vis: toBase64(packBits(visible)),
      events: this.state.events,
    })

    if (this.state.tick - this.lastSaveTick >= SAVE_EVERY_TICKS) {
      this.lastSaveTick = this.state.tick
      void this.persist()
    }
  }

  async persist(): Promise<void> {
    try {
      await saveRoom(this.code, this.state)
    } catch (err) {
      console.error(`[room ${this.code}] sauvegarde échouée:`, err)
    }
  }

  send(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState !== ws.OPEN) return
    ws.send(JSON.stringify(msg))
  }

  broadcast(msg: ServerMsg): void {
    const payload = JSON.stringify(msg)
    for (const c of this.clients.values()) {
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(payload)
    }
  }
}
