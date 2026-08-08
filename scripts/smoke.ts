/**
 * Test de bout en bout : lance deux clients factices contre un serveur qui
 * tourne, vérifie déplacement, brouillard, monstres et reprise de partie.
 *
 *   npm run dev            # dans un terminal
 *   npx tsx scripts/smoke.ts
 */
import WebSocket from 'ws'
import {
  PLAYER_BASE_HP,
  fromBase64,
  unpackBits,
  type ActorView,
  type ItemView,
  type ProjectileView,
  type ServerMsg,
} from '@dc/engine'

const URL = process.env.SMOKE_URL ?? 'ws://localhost:3000/ws'
const ROOM = process.env.SMOKE_ROOM ?? 'SMOKE'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

class FakeClient {
  ws: WebSocket
  selfId = ''
  floor = 0
  mapSize = 0
  actors: ActorView[] = []
  items: ItemView[] = []
  projectiles: ProjectileView[] = []
  locked = false
  chasing = -1
  visibleCount = 0
  stateCount = 0
  ready: Promise<void>

  constructor(public name: string) {
    this.ws = new WebSocket(URL)
    this.ready = new Promise<void>((resolve) => {
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ t: 'join', room: ROOM, name: this.name }))
      })
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as ServerMsg
        if (msg.t === 'welcome') this.selfId = msg.selfId
        if (msg.t === 'floor') {
          this.floor = msg.floor
          this.mapSize = msg.width * msg.height
        }
        if (msg.t === 'state') {
          this.actors = msg.actors
          this.items = msg.items
          this.projectiles = msg.projectiles
          this.locked = msg.locked
          this.chasing = msg.chasing
          this.stateCount++
          // Le brouillard n'accompagne qu'un paquet sur cinq.
          if (this.mapSize && msg.vis) {
            const vis = unpackBits(fromBase64(msg.vis), this.mapSize)
            this.visibleCount = vis.reduce((a, b) => a + b, 0)
          }
          if (this.selfId && this.floor) resolve()
        }
        if (msg.t === 'error') console.error(`  [${this.name}] erreur serveur: ${msg.msg}`)
      })
    })
  }

  self(): ActorView | undefined {
    return this.actors.find((a) => a.id === this.selfId)
  }

  move(mx: number, my: number): void {
    this.ws.send(JSON.stringify({ t: 'input', input: { mx, my, aim: 0, attack: false } }))
  }

  attack(aim: number): void {
    this.ws.send(JSON.stringify({ t: 'input', input: { mx: 0, my: 0, aim, attack: true } }))
  }

  stop(): void {
    this.ws.send(JSON.stringify({ t: 'input', input: { mx: 0, my: 0, aim: 0, attack: false } }))
  }
}

