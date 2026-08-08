/**
 * Couche d'abstraction des entrées.
 *
 * Clavier et manette alimentent tous les deux une seule structure `Intent` :
 * le reste du jeu ignore d'où vient l'ordre. Ajouter une source (tactile,
 * remap...) se fait ici et nulle part ailleurs.
 */
import type { Dir, Intent } from '@dc/engine'

// On lit `event.code`, qui désigne la *position physique* de la touche :
// KeyW/KeyA/KeyS/KeyD correspondent donc à ZQSD sur un clavier AZERTY sans
// aucun code spécifique à la disposition.
const KEY_VECTORS: Record<string, readonly [number, number]> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
}

const ATTACK_KEYS = new Set(['Space', 'Enter', 'KeyE'])

const DEADZONE = 0.4

function vectorToDir(dx: number, dy: number): Dir | null {
  if (dx === 0 && dy === 0) return null
  const v = dy < 0 ? 'N' : dy > 0 ? 'S' : ''
  const h = dx < 0 ? 'W' : dx > 0 ? 'E' : ''
  return `${v}${h}` as Dir
}

export class InputManager {
  private held = new Set<string>()
  private lastDir: Dir = 'S'
  private lastSent: string | null = null
  gamepadConnected = false

  constructor(private readonly onIntent: (intent: Intent | null) => void) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return
      if (KEY_VECTORS[e.code] || ATTACK_KEYS.has(e.code)) {
        e.preventDefault()
        this.held.add(e.code)
      }
    })
    window.addEventListener('keyup', (e) => this.held.delete(e.code))
    // Sans ça, changer d'onglet touche enfoncée laisse le perso courir seul.
    window.addEventListener('blur', () => this.held.clear())

    window.addEventListener('gamepadconnected', () => {
      this.gamepadConnected = true
    })
    window.addEventListener('gamepaddisconnected', () => {
      this.gamepadConnected = navigator.getGamepads().some((g) => g !== null)
    })
  }

  /** Lit la manette. Elle n'apparaît qu'après une première pression, par design du navigateur. */
  private readGamepad(): { dx: number; dy: number; attack: boolean } | null {
    const pads = navigator.getGamepads?.() ?? []
    const pad = pads.find((p) => p !== null)
    if (!pad) return null

    let dx = 0
    let dy = 0

    const ax = pad.axes[0] ?? 0
    const ay = pad.axes[1] ?? 0
    if (Math.abs(ax) > DEADZONE) dx = Math.sign(ax)
    if (Math.abs(ay) > DEADZONE) dy = Math.sign(ay)

    // Croix directionnelle (mapping "standard" : boutons 12 à 15).
    if (pad.buttons[12]?.pressed) dy = -1
    if (pad.buttons[13]?.pressed) dy = 1
    if (pad.buttons[14]?.pressed) dx = -1
    if (pad.buttons[15]?.pressed) dx = 1

    const attack = Boolean(pad.buttons[0]?.pressed || pad.buttons[2]?.pressed)
    return { dx, dy, attack }
  }

  /** À appeler à chaque frame. N'émet sur le réseau que lorsque l'intention change. */
  poll(): void {
    let dx = 0
    let dy = 0
    let attack = false

    for (const code of this.held) {
      const vec = KEY_VECTORS[code]
      if (vec) {
        dx += vec[0]
        dy += vec[1]
      }
      if (ATTACK_KEYS.has(code)) attack = true
    }

    const pad = this.readGamepad()
    if (pad) {
      if (pad.dx !== 0) dx = pad.dx
      if (pad.dy !== 0) dy = pad.dy
      attack ||= pad.attack
    }

    dx = Math.sign(dx)
    dy = Math.sign(dy)

    const dir = vectorToDir(dx, dy)
    if (dir) this.lastDir = dir

    let intent: Intent | null = null
    if (attack) intent = { type: 'attack', dir: dir ?? this.lastDir }
    else if (dir) intent = { type: 'move', dir }

    const key = intent ? `${intent.type}:${'dir' in intent ? intent.dir : ''}` : 'null'
    if (key !== this.lastSent) {
      this.lastSent = key
      this.onIntent(intent)
    }
  }

  /** Force le renvoi de l'intention courante (après une reconnexion). */
  resync(): void {
    this.lastSent = null
  }
}
