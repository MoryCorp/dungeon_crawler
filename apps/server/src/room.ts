import type { WebSocket } from 'ws'
import {
  MAP_H,
  MAP_W,
  TICK_RATE,
  addPlayer,
  buildActorViews,
  buildItemViews,
  buildProjectileViews,
  createGame,
  packBits,
  removePlayer,
  setPlayerConnected,
  step,
  toBase64,
  type GameState,
  type PlayerInput,
  type ServerMsg,
} from '@dc/engine'
import { saveRoom, saveRun } from './persist.js'
import { RunTelemetry, type RunRecord } from './telemetry.js'

interface Client {
  ws: WebSocket
  playerId: string
  name: string
  input: PlayerInput | null
  /** Paquets `state` sautés pour cause de tampon plein : un `floor` complet le remettra à jour. */
  starved: boolean
}

/**
 * Tampon d'envoi au-delà duquel on cesse d'empiler des paquets `state` sur une
 * socket qui ne suit pas : ils se périment en 33 ms, les accumuler ne fait que
 * creuser le retard. Les paquets structurants (`floor`, `gameover`) passent
 * toujours — rater l'un d'eux fausse tout ce qui suit.
 */
const SOFT_BUFFER = 64 * 1024
/** Au-delà, la connexion ne rattrapera jamais : on la ferme proprement. */
const HARD_BUFFER = 1024 * 1024

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
const VIS_EVERY_TICKS = 5
export const MAX_PLAYERS = 4

export class Room {
  state: GameState
  clients = new Map<WebSocket, Client>()
  telemetry: RunTelemetry

  private scratch = {
    visible: new Uint8Array(MAP_W * MAP_H),
    flow: new Int16Array(MAP_W * MAP_H),
  }
  private floorDirty = true
  private lastSaveTick = 0
  private visCountdown = 0
  /** Wipe en cours : instant (ms) où la descente neuve démarre. */
  private resetAtMs: number | null = null
  /** Descentes relancées dans cette room — décale la graine de chaque run. */
  private resets = 0

  constructor(
    public readonly code: string,
    state?: GameState | null,
    run?: RunRecord | null,
    resets = 0,
  ) {
    // Trois cas au boot. État sauvegardé : on reprend sa run là où elle en
    // était. Pas d'état mais un relevé : la sauvegarde a été jetée (version
    // bumpée, ou wipe interrompu par un arrêt) — c'est une run NEUVE, index
    // suivant, jamais recollée sur l'ancienne. Rien du tout : première run.
    //
    // Le `Math.max` est une ceinture : état et relevé sont écrits dans la même
    // foulée, mais l'un peut survivre à l'autre (écriture échouée, fichier mis
    // en quarantaine). On ne redescend jamais un index de run — c'est ce qui
    // garantit qu'aucune graine n'est rejouée et qu'aucun relevé ne fusionne
    // deux runs sous le même numéro. Si le relevé est en avance, la télémétrie
    // ouvrira un enregistrement neuf pour l'étage courant : c'est voulu, son
    // dernier étage appartient à une run postérieure.
    const fromRun = run ? (run.runs ?? 0) + 1 : 0
    this.resets = state
      ? Math.max(resets, run?.runs ?? 0)
      : Math.max(resets, fromRun)
    this.state = state ?? createGame(seedFromCode(code) + this.resets * 7919, 1, true)
    this.telemetry = new RunTelemetry(code, this.state, run, this.resets)
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
    setPlayerConnected(this.state, playerId, true)
    this.clients.set(ws, { ws, playerId, name, input: null, starved: false })

    this.send(ws, { t: 'welcome', selfId: playerId, room: this.code, tickRate: TICK_RATE })
    this.send(ws, this.floorMsg())
    return { ok: true, playerId }
  }

  leave(ws: WebSocket): void {
    const client = this.clients.get(ws)
    if (!client) return
    this.clients.delete(ws)
    // Le personnage reste dans le donjon : on veut pouvoir se reconnecter et
    // retrouver son perso où il était, pas repartir du spawn. Mais il sort du
    // monde — sinon il resterait une cible immortelle qui aimante les
    // monstres et empêche le wipe de l'équipe encore présente.
    setPlayerConnected(this.state, client.playerId, false)
  }

