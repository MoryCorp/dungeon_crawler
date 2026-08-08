// Lance serveur + client en parallèle, sans dépendance externe.
import { spawn } from 'node:child_process'

const procs = [
  { name: 'server', color: '\x1b[36m', cmd: 'npm', args: ['run', 'dev', '--workspace=@dc/server'] },
  { name: 'client', color: '\x1b[35m', cmd: 'npm', args: ['run', 'dev', '--workspace=@dc/client'] },
]

const children = procs.map(({ name, color, cmd, args }) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  const prefix = `${color}[${name}]\x1b[0m `
  const pipe = (stream) => {
    let buf = ''
    stream.on('data', (chunk) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) process.stdout.write(prefix + line + '\n')
    })
  }
  pipe(child.stdout)
  pipe(child.stderr)
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited with code ${code}\n`)
    shutdown()
  })
  return child
})

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) c.kill('SIGTERM')
  setTimeout(() => process.exit(0), 300)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
