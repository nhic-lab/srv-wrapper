import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { srvHome } from '../shared/paths.js'

const LABEL = 'com.srv-wrapper.daemon'
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)

function daemonScriptPath(): string {
  return new URL('../daemon/index.js', import.meta.url).pathname
}

function plistContents(): string {
  const home = srvHome()
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${daemonScriptPath()}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${home}/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>${home}/daemon.error.log</string>
</dict>
</plist>
`
}

function assertMacOS(): void {
  if (process.platform !== 'darwin') {
    throw new Error('daemon install/uninstall is macOS-only (uses launchd)')
  }
}

export function installLaunchd(): void {
  assertMacOS()
  fs.mkdirSync(srvHome(), { recursive: true })
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true })
  fs.writeFileSync(PLIST_PATH, plistContents(), 'utf-8')
  try {
    execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' })
  } catch {
    // not previously loaded — fine
  }
  execFileSync('launchctl', ['load', PLIST_PATH], { stdio: 'inherit' })
  process.stdout.write(`srvd installed and loaded via launchd. Logs: ${srvHome()}/daemon.log\n`)
}

export function uninstallLaunchd(): void {
  assertMacOS()
  if (!fs.existsSync(PLIST_PATH)) {
    process.stdout.write('srvd launchd agent is not installed.\n')
    return
  }
  try {
    execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' })
  } catch {
    // already unloaded — fine
  }
  fs.rmSync(PLIST_PATH)
  process.stdout.write('srvd launchd agent removed.\n')
}

export function daemonStatus(): void {
  assertMacOS()
  try {
    const output = execFileSync('launchctl', ['list', LABEL], { encoding: 'utf-8' })
    process.stdout.write(output)
  } catch {
    process.stdout.write('srvd launchd agent is not loaded.\n')
  }
}