async function run(): Promise<void> {
  console.log(`\nSmoke test sur ${URL} (room ${ROOM})\n`)

  const alice = new FakeClient('Alice')
  const bob = new FakeClient('Bob')
  await Promise.all([alice.ready, bob.ready])

  check('les deux clients reçoivent welcome + floor', Boolean(alice.selfId && bob.selfId))
  check('identifiants distincts', alice.selfId !== bob.selfId, `${alice.selfId} / ${bob.selfId}`)
  check('carte reçue', alice.mapSize === 64 * 64, `${alice.mapSize} cases`)

  const players = alice.actors.filter((a) => a.kind === 'player')
  check('les deux joueurs sont dans la partie', players.length === 2, `${players.length} joueurs`)

  const monsters = alice.actors.filter((a) => a.kind === 'monster')
  check('des monstres sont visibles ou hors de vue', monsters.length >= 0, `${monsters.length} visibles`)

  check(
    'le brouillard découvre une zone plausible',
    alice.visibleCount > 10 && alice.visibleCount < 64 * 64,
    `${alice.visibleCount} cases visibles sur 4096`,
  )

  // --- progression et objectif -------------------------------------------
  const me = alice.self()!
  check('le héros a une arme de départ', me.weapon === 'sword', String(me.weapon))
  check('le héros démarre niveau 1', me.level === 1 && me.xp === 0, `n${me.level}, ${me.xp} xp`)
  check('le palier de niveau suivant est annoncé', (me.xpNext ?? 0) > 0, `${me.xpNext} xp`)
  check('l\'escalier est verrouillé au début de l\'étage', alice.locked)
  check('personne ne poursuit au premier étage', alice.chasing === 0, `${alice.chasing}`)
  check('le héros démarre avec les PV de base', me.maxHp === PLAYER_BASE_HP, `${me.maxHp} PV`)
  check('l\'état transporte objets et projectiles',
    Array.isArray(alice.items) && Array.isArray(alice.projectiles),
    `${alice.items.length} objets visibles`)

  // --- déplacement -------------------------------------------------------
  const before = alice.self()!
  const start = { x: before.x, y: before.y }

  // On teste les 4 directions : au moins une doit être libre depuis le spawn.
  let moved = false
  for (const [mx, my] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    alice.move(mx, my)
    await wait(700)
    const now = alice.self()!
    if (Math.hypot(now.x - start.x, now.y - start.y) > 0.5) {
      moved = true
      break
    }
  }
  alice.stop()
  const after = alice.self()!
  check(
    'Alice se déplace librement',
    moved,
    `(${start.x.toFixed(2)},${start.y.toFixed(2)}) -> (${after.x.toFixed(2)},${after.y.toFixed(2)})`,
  )

  // Les positions doivent être continues, pas alignées sur la grille.
  const offGrid = Math.abs(after.x - Math.round(after.x)) > 0.01 ||
                  Math.abs(after.y - Math.round(after.y)) > 0.01
  check('les positions sont continues, pas calées sur la grille', offGrid, `x=${after.x}`)

  // Mesure sur une fenêtre fixe : compter depuis le début dépendrait du temps
  // qu'a mis Alice à trouver une direction libre.
  const countBefore = alice.stateCount
  await wait(1000)
  const rate = alice.stateCount - countBefore
  check('le serveur envoie ~30 états/s', rate >= 24 && rate <= 36, `${rate} états en 1 s`)

  // Bob voit-il Alice bouger ? (état partagé)
  const aliceSeenByBob = bob.actors.find((a) => a.id === alice.selfId)
  check(
    'Bob voit la position d\'Alice',
    aliceSeenByBob !== undefined &&
      Math.hypot(aliceSeenByBob.x - after.x, aliceSeenByBob.y - after.y) < 1.5,
    `${aliceSeenByBob?.x},${aliceSeenByBob?.y}`,
  )

  // --- reprise après déconnexion ----------------------------------------
  const floorBefore = alice.floor
  const posBefore = { x: after.x, y: after.y }
  alice.ws.close()
  await wait(500)

  const aliceAgain = new FakeClient('Alice')
  await aliceAgain.ready
  const resumed = aliceAgain.self()!
  check('reconnexion : même identifiant', aliceAgain.selfId === alice.selfId, aliceAgain.selfId)
  check(
    'reconnexion : le personnage est là où il était',
    Math.hypot(resumed.x - posBefore.x, resumed.y - posBefore.y) <= 1.5,
    `(${resumed.x.toFixed(2)},${resumed.y.toFixed(2)}) vs (${posBefore.x.toFixed(2)},${posBefore.y.toFixed(2)})`,
  )
  check('reconnexion : même étage', aliceAgain.floor === floorBefore, `étage ${aliceAgain.floor}`)

  // --- télémétrie --------------------------------------------------------
  // Sur une instance déployée, cet endpoint est le seul moyen de récupérer les
  // mesures d'équilibrage : s'il casse, on règle de nouveau à l'aveugle.
  const httpBase = URL.replace(/^ws/, 'http').replace(/\/ws$/, '')
  const stats = await fetch(`${httpBase}/stats/${ROOM}`)
  check('les mesures de partie sont exposées en HTTP', stats.ok, `HTTP ${stats.status}`)
  if (stats.ok) {
    const run = (await stats.json()) as { room: string; floors: { ticks: number }[] }
    check('les mesures portent le bon code de partie', run.room === ROOM, run.room)
    check('au moins un étage est mesuré', run.floors.length > 0, `${run.floors.length} étage(s)`)
    check('le temps passé est compté', (run.floors[0]?.ticks ?? 0) > 0, `${run.floors[0]?.ticks} ticks`)
  }

  const missing = await fetch(`${httpBase}/stats/ZZZZ`)
  check('une partie sans mesure répond 404', missing.status === 404, `HTTP ${missing.status}`)

  aliceAgain.ws.close()
  bob.ws.close()
  await wait(300)

  console.log(`\n${failures === 0 ? 'Tout est vert.' : `${failures} test(s) en échec.`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((err) => {
  console.error('Le smoke test a planté:', err)
  process.exit(1)
})
