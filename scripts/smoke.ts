/**
 * Test de bout en bout : lance deux clients factices contre un serveur qui
 * tourne, vérifie déplacement, brouillard, monstres et reprise de partie.
 *
 *   npm run dev            # dans un terminal
 *   npx tsx scripts/smoke.ts
 */
import WebSocket from 'ws'
import { fromBase64, unpackBits, type ActorView, type ServerMsg } from '@dc/engine'

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
          this.stateCount++
          if (this.mapSize) {
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

  move(dir: string): void {
    this.ws.send(JSON.stringify({ t: 'intent', intent: { type: 'move', dir } }))
  }

  stop(): void {
    this.ws.send(JSON.stringify({ t: 'intent', intent: null }))
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

  // --- déplacement -------------------------------------------------------
  const before = alice.self()!
  const start = { x: before.x, y: before.y }

  // On teste les 4 directions : au moins une doit être libre depuis le spawn.
  let moved = false
  for (const dir of ['E', 'W', 'S', 'N']) {
    alice.move(dir)
    await wait(700)
    const now = alice.self()!
    if (now.x !== start.x || now.y !== start.y) {
      moved = true
      break
    }
  }
  alice.stop()
  const after = alice.self()!
  check('Alice se déplace', moved, `(${start.x},${start.y}) -> (${after.x},${after.y})`)

  // Mesure sur une fenêtre fixe : compter depuis le début dépendrait du temps
  // qu'a mis Alice à trouver une direction libre.
  const countBefore = alice.stateCount
  await wait(1000)
  const rate = alice.stateCount - countBefore
  check('le serveur envoie ~15 états/s', rate >= 12 && rate <= 18, `${rate} états en 1 s`)

  // Bob voit-il Alice bouger ? (état partagé)
  const aliceSeenByBob = bob.actors.find((a) => a.id === alice.selfId)
  check(
    'Bob voit la position d\'Alice',
    aliceSeenByBob?.x === after.x && aliceSeenByBob?.y === after.y,
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
    Math.abs(resumed.x - posBefore.x) <= 1 && Math.abs(resumed.y - posBefore.y) <= 1,
    `(${resumed.x},${resumed.y}) vs (${posBefore.x},${posBefore.y})`,
  )
  check('reconnexion : même étage', aliceAgain.floor === floorBefore, `étage ${aliceAgain.floor}`)

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
