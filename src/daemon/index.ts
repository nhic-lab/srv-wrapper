#!/usr/bin/env node
import http from 'node:http'
import fs from 'node:fs'
import { Registry } from './registry.js'
import { Keychain } from './keychain.js'
import { LogStore } from './logstore.js'
import { SshManager, RegistryHostKeyStore } from './ssh-manager.js'
import { SocketServer } from './socket-server.js'
import { createDashboardApp } from './dashboard-server.js'
import { srvHome, srvSocketPath, srvRegistryDbPath, srvLogDbPath } from '../shared/paths.js'
import type { ServerRecord } from '../shared/types.js'

const DASHBOARD_PORT = 4280

process.on('uncaughtException', (err) => {
  console.error('srvd: uncaught exception (daemon continuing):', err)
})

async function main() {
  fs.mkdirSync(srvHome(), { recursive: true, mode: 0o700 })

  const registry = new Registry(srvRegistryDbPath())
  const logStore = new LogStore(srvLogDbPath())
  // Trust is scoped to THIS script's real path, not the generic `node`
  // binary (process.execPath) — trusting `node` itself would grant Keychain
  // access to any script run via that Node install, not just this daemon.
  // realpathSync keeps the identity stable even if dist/ is reached via a
  // symlink. This path is only stable for the BUILT daemon (dist/daemon/
  // index.js) invoked the same way every time (e.g. via the launchd plist)
  // — dev-mode (tsx) invocations don't have a stable script path and will
  // still prompt on every run.
  const keychain = new Keychain(fs.realpathSync(process.argv[1]))
  const sshManager = new SshManager(
    (serverId) => keychain.getSecret(serverId),
    undefined,
    new RegistryHostKeyStore(registry),
    (serverId) => registry.get(serverId)
  )

  // A separate `<id>:sudo` entry wins; a password-auth server falls back to
  // its login password (what sudo usually wants); key-auth servers without a
  // sudo entry have nothing to offer and the request is refused. Shared by the
  // agent socket (--sudo) and the dashboard (Shell as root, Paste password).
  const resolveSudoSecret = (server: ServerRecord): string | undefined => {
    try {
      return keychain.getSudoSecret(server.id)
    } catch {
      return server.authMethod === 'password' ? keychain.getSecret(server.id) : undefined
    }
  }

  const { app, broadcast } = createDashboardApp({ registry, keychain, logStore, sshManager, resolveSudoSecret })
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
    resolveSudoSecret,
    onBroadcast: (event) => broadcast(event),
  })
  await socketServer.start()
  console.log(`Socket server listening on ${srvSocketPath()}`)
}

main().catch((err) => {
  console.error('srvd failed to start:', err)
  process.exit(1)
})
