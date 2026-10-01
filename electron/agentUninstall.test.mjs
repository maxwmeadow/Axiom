import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildHosts, inspectHostConfiguration } from './agentInstallers.ts'
import { removeTomlAxiomTable, removeXmlAxiomEntry, uninstallAll, uninstallHost } from './agentUninstall.ts'

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-uninstall-'))
  const appData = path.join(home, 'AppData')
  const project = path.join(home, 'project')
  fs.mkdirSync(project, { recursive: true })
  // Linux Zed reads XDG_CONFIG_HOME rather than the injected appData root.
  // Keep installs/removals inside this fixture instead of racing other workers.
  const previousXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = path.join(home, 'xdg-config')
  // Other tools' configuration that must survive.
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true })
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'gh' } } }))
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "o3"\n\n[mcp_servers.github]\ncommand = "gh"\n')
  return {
    home, appData, project,
    cleanup: () => {
      try { fs.rmSync(home, { recursive: true, force: true }) } finally {
        if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previousXdg
      }
    },
  }
}

test('uninstalling every agent removes only what Axiom wrote', () => {
  const { home, appData, project, cleanup } = fixture()
  try {
    const hosts = buildHosts(home, appData, 'linux')
    for (const host of hosts) {
      const result = host.install('/opt/axiom/archd', ['mcp-run', '/opt/axiom/Axiom', '/opt/axiom/mcp.mjs'], '# Axiom - map', project)
      assert.ok(result.ok, `${host.id}: ${result.detail}`)
      assert.ok(inspectHostConfiguration(host, project).configured, `${host.id} not configured after install`)
    }

    const result = uninstallAll(hosts, project)
    assert.ok(result.ok, result.detail)
    for (const host of hosts) {
      const status = inspectHostConfiguration(host, project)
      assert.equal(status.configured, false, `${host.id} still configured: ${status.configuredPaths}`)
      if (host.commandPath) assert.ok(!fs.existsSync(host.commandPath(project)), `${host.id} workflow left behind`)
    }

    const cursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'))
    assert.deepEqual(cursor.mcpServers, { github: { command: 'gh' } })
    const codex = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
    assert.match(codex, /model = "o3"/)
    assert.match(codex, /\[mcp_servers\.github\]/)
    assert.doesNotMatch(codex, /axiom/)
  } finally {
    cleanup()
  }
})

test('a workflow folder shared with a still-configured agent is kept', () => {
  const { home, appData, project, cleanup } = fixture()
  try {
    const hosts = buildHosts(home, appData, 'linux')
    const copilot = hosts.find(host => host.id === 'copilot')
    const copilotCli = hosts.find(host => host.id === 'copilot-cli')
    copilot.install('node', ['/mcp.mjs'], '# Axiom', project)
    copilotCli.install('node', ['/mcp.mjs'], '# Axiom', project)
    uninstallHost(copilot, project, hosts)
    // VS Code's own files lose the entry...
    const vscodeFiles = copilot.serverLocations(project)
      .map(location => location.path)
      .filter(file => !copilotCli.serverLocations(project).some(location => location.path === file))
    for (const file of vscodeFiles) {
      if (!fs.existsSync(file)) continue
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /"axiom"/, `${file} still has Axiom`)
    }
    // ...while the CLI keeps its entry and the skill folder it shares.
    assert.ok(inspectHostConfiguration(copilotCli, project).configured, 'the CLI lost its configuration')
    assert.ok(fs.existsSync(copilotCli.commandPath(project)), 'the CLI lost the skill it still uses')
  } finally {
    cleanup()
  }
})

test('unparseable configuration is reported, never rewritten', () => {
  const { home, appData, project, cleanup } = fixture()
  try {
    const broken = path.join(home, '.cursor', 'mcp.json')
    fs.writeFileSync(broken, '{ not json')
    const cursor = buildHosts(home, appData, 'linux').find(host => host.id === 'cursor')
    const result = uninstallHost(cursor, project)
    assert.equal(result.ok, false)
    assert.equal(fs.readFileSync(broken, 'utf8'), '{ not json')
  } finally {
    cleanup()
  }
})

test('TOML and XML removal touch only the axiom entry', () => {
  assert.equal(
    removeTomlAxiomTable('a = 1\n\n[mcp_servers.axiom]\ncommand = "x"\n\n[mcp_servers.axiom.env]\nK = "v"\n\n[other]\nb = 2\n'),
    'a = 1\n\n[other]\nb = 2\n',
  )
  const xml = '<map>\n        <entry key="github"><value/></entry>\n        <entry key="axiom">\n          <value/>\n        </entry>\n      </map>'
  assert.equal(removeXmlAxiomEntry(xml), '<map>\n        <entry key="github"><value/></entry>\n      </map>')
})
