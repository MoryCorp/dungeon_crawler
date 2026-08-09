/**
 * Couche d'abstraction des entrées.
 *
 * Clavier+souris et manette produisent la même structure `PlayerInput` : un
 * vecteur de déplacement, un angle de visée, un booléen d'attaque. Le reste du
 * jeu ignore d'où ça vient.
 *
 * La visée est découplée du déplacement — c'est ce qui règle le problème de
 * l'ennemi en diagonale : on frappe où on regarde, pas où on marche.
 */
import type { PlayerInput } from '@dc/engine'

// `event.code` désigne la position physique de la touche : KeyW/A/S/D
// correspondent donc à ZQSD sur AZERTY sans code spécifique à la disposition.
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

/** Roulade — la barre d'espace, sous le pouce. L'attaque reste au clic gauche. */
const ROLL_KEYS = new Set(['Space'])

/** Sprint : les deux Maj, sous les deux mains selon qu'on joue ZQSD ou flèches. */
const SPRINT_KEYS = new Set(['ShiftLeft', 'ShiftRight'])

/** Boire la fiole portée — R près de ZQSD, F près des flèches. */
const DRINK_KEYS = new Set(['KeyR', 'KeyF'])

/**
 * Touches que le navigateur détournerait. Tab passe au champ suivant, ce qui
 * sort du jeu sans prévenir — on se le réserve dès maintenant, l'inventaire à
 * venir en aura besoin.
 */
const SWALLOWED = new Set(['Tab'])

const STICK_DEADZONE = 0.28
const AIM_DEADZONE = 0.35

export class InputManager {
  private held = new Set<string>()
  private drinkQueued = false
  private rollQueued = false
  private padRollHeld = false
  private mouseDown = false
  private mouseX = 0
  private mouseY = 0
  private aim = 0
  gamepadConnected = false

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (SWALLOWED.has(e.code)) e.preventDefault()
      if (e.repeat) return
      if (KEY_VECTORS[e.code] || SPRINT_KEYS.has(e.code)) {
        e.preventDefault()
        this.held.add(e.code)
      }
      // Boire et rouler sont des impulsions, pas des états : on les consomme
      // au prochain échantillon, une seule fois.
      if (DRINK_KEYS.has(e.code)) {
        e.preventDefault()
        this.drinkQueued = true
      }
      if (ROLL_KEYS.has(e.code)) {
        e.preventDefault()
        this.rollQueued = true
      }
    })
    window.addEventListener('keyup', (e) => this.held.delete(e.code))
    // Sans ça, changer d'onglet touche enfoncée laisse le perso courir seul.
    window.addEventListener('blur', () => {
      this.held.clear()
      this.mouseDown = false
    })

    canvas.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX
      this.mouseY = e.clientY
    })
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        e.preventDefault()
        this.mouseDown = true
      }
    })
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false
    })
    // Le clic droit ouvrirait le menu contextuel en plein combat.
    canvas.addEventListener('contextmenu', (e) => e.preventDefault())

    window.addEventListener('gamepadconnected', () => {
      this.gamepadConnected = true
    })
    window.addEventListener('gamepaddisconnected', () => {
      this.gamepadConnected = navigator.getGamepads().some((g) => g !== null)
    })
  }

  private readGamepad(): {
    mx: number
    my: number
    aim: number | null
    attack: boolean
    sprint: boolean
  } | null {
    const pads = navigator.getGamepads?.() ?? []
    const pad = pads.find((p) => p !== null)
    if (!pad) return null

    let mx = pad.axes[0] ?? 0
    let my = pad.axes[1] ?? 0
    if (Math.hypot(mx, my) < STICK_DEADZONE) {
      mx = 0
      my = 0
    }

    // Croix directionnelle (mapping "standard").
    if (pad.buttons[12]?.pressed) my = -1
    if (pad.buttons[13]?.pressed) my = 1
    if (pad.buttons[14]?.pressed) mx = -1
    if (pad.buttons[15]?.pressed) mx = 1

    // Stick droit pour viser. S'il est au repos, on garde la dernière visée
    // plutôt que de recentrer brutalement le personnage.
    const ax = pad.axes[2] ?? 0
    const ay = pad.axes[3] ?? 0
    const aim = Math.hypot(ax, ay) >= AIM_DEADZONE ? Math.atan2(ay, ax) : null

    const attack = Boolean(
      pad.buttons[0]?.pressed || pad.buttons[2]?.pressed || pad.buttons[7]?.pressed,
    )
    // Gâchette gauche : sous l'index, libre pendant qu'on vise et qu'on frappe.
    const sprint = Boolean(pad.buttons[6]?.pressed || pad.buttons[4]?.pressed)
    // B (bouton 1) : roulade. Front montant seulement — c'est une impulsion.
    const rollHeld = Boolean(pad.buttons[1]?.pressed)
    if (rollHeld && !this.padRollHeld) this.rollQueued = true
    this.padRollHeld = rollHeld
    return { mx, my, aim, attack, sprint }
  }

  /**
   * Construit l'entrée courante. `originX/Y` est la position à l'écran du
   * personnage — la souris vise par rapport à lui.
   */
  sample(originX: number, originY: number): PlayerInput {
    let mx = 0
    let my = 0
    let attack = this.mouseDown
    let sprint = false

    for (const code of this.held) {
      const vec = KEY_VECTORS[code]
      if (vec) {
        mx += vec[0]
        my += vec[1]
      }
      if (SPRINT_KEYS.has(code)) sprint = true
    }

    // La souris vise dès qu'elle a bougé au moins une fois.
    const dx = this.mouseX - originX
    const dy = this.mouseY - originY
    if (dx !== 0 || dy !== 0) this.aim = Math.atan2(dy, dx)

    const pad = this.readGamepad()
    if (pad) {
      if (pad.mx !== 0 || pad.my !== 0) {
        mx = pad.mx
        my = pad.my
      }
      if (pad.aim !== null) this.aim = pad.aim
      attack ||= pad.attack
      sprint ||= pad.sprint
    }

    const drink = this.drinkQueued
    this.drinkQueued = false
    const roll = this.rollQueued
    this.rollQueued = false
    return { mx, my, aim: this.aim, attack, sprint, drink, roll }
  }
}

/** Deux entrées sont-elles assez proches pour ne pas justifier un paquet ? */
export function sameInput(a: PlayerInput, b: PlayerInput): boolean {
  return (
    a.mx === b.mx &&
    a.my === b.my &&
    a.attack === b.attack &&
    a.sprint === b.sprint &&
    a.drink === b.drink &&
    a.roll === b.roll &&
    Math.abs(a.aim - b.aim) < 0.02
  )
}
