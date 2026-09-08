import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildHosts,
  inspectHostConfiguration,
  installFamily,
  upsertJetBrainsXml,
} from './agentInstallers.ts'
import { getPlatformPaths } from './platformPaths.ts'
import { presentAgentFamily, presentAgentHost } from '../src/renderer/screens/connectAgentPresentation.ts'

function hostWith(locations) {
  return { serverLocations: () => locations, triggerKind: 'slash command' }
}

test('detects Axiom in JSON server maps without mistaking another server for it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-agent-json-'))
  try {
    const configured = path.join(root, 'configured.json')
    const unrelated = path.join(root, 'unrelated.json')
    fs.writeFileSync(configured, JSON.stringify({ mcpServers: { axiom: { command: 'node' } } }))
    fs.writeFileSync(unrelated, JSON.stringify({ mcpServers: { github: { command: 'node' } } }))

    const status = inspectHostConfiguration(hostWith([
      { format: 'json', path: configured, keyPath: ['mcpServers'] },
      { format: 'json', path: unrelated, keyPath: ['mcpServers'] },
    ]))

    assert.equal(status.configured, true)
    assert.deepEqual(status.configuredPaths, [configured])
    assert.deepEqual(status.unreadablePaths, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checks nested project configuration and deduplicates a shared file path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-agent-project-'))
  try {
    const configPath = path.join(root, 'config.json')
    fs.writeFileSync(configPath, JSON.stringify({
      projects: { [root]: { mcpServers: { axiom: { command: 'node' } } } },
    }))

    const status = inspectHostConfiguration(hostWith([
      { format: 'json', path: configPath, keyPath: ['mcpServers'] },
      { format: 'json', path: configPath, keyPath: ['projects', root, 'mcpServers'] },
    ]))

    assert.equal(status.configured, true)
    assert.deepEqual(status.configuredPaths, [configPath])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('detects exact Codex TOML tables but ignores comments and child tables', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-agent-toml-'))
  try {
    const configured = path.join(root, 'configured.toml')
    const unrelated = path.join(root, 'unrelated.toml')
    fs.writeFileSync(configured, '[mcp_servers."axiom"]\ncommand = "node"\n')
    fs.writeFileSync(unrelated, '# [mcp_servers.axiom]\n[mcp_servers.axiom.env]\nA = "B"\n')

    assert.equal(inspectHostConfiguration(hostWith([
      { format: 'toml', path: configured },
    ])).configured, true)
    assert.equal(inspectHostConfiguration(hostWith([
      { format: 'toml', path: unrelated },
    ])).configured, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('reports malformed existing JSON as unreadable instead of unconfigured', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-agent-broken-'))
  try {
    const configPath = path.join(root, 'broken.json')
    fs.writeFileSync(configPath, '{ not valid json')

    const status = inspectHostConfiguration(hostWith([
      { format: 'json', path: configPath, keyPath: ['mcpServers'] },
    ]))

    assert.equal(status.configured, false)
    assert.deepEqual(status.unreadablePaths, [configPath])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Codex install and reinstall preserve TOML, write a skill, and tag the harness', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-codex-install-'))
  try {
    const codex = buildHosts(home).find(host => host.id === 'codex')
    assert.ok(codex)

    const configPath = path.join(home, '.codex', 'config.toml')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      'model = "gpt-5.6"',
      '',
      '[mcp_servers."axiom"]',
      'command = "old-node"',
      'args = ["old-script", "--old-option"]',
      '',
      '[mcp_servers.github]',
      'command = "github-server"',
      '',
    ].join('\n'))

    const result = codex.install('node', ['C:/Axiom/mcp/axiom-mcp.js'], '# Map this codebase')
    assert.equal(result.ok, true)
    assert.equal(codex.command, '$axiom-map')

    const reinstall = codex.install('node', ['C:/Axiom/mcp/axiom-mcp.js'], '# Map this codebase')
    assert.equal(reinstall.ok, true)

    const config = fs.readFileSync(configPath, 'utf8')
    assert.match(config, /--axiom-host=codex/)
    assert.equal((config.match(/^\[mcp_servers\.axiom\]$/gm) ?? []).length, 1)
    assert.doesNotMatch(config, /old-script|--old-option/)
    assert.match(config, /model = "gpt-5\.6"/)
    assert.match(config, /\[mcp_servers\.github\]\ncommand = "github-server"/)

    const skillPath = path.join(home, '.agents', 'skills', 'axiom-map', 'SKILL.md')
    const skill = fs.readFileSync(skillPath, 'utf8')
    assert.match(skill, /^---\nname: axiom-map\ndescription:/)
    assert.match(skill, /# Map this codebase/)

    const status = inspectHostConfiguration(codex)
    assert.equal(status.configured, true)
    assert.equal(status.workflowInstalled, true)
    assert.equal(status.workflowPath, skillPath)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('every harness installs its workflow and MCP in current supported locations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-modern-installers-'))
  const home = path.join(root, 'home')
  const appData = path.join(root, 'appdata')
  const project = path.join(root, 'project')
  const brief = '# Map this codebase'
  fs.mkdirSync(project, { recursive: true })

  // Every expectation below is relative to the injected home. A runner with
  // XDG_CONFIG_HOME set - GitHub's Ubuntu image does - would otherwise send
  // the XDG-based paths somewhere else entirely.
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
  delete process.env.XDG_CONFIG_HOME

  try {
    const legacyCopilotPrompt = path.join(project, '.github', 'prompts', 'axiom-map.prompt.md')
    fs.mkdirSync(path.dirname(legacyCopilotPrompt), { recursive: true })
    fs.writeFileSync(legacyCopilotPrompt, brief)
    const legacyAntigravityConfig = path.join(home, '.gemini', 'antigravity-ide', 'mcp_config.json')
    fs.mkdirSync(path.dirname(legacyAntigravityConfig), { recursive: true })
    fs.writeFileSync(legacyAntigravityConfig, JSON.stringify({ mcpServers: { axiom: { command: 'old' } } }))

    const expectations = {
      'claude-code': {
        command: '/axiom-map',
        skill: path.join(home, '.claude', 'skills', 'axiom-map', 'SKILL.md'),
        config: path.join(home, '.claude.json'),
      },
      'claude-desktop': {
        command: 'Ask Claude in chat to map this project',
        config: path.join(appData, 'Claude', 'claude_desktop_config.json'),
      },
      codex: {
        command: '$axiom-map',
        skill: path.join(home, '.agents', 'skills', 'axiom-map', 'SKILL.md'),
        config: path.join(home, '.codex', 'config.toml'),
      },
      cursor: {
        command: '/axiom-map',
        skill: path.join(home, '.cursor', 'skills', 'axiom-map', 'SKILL.md'),
        config: path.join(home, '.cursor', 'mcp.json'),
      },
      copilot: {
        command: '/axiom-map',
        skill: path.join(home, '.copilot', 'skills', 'axiom-map', 'SKILL.md'),
        config: path.join(appData, 'Code', 'User', 'mcp.json'),
      },
      'copilot-cli': {
        command: '/axiom-map',
        skill: path.join(home, '.copilot', 'skills', 'axiom-map', 'SKILL.md'),
        config: path.join(home, '.copilot', 'mcp-config.json'),
      },
      windsurf: {
        command: '/axiom-map',
        skill: path.join(home, '.codeium', 'windsurf', 'skills', 'axiom-map', 'SKILL.md'),
        config: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      },
      antigravity: {
        command: 'Use the axiom-map skill',
        skill: path.join(home, '.gemini', 'config', 'skills', 'axiom-map', 'SKILL.md'),
        config: path.join(home, '.gemini', 'config', 'mcp_config.json'),
      },
      jetbrains: {
        command: 'Prompt AI Assistant in chat to map this project',
        config: path.join(appData, 'JetBrains', 'options', 'llm.mcpServers.xml'),
      },
      zed: {
        command: 'Ask Zed AI Assistant to map this project',
        // Zed reads ~/.config/zed on macOS and Linux alike, and only on
        // Windows does it sit under the application-data root.
        config: process.platform === 'win32'
          ? path.join(appData, 'Zed', 'settings.json')
          : path.join(home, '.config', 'zed', 'settings.json'),
      },
    }

    for (const host of buildHosts(home, appData)) {
      const expected = expectations[host.id]
      assert.ok(expected, `missing expectation for ${host.id}`)

      const result = host.install('node', ['C:/Axiom/mcp/axiom-mcp.js'], brief, project)
      assert.equal(result.ok, true, `${host.id}: ${result.detail}`)
      assert.equal(host.command, expected.command)
      if (expected.skill) {
        assert.equal(host.commandPath?.(project), expected.skill)
        assert.equal(fs.existsSync(expected.skill), true, `${host.id} skill missing`)
        assert.match(fs.readFileSync(expected.skill, 'utf8'), /^---\nname: axiom-map\ndescription:/)
      }
      assert.equal(fs.existsSync(expected.config), true, `${host.id} current MCP config missing`)

      const status = inspectHostConfiguration(host, project)
      assert.equal(status.configured, true, `${host.id} was not detected as configured`)
      assert.equal(status.workflowInstalled, true, `${host.id} workflow was not detected`)
    }

    assert.equal(
      fs.existsSync(path.join(home, '.codeium', 'windsurf', 'mcp_config.json')),
      true,
      'legacy Cascade remains configured alongside current Devin Local',
    )
    assert.equal(fs.existsSync(legacyCopilotPrompt), false, 'generated Copilot prompt was migrated to a skill')
    assert.match(fs.readFileSync(legacyAntigravityConfig, 'utf8'), /--axiom-host=antigravity/)
  } finally {
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('installFamily installs all detected modalities in Claude family at once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-family-install-'))
  const home = path.join(root, 'home')
  const appData = path.join(root, 'appdata')
  const brief = '# Map this codebase'

  try {
    // Simulate Claude Code and Claude Desktop on disk
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.mkdirSync(path.join(appData, 'Claude'), { recursive: true })

    const result = installFamily('claude', 'node', ['axiom-mcp.js'], brief, undefined, home, appData)
    assert.equal(result.ok, true)
    assert.equal(fs.existsSync(path.join(home, '.claude.json')), true)
    assert.equal(fs.existsSync(path.join(appData, 'Claude', 'claude_desktop_config.json')), true)
    assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'axiom-map', 'SKILL.md')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('platformPaths resolves correct directories for macOS, Windows, and Linux', () => {
  // Expectations are built with path.join, never as literals: this runs on all
  // three hosts, and join emits backslashes on Windows.
  const home = path.join(path.sep, 'Users', 'testuser')
  const mac = getPlatformPaths(home, 'darwin')
  assert.equal(mac.appDataDir, path.join(home, 'Library', 'Application Support'))
  assert.equal(mac.isMac, true)

  const win = getPlatformPaths('C:\\Users\\testuser', 'win32')
  assert.equal(win.isWin, true)

  // configDir reads XDG_CONFIG_HOME when it is set, so clear it to assert the
  // fallback against the home passed in.
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
  delete process.env.XDG_CONFIG_HOME
  try {
    const linuxHome = path.join(path.sep, 'home', 'testuser')
    const linux = getPlatformPaths(linuxHome, 'linux')
    assert.equal(linux.configDir, path.join(linuxHome, '.config'))
    assert.equal(linux.isLinux, true)

    process.env.XDG_CONFIG_HOME = path.join(path.sep, 'custom', 'xdg')
    assert.equal(
      getPlatformPaths(linuxHome, 'linux').configDir,
      path.join(path.sep, 'custom', 'xdg'),
      'an explicit XDG_CONFIG_HOME must win over the default',
    )
  } finally {
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
  }
})

test('Intelligent light system correctly aggregates family and child status', () => {
  const cliHost = {
    id: 'claude-code',
    label: 'Claude Code (CLI)',
    familyId: 'claude',
    familyLabel: 'Claude',
    modality: 'cli',
    modalityLabel: 'Claude Code (CLI)',
    detected: true,
    configured: false,
    configuredPaths: [],
    unreadablePaths: [],
    workflowInstalled: false,
    workflowPath: null,
    configPath: '/home/.claude.json',
    command: '/axiom-map',
    triggerKind: 'slash command',
    restartAction: 'Restart',
    restartDetail: 'Detail',
  }

  const desktopHost = {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    familyId: 'claude',
    familyLabel: 'Claude',
    modality: 'desktop',
    modalityLabel: 'Claude Desktop (App)',
    detected: true,
    configured: true,
    configuredPaths: ['/appdata/Claude/claude_desktop_config.json'],
    unreadablePaths: [],
    workflowInstalled: true,
    workflowPath: null,
    configPath: '/appdata/Claude/claude_desktop_config.json',
    command: 'Ask Claude',
    triggerKind: 'chat prompt',
    restartAction: 'Quit',
    restartDetail: 'Detail',
  }

  // Case 1: CLI is available, Desktop is installed -> Family is 'installed' (Green)
  const familyPres1 = presentAgentFamily(
    'claude',
    'Claude',
    [cliHost, desktopHost],
    {},
    new Set(),
  )
  assert.equal(familyPres1.state, 'installed')
  assert.equal(familyPres1.installedCount, 1)
  assert.equal(familyPres1.detectedCount, 2)

  // Case 2: One modality becomes live -> Family is 'live' (Pulsing Green)
  const familyPres2 = presentAgentFamily(
    'claude',
    'Claude',
    [cliHost, desktopHost],
    {},
    new Set(['claude-desktop']),
  )
  assert.equal(familyPres2.state, 'live')

  // Case 3: Neither installed, both detected -> Family is 'available' (Amber)
  const unconfiguredDesktop = { ...desktopHost, configured: false, workflowInstalled: false }
  const familyPres3 = presentAgentFamily(
    'claude',
    'Claude',
    [cliHost, unconfiguredDesktop],
    {},
    new Set(),
  )
  assert.equal(familyPres3.state, 'available')
  assert.equal(familyPres3.canBatchInstall, true)
  assert.equal(familyPres3.batchAction, 'install')

  // Case 4: Neither detected -> Family is 'missing' (Red)
  const undetectedCli = { ...cliHost, detected: false }
  const undetectedDesktop = { ...unconfiguredDesktop, detected: false }
  const familyPres4 = presentAgentFamily(
    'claude',
    'Claude',
    [undetectedCli, undetectedDesktop],
    {},
    new Set(),
  )
  assert.equal(familyPres4.state, 'missing')
})

test('JetBrains XML escapes every value it interpolates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-jbxml-'))
  const file = path.join(dir, 'llm.mcpServers.xml')
  // A home directory really can contain these characters.
  const command = '/Users/Tom & Jerry/<node>/bin/node'
  const result = upsertJetBrainsXml(file, command, ['/path/with "quotes"/axiom-mcp.mjs'])

  assert.equal(result.ok, true)
  const xml = fs.readFileSync(file, 'utf8')
  assert.ok(xml.includes('&amp;'), 'ampersand must be escaped')
  assert.ok(xml.includes('&lt;node&gt;'), 'angle brackets must be escaped')
  assert.ok(xml.includes('&quot;quotes&quot;'), 'quotes must be escaped')
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), 'no raw ampersand may survive')
  assert.ok(!xml.includes('command="/Users/Tom & Jerry'), 'the raw command must not be interpolated')
})

