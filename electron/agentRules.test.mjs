import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildHosts, buildSkillPath, inspectHostConfiguration } from './agentInstallers.ts'
import { agentRuleFiles, installAgentRule, removeAgentRule, ruleInstalled } from './agentRules.ts'
import { uninstallAll, uninstallHost } from './agentUninstall.ts'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-draw-first-'))
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  fs.mkdirSync(project, { recursive: true })
  // Zed honours XDG_CONFIG_HOME independently of the injected home/appdata.
  // Each worker needs its own directory, including on GitHub's Ubuntu runner.
  const previousXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg-config')
  return {
    root, home, project, hosts: buildHosts(home, path.join(root, 'appdata')),
    cleanup: () => {
      try { fs.rmSync(root, { recursive: true, force: true }) } finally {
        if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previousXdg
      }
    },
  }
}

test('a fixture leaves the inherited XDG config untouched and restores it on cleanup', () => {
  const inherited = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-inherited-xdg-'))
  const previousXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = inherited
  try {
    const f = fixture()
    try {
      // Explicit Linux discovery exercises XDG even on macOS/Windows CI.
      const zed = buildHosts(f.home, path.join(f.root, 'appdata'), 'linux').find(host => host.id === 'zed')
      assert.equal(zed.configPath(), path.join(f.root, 'xdg-config', 'zed', 'settings.json'))
      assert.ok(zed.install('node', ['axiom.mjs'], '# Axiom', f.project).ok)
      assert.ok(uninstallHost(zed, f.project).ok)
      assert.deepEqual(fs.readdirSync(inherited), [], 'fixture wrote to an inherited/shared config directory')
    } finally { f.cleanup() }
    assert.equal(process.env.XDG_CONFIG_HOME, inherited)
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
    fs.rmSync(inherited, { recursive: true, force: true })
  }
})

test('every supported host receives draw-first guidance and repairs missing project rules', () => {
  const f = fixture()
  try {
    assert.equal(f.hosts.length, 10)
    for (const host of f.hosts) {
      const result = host.install('node', ['axiom.mjs'], '# Axiom mapping', f.project)
      assert.ok(result.ok, `${host.id}: ${result.detail}`)
      if (host.commandPath) {
        const skill = buildSkillPath(host.commandPath(f.project))
        assert.ok(result.paths.includes(skill), `${host.id} missing build skill`)
        const contents = fs.readFileSync(skill, 'utf8')
        assert.match(contents, /description:.*features\/refactors/)
        assert.match(contents, /Agent-created elements stay pending/)
        assert.match(contents, /An existing approved plan and explicit build instruction already authorize/)
      }
      const rules = host.ruleFiles(f.project)
      if (host.id === 'claude-desktop') {
        assert.equal(rules.length, 0)
        assert.match(host.promptText, /draw structural changes before code/)
        continue
      }
      assert.equal(rules.length, host.id === 'windsurf' ? 2 : 1, `${host.id} lacks project instructions`)
      assert.ok(ruleInstalled(rules[0]), host.id)
      assert.equal(inspectHostConfiguration(host, f.project).workflowInstalled, true, host.id)
      fs.rmSync(rules[0].path)
      assert.equal(inspectHostConfiguration(host, f.project).workflowInstalled, false, `${host.id} missing rule was not detected`)
      const repaired = host.install('node', ['axiom.mjs'], '# Axiom mapping', f.project)
      assert.ok(repaired.ok, `${host.id}: ${repaired.detail}`)
      assert.ok(ruleInstalled(rules[0]))
    }
    for (const host of ['cursor', 'windsurf', 'antigravity', 'jetbrains']) {
      const rule = agentRuleFiles(host, f.project)[0]
      assert.ok(fs.readFileSync(rule.path, 'utf8').startsWith(rule.prefix))
    }
  } finally { f.cleanup() }
})

