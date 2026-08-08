import { Application } from 'pixi.js'
import {
  BLEED_OUT_TICKS,
  DT,
  SPRINT_MIN_START,
  STARTING_WEAPON,
  TICK_RATE,
  WEAPONS,
  fromBase64,
  movePhysical,
  playerSpeed,
  stepSprint,
  unpackBits,
  xpForLevel,
  type ActorView,
  type PlayerInput,
  type ServerMsg,
} from '@dc/engine'
import { GameAudio } from './audio.js'
import { InputManager, sameInput } from './input.js'
import { loadPack } from './pack.js'
import { Net } from './net.js'
import { Renderer } from './render.js'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T

const lobby = $('lobby')
const form = $<HTMLFormElement>('join-form')
const nameInput = $<HTMLInputElement>('name')
const roomInput = $<HTMLInputElement>('room')
const errorBox = $('error')
const hud = $('hud')
const partyBox = $('party')
const hint = $('hint')
const floorLabel = $('floor')
const hpLabel = $('hp')
const weaponLabel = $('weapon')
const levelLabel = $('level')
const bonesLabel = $('bones')
const potionRow = $('potion-row')
const potionLabel = $('potion')
const xpFill = $('xp-fill')
const staminaFill = $('stamina-fill')
const objective = $('objective')
const chase = $('chase')
const downedBox = $('downed')
const downedSub = $('downed-sub')
const roomLabel = $('room-label')

/** Au-delà de cet écart avec le serveur, on recale sèchement plutôt que d'interpoler. */
const SNAP_DISTANCE = 1.2
/** Correction douce appliquée à chaque paquet quand l'écart reste faible. */
const CORRECTION = 0.2

