import { Application } from 'pixi.js'
import {
  DT,
  PLAYER_SPEED,
  fromBase64,
  movePhysical,
  unpackBits,
  type ActorView,
  type PlayerInput,
  type ServerMsg,
} from '@dc/engine'
import { InputManager, sameInput } from './input.js'
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

  const renderer = new Renderer(app)
  const input = new InputManager(app.canvas as HTMLCanvasElement)

  let selfId = ''
  let mapSize = 0
  let tiles: Uint8Array | null = null
  let mapW = 0
  let mapH = 0
  let alive = true

  /** État physique prédit du joueur local. */
  const local = { x: 0, y: 0, kx: 0, ky: 0 }
  let localReady = false
  let lastInput: PlayerInput = { mx: 0, my: 0, aim: 0, attack: false }
  let accumulator = 0
  let sendTimer = 0

  const debug = { frames: 0, states: 0, floors: 0, swings: 0, effects: 0, lastTick: 0 }
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
        mapW = msg.width
        mapH = msg.height
        debug.floors++
        mapSize = msg.width * msg.height
        tiles = fromBase64(msg.tiles)
        renderer.setFloor(msg.width, msg.height, tiles)
        floorLabel.textContent = String(msg.floor)
        // Nouvel étage : la position prédite n'a plus de sens.
        localReady = false
        break
      }

      case 'state': {
        if (mapSize === 0) break
        debug.states++
        debug.lastTick = msg.tick

        const visible = msg.vis ? unpackBits(fromBase64(msg.vis), mapSize) : null
        renderer.applyState(msg.actors, visible, msg.events)
        floorLabel.textContent = String(msg.floor)
        updateHud(msg.actors)

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

  function updateHud(actors: ActorView[]): void {
    const self = actors.find((a) => a.id === selfId)
    hpLabel.textContent = self ? `${self.hp}/${self.maxHp}` : '—'

    const party = actors.filter((a) => a.kind === 'player')
    partyBox.innerHTML = party
      .map((p) => {
        const state = !p.alive ? 'K.O.' : `${p.hp}/${p.maxHp}`
        const color = !p.alive ? '#e2686d' : p.id === selfId ? '#d9a441' : '#8a90a2'
        const escaped = p.name.replace(/[<>&]/g, '')
        return `<div style="color:${color}">${escaped} · ${state}</div>`
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
      accumulator += dt
      let steps = 0
      while (accumulator >= DT && steps < 5) {
        movePhysical(tiles, mapW, mapH, local, current.mx, current.my, PLAYER_SPEED)
        accumulator -= DT
        steps++
      }
      if (steps === 5) accumulator = 0
      renderer.predicted = { x: local.x, y: local.y }
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
    net.connect({ t: 'join', room, name })
  })
}

void main()
