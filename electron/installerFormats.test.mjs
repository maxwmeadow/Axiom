import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildHosts, detectHosts } from './agentInstallers.ts'
import { readOverrides, setOverride, clearOverride } from './agentOverrides.ts'

/**
 * These expectations are written from each tool's own documentation, never
 * derived from the installer. inspectHostConfiguration reads back through the
 * same serverLocations the installer writes, so a wrong format satisfies it
 * happily - that closed loop is how Zed shipped an install it silently
 * ignored. Here the shape on disk is asserted directly.
 */
const NODE = '/usr/bin/node'
const MCP = '/opt/axiom/mcp/axiom-mcp.mjs'

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))

/**
 * Every path here is meant to sit under an injected temp home. Zed's Linux
 * location resolves through XDG_CONFIG_HOME, which GitHub's Ubuntu image sets,
 * so leaving it in place lets these tests read - and write - the real machine:
 * detection reports whatever is actually installed, and the install test
 * rewrites a developer's own Zed settings.
 */
function withoutXdgConfigHome(run) {
  const previous = process.env.XDG_CONFIG_HOME
  delete process.env.XDG_CONFIG_HOME
  try {
    run()
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
  }
}

function installAll(platform) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-home-'))
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-appdata-'))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-project-'))
  const hosts = buildHosts(home, appData, platform)
  const byId = {}
  for (const host of hosts) {
    const result = host.install(NODE, [MCP], '# Map this codebase', project)
    byId[host.id] = { host, result, configPath: host.configPath() }
  }
  return { home, appData, project, byId }
}

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`every installer writes the shape its tool documents (${platform})`, () => {
    withoutXdgConfigHome(() => {
    const { byId } = installAll(platform)

    for (const [id, entry] of Object.entries(byId)) {
      assert.equal(entry.result.ok, true, `${id} reported failure: ${entry.result.detail}`)
    }

    // VS Code keys MCP servers under "servers". Using mcpServers there - the
    // Claude/Cursor spelling - produces a file VS Code ignores.
    const vscode = readJson(byId.copilot.configPath)
    assert.ok(vscode.servers?.axiom, 'VS Code must use the servers key')
    assert.equal(vscode.mcpServers, undefined, 'VS Code must NOT use mcpServers')

    // Zed skips any context server that does not declare source: "custom".
    const zed = readJson(byId.zed.configPath)
    assert.equal(zed.context_servers?.axiom?.source, 'custom',
      'Zed ignores a manually added server without source: "custom"')
    assert.equal(zed.context_servers.axiom.command, NODE)

    // Everything else in this set documents an mcpServers object.
    for (const id of ['claude-code', 'claude-desktop', 'copilot-cli', 'cursor', 'windsurf', 'antigravity']) {
      const config = readJson(byId[id].configPath)
      assert.ok(config.mcpServers?.axiom, `${id} must write mcpServers.axiom`)
      assert.equal(config.mcpServers.axiom.command, NODE, `${id} command`)
      assert.ok(config.mcpServers.axiom.args.includes(MCP), `${id} args must carry the MCP path`)
    }

    // Codex is TOML, and the table is [mcp_servers.axiom].
    const codex = fs.readFileSync(byId.codex.configPath, 'utf8')
    assert.match(codex, /^\s*\[mcp_servers\.axiom\]/m, 'Codex must declare [mcp_servers.axiom]')

    // JetBrains is XML, and every interpolated value must be escaped.
    const jetbrains = fs.readFileSync(byId.jetbrains.configPath, 'utf8')
    assert.match(jetbrains, /<entry key="axiom">/, 'JetBrains must declare an axiom entry')
    assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(jetbrains), 'JetBrains XML must stay escaped')
    })
  })

  test(`nothing is reported present on a machine with nothing installed (${platform})`, () => {
    // A host whose config sits directly in the home directory has no
    // distinguishing parent folder. Counting that parent marks it present for
    // everyone, which is how Claude Code once showed as detected everywhere.
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-home-'))
    const emptyAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-appdata-'))

    withoutXdgConfigHome(() => {
      const detected = detectHosts(emptyHome, emptyAppData, platform)
      const present = Object.entries(detected).filter(([, value]) => value).map(([id]) => id)
      assert.deepEqual(present, [], `nothing should be detected, got: ${present.join(', ')}`)
    })
  })

  test(`a host is detected once its own marker exists (${platform})`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marked-home-'))
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'marked-appdata-'))

    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })

    withoutXdgConfigHome(() => {
      const detected = detectHosts(home, appData, platform)
      assert.equal(detected['claude-code'], true, 'the ~/.claude directory should prove Claude Code')
      assert.equal(detected.codex, true, 'the ~/.codex directory should prove Codex')
      assert.equal(detected.cursor, false, 'Cursor was not installed and must stay undetected')
    })
  })
}

test('a located config moves detection and the install together', () => {
  // The failure this guards: an override that reroutes only configPath would
  // report a host configured while the installer wrote somewhere else. Every
  // host resolves through one path, so both halves have to follow it.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-home-'))
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-appdata-'))
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-elsewhere-'))

  const located = path.join(elsewhere, 'claude_desktop_config.json')
  fs.writeFileSync(located, JSON.stringify({ mcpServers: { existing: { command: 'keep-me' } } }))

  const overrides = { 'claude-desktop': located }
  const host = buildHosts(home, appData, 'win32', overrides).find(h => h.id === 'claude-desktop')

  assert.equal(host.configPath(), located, 'configPath must follow the override')

  const result = host.install(NODE, [MCP], '# brief', undefined)
  assert.equal(result.ok, true, result.detail)

  const written = JSON.parse(fs.readFileSync(located, 'utf8'))
  assert.ok(written.mcpServers.axiom, 'the install must land in the located file')
  assert.ok(written.mcpServers.existing, 'and must not discard what was already there')

  const defaultPath = path.join(appData, 'Claude', 'claude_desktop_config.json')
  assert.equal(fs.existsSync(defaultPath), false, 'nothing may be written to the guessed path')

  assert.equal(
    detectHosts(home, appData, 'win32', overrides)['claude-desktop'],
    true,
    'a located host must read as present',
  )
})

test('an override survives only while the file it names does', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-store-'))
  const target = path.join(configDir, 'somewhere.json')
  fs.writeFileSync(target, '{}')

  assert.equal(setOverride(configDir, 'zed', target).ok, true)
  assert.deepEqual(readOverrides(configDir), { zed: target })

  // Pointing at something that is not there must be refused outright.
  const missing = setOverride(configDir, 'cursor', path.join(configDir, 'nope.json'))
  assert.equal(missing.ok, false)

  // A folder is not a configuration file.
  assert.equal(setOverride(configDir, 'cursor', configDir).ok, false)

  // A file deleted after the fact is dropped rather than pinning the host to
  // a path that can no longer be read or written.
  fs.rmSync(target)
  assert.deepEqual(readOverrides(configDir), {})

  fs.writeFileSync(target, '{}')
  setOverride(configDir, 'zed', target)
  clearOverride(configDir, 'zed')
  assert.deepEqual(readOverrides(configDir), {})
})