  /**
   * Descente neuve après un wipe : état recréé sur une graine décalée,
   * personnages recréés au niveau 1, même room et même relevé — les étages
   * des runs successives s'empilent dans la même télémétrie.
   */
  private restart(): void {
    const record = this.telemetry.toRecord(this.state.seed, new Date().toISOString(), this.state)
    this.resets++
    this.state = createGame(seedFromCode(this.code) + this.resets * 7919, 1, true)
    for (const c of this.clients.values()) addPlayer(this.state, c.playerId, c.name)
    this.telemetry = new RunTelemetry(this.code, this.state, record, this.resets)
    this.resetAtMs = null
    this.floorDirty = true
    // Les compteurs vivaient sur les ticks de l'ANCIEN état : le nouveau
    // repart de zéro, et sans remise à zéro la sauvegarde périodique restait
    // suspendue de longues minutes après un wipe. On persiste tout de suite —
    // un crash juste après le wipe rechargerait sinon la run morte.
    this.lastSaveTick = 0
    this.visCountdown = 0
    void this.persist()
  }

  /** Retire définitivement le personnage (quitter la partie, pas juste fermer l'onglet). */
  forget(ws: WebSocket): void {
    const client = this.clients.get(ws)
    if (!client) return
    removePlayer(this.state, client.playerId)
    this.clients.delete(ws)
  }

  setInput(ws: WebSocket, input: PlayerInput | null): void {
    const client = this.clients.get(ws)
    if (!client) return
    if (!input) {
      client.input = null
      return
    }

    // Déplacement, visée et attaque sont des états : le paquet le plus récent
    // gagne. Boire, rouler et ramasser sont des impulsions d'une frame. À
    // 60 Hz côté client face aux 30 Hz de la simulation, leur paquet `true`
    // puis leur paquet `false` peuvent tous deux arriver entre deux ticks. Si
    // on ne gardait que le dernier, le serveur ne verrait jamais la commande.
    // On les accumule donc jusqu'au prochain tick, qui les consomme une fois.
    const pending = client.input
    client.input = { ...input }
    if (pending?.drink === true || input.drink === true) client.input.drink = true
    if (pending?.roll === true || input.roll === true) client.input.roll = true
    if (pending?.take === true || input.take === true) client.input.take = true
  }

  private floorMsg(): ServerMsg {
    return {
      t: 'floor',
      floor: this.state.floor,
      width: this.state.width,
      height: this.state.height,
      tiles: toBase64(this.state.tiles),
      decor: this.state.decor ?? [],
      rooms: this.state.rooms ?? [],
      scene: this.state.scene,
    }
  }

  tick(): void {
    const inputs: Record<string, PlayerInput | null> = {}
    for (const c of this.clients.values()) inputs[c.playerId] = c.input

    // La scène compte autant que le numéro : SAS → arène garde le même étage,
    // mais la carte change entièrement.
    const floorBefore = this.state.floor
    const sceneBefore = this.state.scene
    const { visible } = step(this.state, inputs, this.scratch)
    // Les impulsions mises en réserve ci-dessus ont maintenant été présentées
    // au moteur. Les états continus restent en place jusqu'au prochain paquet.
    for (const c of this.clients.values()) {
      if (!c.input) continue
      delete c.input.drink
      delete c.input.roll
      delete c.input.take
    }
    if (this.state.floor !== floorBefore || this.state.scene !== sceneBefore) {
      this.floorDirty = true
    }

    this.telemetry.observe(this.state, this.state.events)

    // La grille de la salle piégée modifie les tuiles en cours d'étage : le
    // client repeint sa carte sur le prochain paquet `floor`.
    for (const ev of this.state.events) {
      if (ev.t === 'trapclose' || ev.t === 'trapclear') this.floorDirty = true
      // Équipe au tapis : on annonce, on laisse l'écran s'afficher, puis on
      // relance une descente neuve dans la même room — la télémétrie continue
      // de s'empiler sur le même code, c'est voulu (chaîner des runs de test).
      if (ev.t === 'wipe' && this.resetAtMs === null) {
        this.broadcast({ t: 'gameover', floor: ev.floor })
        this.resetAtMs = Date.now() + 2500
        // Le drapeau part sur le disque tout de suite. Sinon un arrêt dans ces
        // 2,5 secondes — un redéploiement, ou simplement tout le monde qui se
        // déconnecte, ce qui fige la room — laissait une sauvegarde de partie
        // morte que la reprise rejouait comme si de rien n'était.
        void this.persist()
      }
    }
    if (this.resetAtMs !== null && Date.now() >= this.resetAtMs) this.restart()

    if (this.floorDirty) {
      this.broadcast(this.floorMsg())
      this.floorDirty = false
      this.visCountdown = 0
    }

    // Le brouillard suit la position, qui bouge d'au plus 0.14 tuile par tick :
    // l'envoyer 30 fois par seconde coûterait 20 Ko/s par client pour un
    // résultat visuellement identique. Un rafraîchissement tous les 5 ticks
    // (6 Hz) suffit largement.
    const withVis = this.visCountdown-- <= 0
    if (withVis) this.visCountdown = VIS_EVERY_TICKS

    this.broadcast({
      t: 'state',
      tick: this.state.tick,
      floor: this.state.floor,
      actors: buildActorViews(this.state, visible),
      projectiles: buildProjectileViews(this.state, visible),
      items: buildItemViews(this.state, visible),
      locked: this.state.stairsLocked,
      chasing: this.state.pursuers.length,
      intensity: Math.round(this.state.director.intensity * 100) / 100,
      bones: this.state.bones,
      ...(withVis ? { vis: toBase64(packBits(visible)) } : {}),
      events: this.state.events,
    })

    if (this.state.tick - this.lastSaveTick >= SAVE_EVERY_TICKS) {
      this.lastSaveTick = this.state.tick
      void this.persist()
    }
  }