async function main(): Promise<void> {
  const app = new Application()
  await app.init({
    background: '#0b0c10',
    resizeTo: window,
    antialias: false,
    // Un jeu en pixel art n'a aucun intérêt à être rendu en résolution
    // physique : on garde 1 pixel CSS = 1 pixel de rendu.
    resolution: 1,
    autoDensity: false,
  })
  document.body.appendChild(app.canvas)

  // Le pack de sprites se charge avant le premier rendu ; s'il manque (dépôt
  // cloné sans les assets), l'atlas procédural prend le relais sans un mot.
  await loadPack()

  const renderer = new Renderer(app)
  const input = new InputManager(app.canvas as HTMLCanvasElement)
  const audio = new GameAudio()

  // M coupe le son — sauf quand on tape son pseudo dans le lobby.
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'm') return
    if (document.activeElement instanceof HTMLInputElement) return
    audio.toggleMute()
  })

  let selfId = ''
  let mapSize = 0
  let tiles: Uint8Array | null = null
  let mapW = 0
  let mapH = 0
  let lastFloor = 0
  let alive = true
  let downed = false
  let hasted = false
  let weaponId = STARTING_WEAPON
  /**
   * Copie locale de l'état de frappe. Le serveur ralentit le joueur pendant son
   * coup ; si le client ne rejouait pas la même règle, chaque clic produirait un
   * écart de position corrigé au paquet suivant — un caoutchouc à chaque coup.
   * On rejoue donc la cadence de l'arme sur l'horloge locale, qui est en avance
   * sur le serveur plutôt qu'en retard.
   */
  let localReadyAtMs = 0
  let localSwingUntilMs = 0
  /** Tick serveur du dernier paquet : sert à afficher le compte à rebours de saignement. */
  let serverTick = 0
  let downedSince = 0

  /** État physique prédit du joueur local. */
  const local = { x: 0, y: 0, kx: 0, ky: 0 }
  /**
   * Sprint prédit localement, avec la même fonction que le serveur. La jauge est
   * recalée sur celle du serveur à chaque paquet ; entre deux paquets elle
   * descend ici, sinon la barre avancerait par à-coups de 30 Hz.
   */
  const localSprint = { stamina: 1, sprinting: false, sprintedAt: -999, downed: false }
  let predictTick = 0
  let localReady = false
  let lastInput: PlayerInput = { mx: 0, my: 0, aim: 0, attack: false, sprint: false }
  let accumulator = 0
  let sendTimer = 0

  const debug = {
    frames: 0, states: 0, floors: 0, swings: 0, effects: 0, lastTick: 0,
    monsters: 0, items: 0, projectiles: 0, x: 0, y: 0,
    // Position faisant autorité, et écart avec la prédiction. Un écart qui
    // grimpe pendant qu'on frappe signalerait que le client n'applique pas la
    // même pénalité de déplacement que le serveur.
    sx: 0, sy: 0, drift: 0,
  }
  ;(window as unknown as { __dc: typeof debug }).__dc = debug

  const net = new Net({
    onStatus: (status) => {
      if (status === 'closed' && selfId) {
        roomLabel.textContent = `${roomInput.value.toUpperCase()} (reconnexion…)`
      } else if (status === 'open' && selfId) {
        roomLabel.textContent = roomInput.value.toUpperCase()
      }
    },
    onMessage: handleMessage,
  })

  function handleMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome': {
        selfId = msg.selfId
        renderer.selfId = msg.selfId
        lobby.classList.add('hidden')
        hud.classList.remove('hidden')
        partyBox.classList.remove('hidden')
        hint.classList.remove('hidden')
        roomLabel.textContent = msg.room
        location.hash = msg.room
        break
      }

      case 'floor': {
        // Même étage : c'est une mise à jour de tuiles (la grille du piège),
        // pas une descente — on garde l'exploration et la position prédite.
        const samefloor = msg.floor === lastFloor && mapSize === msg.width * msg.height
        lastFloor = msg.floor
        mapW = msg.width
        mapH = msg.height
        debug.floors++
        mapSize = msg.width * msg.height
        tiles = fromBase64(msg.tiles)
        renderer.setFloor(msg.width, msg.height, tiles, samefloor)
        audio.setFloor(msg.floor)
        floorLabel.textContent = String(msg.floor)
        if (!samefloor) localReady = false
        break
      }

      case 'state': {
        if (mapSize === 0) break
        debug.states++
        debug.lastTick = msg.tick

        serverTick = msg.tick
        debug.monsters = msg.actors.reduce((n, a) => n + (a.kind === 'monster' ? 1 : 0), 0)
        debug.items = msg.items.length
        debug.projectiles = msg.projectiles.length
        const visible = msg.vis ? unpackBits(fromBase64(msg.vis), mapSize) : null
        renderer.bones = msg.bones ?? 0
        renderer.floor = msg.floor
        renderer.applyState(msg.actors, msg.projectiles, msg.items, visible, msg.events)
        bonesLabel.textContent = String(msg.bones ?? 0)
        audio.setIntensity(msg.intensity ?? 0)
        for (const ev of msg.events) audio.onEvent(ev, selfId)
        floorLabel.textContent = String(msg.floor)
        updateHud(msg.actors, msg.locked, msg.chasing)

        for (const ev of msg.events) {
          if (ev.t === 'swing' && ev.id === selfId) debug.swings++
        }

        const self = msg.actors.find((a) => a.id === selfId)
        if (self) reconcile(self)

        // Le recul n'est pas prédit côté client : quand on se fait toucher, on
        // recale sur l'autorité plutôt que de diverger pendant une seconde.
        for (const ev of msg.events) {
          if (ev.t === 'hit' && ev.to === selfId) {
            local.x = ev.x
            local.y = ev.y
          }
        }
        break
      }

      case 'error': {
        errorBox.textContent = msg.msg
        lobby.classList.remove('hidden')
        break
      }
    }
  }

  function reconcile(self: ActorView): void {
    alive = self.alive
    hasted = self.hasted === true
    // Le serveur fait autorité sur le souffle : la prédiction locale ne sert
    // qu'à remplir les 33 ms entre deux paquets.
    if (self.stamina !== undefined) localSprint.stamina = self.stamina
    debug.sx = self.x
    debug.sy = self.y
    debug.drift = Math.hypot(self.x - local.x, self.y - local.y)
    if (!localReady || !self.alive) {
      local.x = self.x
      local.y = self.y
      local.kx = 0
      local.ky = 0
      localReady = true
      renderer.predicted = { x: local.x, y: local.y }
      return
    }

    const dist = Math.hypot(self.x - local.x, self.y - local.y)
    if (dist > SNAP_DISTANCE) {
      local.x = self.x
      local.y = self.y
    } else {
      local.x += (self.x - local.x) * CORRECTION
      local.y += (self.y - local.y) * CORRECTION
    }
  }

  function updateHud(actors: ActorView[], locked: boolean, chasing: number): void {
    const self = actors.find((a) => a.id === selfId)
    if (self?.weapon) weaponId = self.weapon
    hpLabel.textContent = self ? `${self.hp}/${self.maxHp}` : '—'
    weaponLabel.textContent = WEAPONS[self?.weapon ?? '']?.label ?? '—'
    levelLabel.textContent = String(self?.level ?? 1)
    potionRow.classList.toggle('hidden', !self?.potion)
    if (self?.potion) potionLabel.textContent = self.potion

    // La barre d'XP est relative au palier courant, pas au total cumulé :
    // sinon elle n'avance visiblement plus passé quelques niveaux.
    if (self?.xpNext !== undefined) {
      const prev = xpForLevel(self.level ?? 1)
      const ratio = ((self.xp ?? 0) - prev) / Math.max(1, self.xpNext - prev)
      xpFill.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`
    }

    chase.classList.toggle('hidden', chasing === 0)
    chase.textContent =
      chasing === 1
        ? 'Un monstre descend derrière vous'
        : `${chasing} monstres descendent derrière vous`

    objective.classList.remove('hidden')
    objective.classList.toggle('done', !locked)
    objective.textContent = locked
      ? 'Escalier verrouillé — tuez le gardien et récupérez la clé'
      : 'Escalier ouvert — descendez quand vous êtes prêts'

    const wasDowned = downed
    downed = self?.downed === true
    if (downed && !wasDowned) downedSince = serverTick
    downedBox.classList.toggle('hidden', !downed)
    if (downed) {
      const left = Math.max(0, BLEED_OUT_TICKS - (serverTick - downedSince)) / TICK_RATE
      const helper = actors.some(
        (a) => a.kind === 'player' && a.id !== selfId && a.alive && !a.downed,
      )
      downedSub.textContent = helper
        ? `Un coéquipier doit rester près de toi · ${left.toFixed(0)} s`
        : `Personne pour te relever · ${left.toFixed(0)} s`
    }

    const party = actors.filter((a) => a.kind === 'player')
    partyBox.innerHTML = party
      .map((p) => {
        const state = !p.alive ? 'mort' : p.downed ? 'à terre !' : `${p.hp}/${p.maxHp}`
        const color = !p.alive || p.downed ? '#e2686d' : p.id === selfId ? '#d9a441' : '#8a90a2'
        const escaped = p.name.replace(/[<>&]/g, '')
        const lvl = p.level ? ` <span style="opacity:.6">n${p.level}</span>` : ''
        return `<div style="color:${color}">${escaped}${lvl} · ${state}</div>`
      })
      .join('')
  }

  app.ticker.add((ticker) => {
    debug.frames++
    const dt = Math.min(0.1, ticker.deltaMS / 1000)

    // Le personnage est toujours au centre de l'écran : la souris vise par
    // rapport à ce point.
    const current = input.sample(app.screen.width / 2, app.screen.height / 2)

    // Envoi à cadence fixe, et immédiatement si l'entrée change de façon
    // significative (un clic ne doit pas attendre le prochain créneau).
    sendTimer -= dt
    if (!sameInput(current, lastInput) || sendTimer <= 0) {
      lastInput = current
      sendTimer = DT
      if (selfId) net.send({ t: 'input', input: current })
    }

    // Prédiction locale à pas fixe, avec exactement le même code que le
    // serveur : la divergence ne peut venir que de la latence, jamais des règles.
    if (localReady && tiles && alive) {
      // On rejoue la cadence de l'arme localement pour connaître notre propre
      // état de frappe sans attendre le serveur.
      const weapon = WEAPONS[weaponId] ?? WEAPONS[STARTING_WEAPON]!
      const nowMs = performance.now()
      if (current.attack && !downed && nowMs >= localReadyAtMs) {
        localReadyAtMs = nowMs + (weapon.cooldown / TICK_RATE) * 1000
        localSwingUntilMs = nowMs + (weapon.swing / TICK_RATE) * 1000
      }
      const swinging = nowMs < localSwingUntilMs
      const penalty = swinging ? weapon.movePenalty : 1
      const moving = current.mx !== 0 || current.my !== 0
      localSprint.downed = downed

      accumulator += dt
      let steps = 0
      while (accumulator >= DT && steps < 5) {
        const sprinting = stepSprint(localSprint, predictTick, current.sprint, moving, swinging)
        movePhysical(
          tiles, mapW, mapH, local,
          current.mx, current.my,
          playerSpeed({ downed }, penalty, sprinting, hasted),
        )
        predictTick++
        accumulator -= DT
        steps++
      }
      staminaFill.style.width = `${Math.round(localSprint.stamina * 100)}%`
      staminaFill.classList.toggle('spent', localSprint.stamina < SPRINT_MIN_START)
      if (steps === 5) accumulator = 0
      renderer.predicted = { x: local.x, y: local.y }
      debug.x = local.x
      debug.y = local.y
    }

    renderer.render(dt)
    debug.effects = renderer.effectCount
  })

  nameInput.value = localStorage.getItem('dc:name') ?? ''
  roomInput.value = location.hash.slice(1).toUpperCase() || localStorage.getItem('dc:room') || ''

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    errorBox.textContent = ''
    const name = nameInput.value.trim()
    const room = roomInput.value.trim().toUpperCase()
    if (!name || !room) return
    localStorage.setItem('dc:name', name)
    localStorage.setItem('dc:room', room)
    // Le clic « rejoindre » est le geste utilisateur qui débloque l'audio.
    audio.start()
    net.connect({ t: 'join', room, name })
  })
}

void main()
