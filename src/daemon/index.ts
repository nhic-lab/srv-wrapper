import http from 'node:http'
import fs from 'node:fs'
import { Registry } from './registry.js'
import { Keychain } from './keychain.js'
import { LogStore } from './logstore.js'
import { SshManager, RegistryHostKeyStore } from './ssh-manager.js'
import { SocketServer } from './socket-server.js'
import { createDashboardApp } from './dashboard-server.js'
import { srvHome, srvSocketPath, srvRegistryDbPath, srvLogDbPath } from '../shared/paths.js'

const DASHBOARD_PORT = 4280

process.on('uncaughtException', (err) => {
  console.error('srvd: uncaught exception (daemon continuing):', err)
})

async function main() {
  fs.mkdirSync(srvHome(), { recursive: true, mode: 0o700 })

  const registry = new Registry(srvRegistryDbPath())
  const logStore = new LogStore(srvLogDbPath())
  // process.execPath (the node binary itself) is stable across restarts and
  // builds, unlike process.argv[1] (the script path) — using it as the
  // Keychain-trusted app means macOS stops re-prompting for access once
  // trust is granted, instead of treating every dev-mode invocation as new.
  const keychain = new Keychain(process.execPath)
  const sshManager = new SshManager(
    (serverId) => keychain.getSecret(serverId),
    undefined,
    new RegistryHostKeyStore(registry)
  )

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