  /** Écriture en vol, et au plus une en attente derrière elle. */
  private saving: Promise<void> = Promise.resolve()
  private saveQueued = false

  /**
   * Les écritures d'une même room se suivent, jamais ne se chevauchent : deux
   * `writeAtomic` concurrents sur le même fichier peuvent se renommer l'un
   * sur l'autre dans le désordre et laisser la version la plus vieille gagner.
   * Les appels pendant une écriture en cours se COALESCENT en une seule —
   * c'est l'état au moment où elle démarre qui compte, pas le nombre d'appels.
   */
  persist(): Promise<void> {
    if (this.saveQueued) return this.saving
    this.saveQueued = true
    this.saving = this.saving.then(async () => {
      this.saveQueued = false
      // Instantané cohérent, pris AVANT toute attente : état, relevé, compteur
      // et wipe en attente décrivent la même run. Entre deux `await`, un tick
      // peut relancer une descente neuve — les deux fichiers décrivaient alors
      // deux runs différentes, et un arrêt à cet instant les figeait ainsi.
      // `toRecord` en particulier photographie l'état vivant : appelé après
      // l'écriture, il photographiait un état qui avait déjà avancé.
      const state = this.state
      const resets = this.resets
      const pendingReset = this.resetAtMs !== null
      const record = this.telemetry.toRecord(state.seed, new Date().toISOString(), state)
      try {
        await saveRoom(this.code, state, resets, pendingReset)
        await saveRun(this.code, record)
      } catch (err) {
        console.error(`[room ${this.code}] sauvegarde échouée:`, err)
      }
    })
    return this.saving
  }

  send(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState !== ws.OPEN) return
    ws.send(JSON.stringify(msg))
  }

  /**
   * Les événements du tick (coups, morts, clé, grille du piège) ne voyagent
   * que dans les paquets `state`, et un paquet sauté est perdu : rien ne les
   * rejoue. C'est assumé. Ils ne pilotent que du son, des particules et du
   * texte flottant — la fin de partie, le changement d'étage, le verrou de
   * l'escalier et le HUD passent par d'autres canaux, tous prioritaires. Les
   * rejouer à la reprise produirait une salve d'effets périmés, plus
   * désorientante que le silence ; le seul effet durable, un recalage de
   * recul, est de toute façon corrigé par le paquet d'état suivant.
   */
  broadcast(msg: ServerMsg): void {
    const payload = JSON.stringify(msg)
    const droppable = msg.t === 'state'
    for (const c of this.clients.values()) {
      if (c.ws.readyState !== c.ws.OPEN) continue
      const buffered = c.ws.bufferedAmount
      if (buffered > HARD_BUFFER) {
        c.ws.close(4003, 'connexion trop lente')
        continue
      }
      if (droppable && buffered > SOFT_BUFFER) {
        c.starved = true
        continue
      }
      // La socket a rattrapé son retard : un `floor` complet d'abord, au cas
      // où elle aurait raté un changement d'étage pendant la disette.
      if (c.starved && droppable) {
        c.starved = false
        c.ws.send(JSON.stringify(this.floorMsg()))
      }
      c.ws.send(payload)
    }
  }
}
