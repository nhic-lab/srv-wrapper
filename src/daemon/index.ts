import http from 'node:http'
import fs from 'node:fs'
import { Registry } from './registry.js'
import { Keychain } from './keychain.js'
import { LogStore } from './logstore.js'
import { SshManager } from './ssh-manager.js'
import { SocketServer } from './socket-server.js'
import { createDashboardApp } from './dashboard-server.js'
import { srvHome, srvSocketPath, srvRegistryDbPath, srvLogDbPath } from '../shared/paths.js'

const DASHBOARD_PORT = 4280

async function main() {
  fs.mkdirSync(srvHome(), { recursive: true, mode: 0o700 })

  const registry = new Registry(srvRegistryDbPath())
  const logStore = new LogStore(srvLogDbPath())
  const keychain = new Keychain(process.argv[1] ?? 'srvd')
  const sshManager = new SshManager((serverId) => keychain.getSecret(serverId))

  const { app, broadcast } = createDashboardApp({ registry, keychain, logStore })
  const httpServer = http.createServer(app)
  ;(app as any).attachWebSocket(httpServer)
  httpServer.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    console.log(`Dashboard listening on http://127.0.0.1:${DASHBOARD_PORT}`)
  })

  const socketServer = new SocketServer({
    socketPath: srvSocketPath(),
    registry,
    logStore,
    sshManager,
    onBroadcast: (event) => broadcast(event),
  })
  await socketServer.start()
  console.log(`Socket server listening on ${srvSocketPath()}`)
}

main().catch((err) => {
  console.error('srvd failed to start:', err)
  process.exit(1)
})