test('JetBrains XML inserts, then replaces rather than duplicating', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-jbxml2-'))
  const file = path.join(dir, 'llm.mcpServers.xml')

  assert.equal(upsertJetBrainsXml(file, '/usr/bin/node', ['/a.mjs']).ok, true)
  assert.equal(upsertJetBrainsXml(file, '/usr/local/bin/node', ['/b.mjs']).ok, true)

  const xml = fs.readFileSync(file, 'utf8')
  assert.equal(xml.split('<entry key="axiom">').length - 1, 1, 'reinstall must not stack entries')
  assert.ok(xml.includes('/usr/local/bin/node'), 'the newer command should win')
  assert.ok(!xml.includes('/a.mjs'), 'the stale args should be gone')
})

test('JetBrains XML reports a document it cannot update instead of claiming success', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-jbxml3-'))
  const file = path.join(dir, 'llm.mcpServers.xml')
  // No <map> and no </component>: every branch is a replace that matches nothing.
  const original = '<application>\n  <component name="Other" />\n</application>\n'
  fs.writeFileSync(file, original)

  const result = upsertJetBrainsXml(file, '/usr/bin/node', ['/a.mjs'])
  assert.equal(result.ok, false, 'an unrecognised document is a failure, not a silent no-op')
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'the file must be left untouched')
})
