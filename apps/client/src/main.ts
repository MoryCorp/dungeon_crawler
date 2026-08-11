import { Application } from 'pixi.js'
import {
  BLEED_OUT_TICKS,
  DT,
  PICKUP_RANGE,
  ROLL_MIN_STAMINA,
  ROLL_SPEED,
  SPRINT_MIN_START,
  STARTING_WEAPON,
  TICK_RATE,
  WEAPONS,
  fromBase64,
  movePhysical,
  playerSpeed,
  stepRoll,
  stepSprint,
  unpackBits,
  xpForLevel,
  type ActorView,
  type PlayerInput,
  type Scene,
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
const staminaTrack = $('stamina-track')
const minimap = $<HTMLCanvasElement>('minimap')
/** Deux pixels par tuile : la carte de 64 tuiles tient dans 128 px. */
const MINIMAP_CELL = 2
const objective = $('objective')
const hpFill = $('hp-fill')
const hpCap = $('hp-cap')
const weaponGlyph = $('weapon-glyph')
const vitalsBox = $('vitals')
const goVeil = $('gameover')
const goSub = $('gameover-sub')

/**
 * Voile GAME OVER : bref, sans bouton — le serveur relance tout seul une
 * descente neuve dans la même room deux secondes plus tard.
 */
let goTimer = 0
function showGameOver(floor: number): void {
  goSub.textContent = `Étage ${floor} — nouvelle descente…`
  goVeil.classList.add('visible')
  clearTimeout(goTimer)
  goTimer = window.setTimeout(() => goVeil.classList.remove('visible'), 2300)
}
const chase = $('chase')
const downedBox = $('downed')
const downedSub = $('downed-sub')
const roomLabel = $('room-label')

/** Au-delà de cet écart avec le serveur, on recale sèchement plutôt que d'interpoler. */
const SNAP_DISTANCE = 1.2
/** Correction douce appliquée à chaque paquet quand l'écart reste faible. */
const CORRECTION = 0.2

/** Ce qu'affiche le HUD à la place du seul numéro d'étage. */
function sceneLabel(floor: number, scene?: Scene): string {
  return scene === 'entree' ? 'Vestiaire'
    : scene === 'sas' ? `${floor} · Sanctuaire`
    : scene === 'boss' ? `${floor} · Gardien`
    : String(floor)
}

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
  let lastScene: Scene | undefined
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
  const localSprint: {
    stamina: number
    sprinting: boolean
    sprintedAt: number
    downed: boolean
    rollUntil?: number
    rollVx?: number
    rollVy?: number
    rolledAt?: number
    rollWantAt?: number
    freshUntil?: number
    invulnUntil?: number
  } = { stamina: 1, sprinting: false, sprintedAt: -999, downed: false }
  let predictTick = 0
  /**
   * Impulsion de roulade en attente d'un pas de prédiction. L'échantillon
   * d'entrée la consomme à la frame, mais la simulation avance par pas fixes :
   * sans cette réserve, une impulsion tombée entre deux pas serait perdue
   * localement — et le serveur, lui, roulerait quand même. Caoutchouc garanti.
   */
  let pendingRoll = false
  let localReady = false
  let lastInput: PlayerInput = { mx: 0, my: 0, aim: 0, attack: false, sprint: false }
  let accumulator = 0
  let sendTimer = 0
  let mapTimer = 0
  const miniCtx = minimap.getContext('2d')

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
        // La scène compte : SAS → arène partagent le numéro mais pas la carte.
        const samefloor =
          msg.floor === lastFloor && msg.scene === lastScene && mapSize === msg.width * msg.height
        lastFloor = msg.floor
        lastScene = msg.scene
        mapW = msg.width
        mapH = msg.height
        debug.floors++
        mapSize = msg.width * msg.height
        tiles = fromBase64(msg.tiles)
        renderer.setFloor(msg.width, msg.height, tiles, samefloor, msg.decor ?? [], msg.floor, msg.rooms ?? [], msg.scene)
        audio.setFloor(msg.floor, msg.scene)
        floorLabel.textContent = sceneLabel(msg.floor, msg.scene)
        if (!samefloor) localReady = false
        break
      }

      case 'gameover': {
        // Écran bref, puis le serveur renvoie un étage 1 tout neuf. On oublie
        // l'étage courant pour que ce prochain paquet `floor` soit traité
        // comme une vraie descente (carte et brouillard remis à zéro), même
        // si on meurt à l'étage 1.
        showGameOver(msg.floor)
        lastFloor = -1
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
        // Même libellé enrichi que le paquet `floor` : sans ça, le premier
        // paquet d'état écrasait « Sanctuaire »/« Gardien » après un tick.
        floorLabel.textContent = sceneLabel(msg.floor, lastScene)
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
    const hpRatio = self ? Math.max(0, Math.min(1, self.hp / Math.max(1, self.maxHp))) : 0
    hpFill.style.width = `${hpRatio * 100}%`
    hpFill.classList.toggle('warn', hpRatio > 0.25 && hpRatio <= 0.5)
    hpFill.classList.toggle('crit', hpRatio > 0 && hpRatio <= 0.25)
    // Le trait du plafond de soin : ce que les cœurs ne remonteront pas.
    const ceilRatio = self?.hpCeil !== undefined ? self.hpCeil / Math.max(1, self.maxHp) : 1
    hpCap.style.display = ceilRatio < 1 ? 'block' : 'none'
    hpCap.style.left = `${Math.round(ceilRatio * 100)}%`
    weaponLabel.textContent = WEAPONS[self?.weapon ?? '']?.label ?? '—'
    weaponGlyph.textContent = (WEAPONS[self?.weapon ?? '']?.label ?? '—').charAt(0).toUpperCase()
    levelLabel.textContent = String(self?.level ?? 1)
    potionRow.classList.toggle('empty', !self?.potion)
    if (self?.potion) potionLabel.textContent = self.potion
    else potionLabel.textContent = '—'

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
    objective.textContent =
      lastScene === 'entree'
        ? 'Choisissez votre arme — clic droit maintenu — puis descendez'
        : locked
          ? 'Escalier verrouillé — tuez le gardien et récupérez la clé'
          : 'Escalier ouvert — descendez quand vous êtes prêts'

    const wasDowned = downed
    downed = self?.downed === true
    if (downed && !wasDowned) downedSince = serverTick
    downedBox.classList.toggle('hidden', !downed)
    vitalsBox.classList.toggle('downed', downed)
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
        const cls =
          (!p.alive ? 'dead' : p.downed ? 'down' : '') + (p.id === selfId ? ' self' : '')
        const state = !p.alive ? 'mort' : p.downed ? 'à terre !' : `${p.hp}/${p.maxHp}`
        const escaped = p.name.replace(/[<>&]/g, '')
        const pct = p.alive ? Math.round((100 * p.hp) / Math.max(1, p.maxHp)) : 0
        return `<div class="pcard ${cls}">
          <div class="prow"><span class="pname">${escaped}</span><span class="plvl">N${p.level ?? 1}</span><span class="pstate">${state}</span></div>
          <div class="pbar"><div class="pbar-fill" style="width:${pct}%"></div></div>
        </div>`
      })
      .join('')
  }

  // Prise délibérée (arme au sol, article payant de l'étal) : curseur dessus +
  // clic droit maintenu. La jauge se remplit en une seconde, l'impulsion part
  // une seule fois par pression — relâcher avant de reprendre, pour qu'un
  // échange ne ré-avale pas l'arme qu'on vient de poser, et pour qu'un appui
  // long ne vide pas la bourse commune article après article.
  const TAKE_HOLD_S = 1.0
  let takeHoldId: string | null = null
  let takeHoldS = 0
  let takeFired = false

  app.ticker.add((ticker) => {
    debug.frames++
    const dt = Math.min(0.1, ticker.deltaMS / 1000)

    const hover = renderer.takeableUnderCursor(input.mouseX, input.mouseY)
    // Le coffre se prend d'un poil plus loin que le reste, comme dans le moteur.
    const hoverRange = hover?.kind === 'chest' ? PICKUP_RANGE + 0.2 : PICKUP_RANGE
    const hoverInRange =
      hover !== null && Math.hypot(hover.x - local.x, hover.y - local.y) <= hoverRange
    if (!input.rightHeld) takeFired = false
    if (hover && input.rightHeld && hoverInRange && !takeFired && alive && !downed) {
      if (takeHoldId !== hover.id) takeHoldS = 0
      takeHoldId = hover.id
      takeHoldS += dt
      if (takeHoldS >= TAKE_HOLD_S) {
        input.queueTake()
        takeFired = true
        takeHoldS = 0
      }
    } else if (input.rightHeld && !takeFired && takeHoldS > 0) {
      // Le clic tient toujours mais la visée a glissé une fraction de seconde
      // (on bouge, l'objet sort du rayon). Remettre la jauge à zéro pour ça
      // rendait la seconde d'appui presque impossible à finir : elle redescend
      // au lieu de s'effacer, et un retour rapide sur l'objet la reprend où
      // elle en était.
      takeHoldS = Math.max(0, takeHoldS - dt * 2)
      if (takeHoldS === 0) takeHoldId = hover?.id ?? null
    } else {
      takeHoldId = hover?.id ?? null
      takeHoldS = 0
    }
    renderer.setTakeHold(takeHoldId, takeHoldS / TAKE_HOLD_S)

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
      if (current.roll) {
        pendingRoll = true
        // Roulade demandée sans le souffle pour la payer : la jauge clignote.
        // Sans ce retour, une commande refusée est indistinguable d'une
        // commande qui ne marche pas.
        const fresh = (localSprint.freshUntil ?? 0) > predictTick
        if (!fresh && localSprint.stamina < ROLL_MIN_STAMINA) {
          staminaTrack.classList.remove('denied')
          void staminaTrack.offsetWidth
          staminaTrack.classList.add('denied')
        }
      }

      accumulator += dt
      let steps = 0
      while (accumulator >= DT && steps < 5) {
        const rolled = stepRoll(
          localSprint, predictTick, pendingRoll,
          current.mx, current.my, current.aim,
        )
        if (rolled !== null) {
          // La roulade coupe la récupération du coup, comme côté serveur.
          if (rolled === 'start') localSwingUntilMs = 0
          const bx = local.x
          const by = local.y
          local.kx = 0
          local.ky = 0
          movePhysical(
            tiles, mapW, mapH, local,
            localSprint.rollVx ?? 0, localSprint.rollVy ?? 0, ROLL_SPEED,
          )
          // Mur pris de plein fouet : la roulade s'arrête, comme côté serveur.
          if (Math.hypot(local.x - bx, local.y - by) < ROLL_SPEED * DT * 0.4) {
            localSprint.rollUntil = predictTick
          }
        } else {
          const sprinting = stepSprint(localSprint, predictTick, current.sprint, moving, swinging)
          movePhysical(
            tiles, mapW, mapH, local,
            current.mx, current.my,
            playerSpeed({ downed }, penalty, sprinting, hasted),
          )
        }
        // Consommée ou refusée (jauge, temps mort, lame sortie) : dans les
        // deux cas on ne la garde pas en réserve — le serveur tranche pareil.
        pendingRoll = false
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

    // La minicarte n'a pas besoin de 60 Hz : elle ne bouge qu'à la vitesse du
    // personnage, et la redessiner à chaque frame coûterait plus cher que tout
    // le reste du HUD réuni.
    mapTimer -= dt
    if (mapTimer <= 0 && miniCtx) {
      mapTimer = 0.12
      renderer.paintMinimap(miniCtx, MINIMAP_CELL)
    }

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