test('installation is idempotent and preserves authored instructions with CRLF', () => {
  const f = fixture()
  try {
    const rule = agentRuleFiles('codex', f.project)[0]
    const authored = '# Project rules\r\n\r\nUse the existing test runner.\r\n'
    fs.writeFileSync(rule.path, authored)
    installAgentRule(rule)
    const installed = fs.readFileSync(rule.path, 'utf8')
    installAgentRule(rule)
    assert.equal(fs.readFileSync(rule.path, 'utf8'), installed)
    assert.ok(installed.startsWith(authored))
    assert.equal((installed.match(/<!-- axiom:draw-first:v1 /g) ?? []).length, 1)
    assert.ok(removeAgentRule(rule))
    assert.ok(fs.readFileSync(rule.path, 'utf8').startsWith(authored))
    assert.doesNotMatch(fs.readFileSync(rule.path, 'utf8'), /axiom:draw-first/)
  } finally { f.cleanup() }
})

test('edited rules are neither overwritten nor removed, and partial installs report repair', () => {
  const f = fixture()
  try {
    const host = f.hosts.find(host => host.id === 'cursor')
    assert.ok(host.install('node', ['axiom.mjs'], '# Axiom', f.project).ok)
    const rule = host.ruleFiles(f.project)[0]
    const edited = fs.readFileSync(rule.path, 'utf8').replace('Bug fixes, tests', 'My own policy: bug fixes, tests')
    fs.writeFileSync(rule.path, edited)
    assert.equal(ruleInstalled(rule), false)
    assert.throws(() => installAgentRule(rule), /edited/)
    assert.equal(removeAgentRule(rule), false)
    const reinstall = host.install('node', ['axiom.mjs'], '# Axiom', f.project)
    assert.equal(reinstall.ok, false)
    assert.match(reinstall.detail, /need repair/)
    assert.ok(inspectHostConfiguration(host, f.project).configured)
    uninstallHost(host, f.project)
    assert.equal(fs.readFileSync(rule.path, 'utf8'), edited)
  } finally { f.cleanup() }
})

test('unmanaged dedicated files and malformed managed blocks are preserved', () => {
  const f = fixture()
  try {
    const rule = agentRuleFiles('windsurf', f.project)[0]
    fs.mkdirSync(path.dirname(rule.path), { recursive: true })
    fs.writeFileSync(rule.path, 'My own rule')
    assert.throws(() => installAgentRule(rule), /authored rule/)
    assert.equal(fs.readFileSync(rule.path, 'utf8'), 'My own rule')
    const shared = agentRuleFiles('zed', f.project)[0]
    fs.writeFileSync(shared.path, '<!-- axiom:draw-first:v1 sha256=bad -->\ncustom rule')
    assert.throws(() => installAgentRule(shared), /incomplete/)
  } finally { f.cleanup() }
})

test('shared AGENTS instructions survive removing one host and clean up after the last', () => {
  const f = fixture()
  try {
    const codex = f.hosts.find(host => host.id === 'codex')
    const copilot = f.hosts.find(host => host.id === 'copilot-cli')
    for (const host of [codex, copilot]) assert.ok(host.install('node', ['axiom.mjs'], '# Axiom', f.project).ok)
    uninstallHost(codex, f.project, [copilot])
    assert.ok(ruleInstalled(copilot.ruleFiles(f.project)[0]))
    uninstallHost(copilot, f.project)
    assert.equal(fs.existsSync(path.join(f.project, 'AGENTS.md')), false)
    for (const host of f.hosts) host.install('node', ['axiom.mjs'], '# Axiom', f.project)
    assert.ok(uninstallAll(f.hosts, f.project).ok)
    for (const host of f.hosts) {
      for (const rule of host.ruleFiles(f.project)) assert.equal(fs.existsSync(rule.path), false, host.id)
      if (host.commandPath) assert.equal(fs.existsSync(buildSkillPath(host.commandPath(f.project))), false, host.id)
      for (const workflow of host.additionalCommandPaths?.() ?? []) assert.equal(fs.existsSync(buildSkillPath(workflow)), false, `${host.id} secondary workflow`)
    }
  } finally { f.cleanup() }
})
