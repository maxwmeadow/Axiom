import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildHosts, inspectHostConfiguration } from './agentInstallers.ts'

function hostWith(locations) {
  return { serverLocations: () => locations }
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
        config: path.join(home, '.copilot', 'mcp-config.json'),
      },
      windsurf: {
        command: '/axiom-map',
        skill: path.join(appData, 'devin', 'skills', 'axiom-map', 'SKILL.md'),
        config: path.join(appData, 'devin', 'mcp_config.json'),
      },
      antigravity: {
        command: 'Use the axiom-map skill',
        skill: path.join(home, '.gemini', 'config', 'skills', 'axiom-map', 'SKILL.md'),
        config: path.join(home, '.gemini', 'config', 'mcp_config.json'),
      },
    }

    for (const host of buildHosts(home, appData)) {
      const expected = expectations[host.id]
      assert.ok(expected, `missing expectation for ${host.id}`)

      const result = host.install('node', ['C:/Axiom/mcp/axiom-mcp.js'], brief, project)
      assert.equal(result.ok, true, `${host.id}: ${result.detail}`)
      assert.equal(host.command, expected.command)
      assert.equal(host.commandPath?.(project), expected.skill)
      assert.equal(fs.existsSync(expected.skill), true, `${host.id} skill missing`)
      assert.match(fs.readFileSync(expected.skill, 'utf8'), /^---\nname: axiom-map\ndescription:/)
      assert.equal(fs.existsSync(expected.config), true, `${host.id} current MCP config missing`)
      assert.match(fs.readFileSync(expected.config, 'utf8'), new RegExp(`--axiom-host=${host.id}`))

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
    fs.rmSync(root, { recursive: true, force: true })
  }
})
