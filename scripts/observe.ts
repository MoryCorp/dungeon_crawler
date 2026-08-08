/** Observateur : affiche l'état d'une room pendant quelques secondes. Debug uniquement. */
import WebSocket from 'ws'
import type { ServerMsg } from '@dc/engine'

const room = process.argv[2] ?? 'TEST'
const seconds = Number(process.argv[3] ?? 4)
const ws = new WebSocket(process.env.SMOKE_URL ?? 'ws://localhost:3000/ws')

ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room, name: 'Observateur' })))
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString()) as ServerMsg
  if (msg.t !== 'state') return
  if (msg.tick % 30 !== 0) return
  const line = msg.actors
    .map(
      (a) =>
        `${a.kind === 'player' ? '@' : '#'}${a.name}` +
        `${a.rank ? `[${a.rank}]` : ''}(${a.x.toFixed(1)},${a.y.toFixed(1)})` +
        `${a.level ? ` n${a.level}` : ''}` +
        `${a.winding ? '!' : ''}${a.dashing ? '»' : ''}` +
        `${a.downed ? '_' : ''}${a.alive ? '' : '†'}`,
    )
    .join(' ')
  const loot = msg.items.map((i) => i.kind[0]).join('')
  console.log(
    `t=${msg.tick} étage=${msg.floor} ${msg.locked ? '[fermé]' : '[ouvert]'}` +
      `${msg.projectiles.length ? ` ${msg.projectiles.length}⋅` : ''}` +
      `${loot ? ` {${loot}}` : ''} ${line}`,
  )
})

setTimeout(() => {
  ws.close()
  process.exit(0)
}, seconds * 1000)
