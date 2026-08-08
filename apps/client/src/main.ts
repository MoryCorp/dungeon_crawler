import { Application } from 'pixi.js'
import { fromBase64, unpackBits, type ActorView, type ServerMsg } from '@dc/engine'
import { InputManager } from './input.js'
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
  let mapSize = 0
  let selfId = ''

  // Compteurs exposés pour le debug depuis la console : `__dc` dit d'un coup
  // d'œil si le réseau arrive et si la boucle de rendu tourne.
  const debug = { frames: 0, states: 0, floors: 0, lastTick: 0 }
  ;(window as unknown as { __dc: typeof debug }).__dc = debug

  const net = new Net({
    onStatus: (status) => {
      if (status === 'closed' && selfId) {
        roomLabel.textContent = `${roomInput.value.toUpperCase()} (reconnexion…)`
      }
    },
    onMessage: (msg: ServerMsg) => handleMessage(msg),
  })

  const input = new InputManager((intent) => net.send({ t: 'intent', intent }))

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
        input.resync()
        break
      }
      case 'floor': {
        debug.floors++
        mapSize = msg.width * msg.height
        renderer.setFloor(msg.width, msg.height, fromBase64(msg.tiles))
        floorLabel.textContent = String(msg.floor)
        break
      }
      case 'state': {
        if (mapSize === 0) break
        debug.states++
        debug.lastTick = msg.tick
        const visible = unpackBits(fromBase64(msg.vis), mapSize)
        renderer.applyState(msg.actors, visible, msg.events)
        floorLabel.textContent = String(msg.floor)
        updateHud(msg.actors)
        break
      }
      case 'error': {
        errorBox.textContent = msg.msg
        lobby.classList.remove('hidden')
        break
      }
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
    input.poll()
    renderer.render(Math.min(0.1, ticker.deltaMS / 1000))
  })

  // Préremplissage : pseudo mémorisé, code de partie depuis le lien partagé.
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
