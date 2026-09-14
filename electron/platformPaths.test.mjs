import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  getPlatformPaths,
  getClaudeDesktopConfigCandidates,
  getClaudeDesktopConfigPath,
  getVsCodeUserMcpPath,
  getZedConfigPath,
  findJetBrainsDirectories,
  resolveNodeCommand,
} from './platformPaths.ts'

// These functions take homeDir and platform as parameters precisely so all
// three operating systems can be checked from whichever one is running.

test('application data directories follow each platform convention', () => {
  assert.equal(
    getPlatformPaths('/Users/dev', 'darwin').appDataDir,
    path.join('/Users/dev', 'Library', 'Application Support'),
  )
  const previousAppData = process.env.APPDATA
  process.env.APPDATA = 'C:\\Users\\dev\\AppData\\Roaming'
  assert.equal(getPlatformPaths('C:\\Users\\dev', 'win32').appDataDir, 'C:\\Users\\dev\\AppData\\Roaming')
  if (previousAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = previousAppData
})

test('Linux honours XDG_CONFIG_HOME, and falls back to ~/.config without it', () => {
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = '/custom/xdg'
  assert.equal(getPlatformPaths('/home/dev', 'linux').configDir, '/custom/xdg')
  delete process.env.XDG_CONFIG_HOME
  assert.equal(getPlatformPaths('/home/dev', 'linux').configDir, path.join('/home/dev', '.config'))
  if (previous !== undefined) process.env.XDG_CONFIG_HOME = previous
})

test('Claude Desktop and VS Code sit under each platform application data root', () => {
  assert.equal(
    getClaudeDesktopConfigPath('/Users/dev', 'darwin'),
    path.join('/Users/dev', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  )
  assert.equal(
    getVsCodeUserMcpPath('/home/dev', 'linux', false, '/home/dev/.config'),
    path.join('/home/dev', '.config', 'Code', 'User', 'mcp.json'),
  )
  assert.equal(
    getVsCodeUserMcpPath('/home/dev', 'linux', true, '/home/dev/.config'),
    path.join('/home/dev', '.config', 'Code - Insiders', 'User', 'mcp.json'),
  )
})

test('Zed uses ~/.config on macOS and Linux, and honours XDG on Linux', () => {
  // Zed deviates from the macOS convention: it does not use Application Support.
  assert.equal(
    getZedConfigPath('/Users/dev', 'darwin'),
    path.join('/Users/dev', '.config', 'zed', 'settings.json'),
  )
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = '/custom/xdg'
  assert.equal(
    getZedConfigPath('/home/dev', 'linux'),
    path.join('/custom/xdg', 'zed', 'settings.json'),
    'a Linux user with XDG_CONFIG_HOME set must not get ~/.config',
  )
  if (previous === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previous
  assert.equal(
    getZedConfigPath('C:\\Users\\dev', 'win32', 'C:\\Users\\dev\\AppData\\Roaming'),
    path.join('C:\\Users\\dev\\AppData\\Roaming', 'Zed', 'settings.json'),
  )
})

test('JetBrains discovery lists product directories and survives a missing root', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-jb-'))
  const appData = path.join(home, 'AppData')
  assert.deepEqual(findJetBrainsDirectories(home, 'linux', appData), [], 'no JetBrains root yet')

  const root = path.join(appData, 'JetBrains')
  fs.mkdirSync(path.join(root, 'IntelliJIdea2025.2'), { recursive: true })
  fs.mkdirSync(path.join(root, 'WebStorm2025.1'), { recursive: true })
  fs.mkdirSync(path.join(root, '.hidden'), { recursive: true })
  fs.writeFileSync(path.join(root, 'stray-file.txt'), 'x')

  const found = findJetBrainsDirectories(home, 'linux', appData).map(dir => path.basename(dir)).sort()
  assert.deepEqual(found, ['IntelliJIdea2025.2', 'WebStorm2025.1'])
})

test('node resolution finds each version manager layout, not just fnm', () => {
  // Windows GUI apps inherit a usable PATH and are not laid out this way.
  assert.equal(resolveNodeCommand('/home/dev', 'win32'), 'node')

  const makeNode = (home, ...segments) => {
    const file = path.join(home, ...segments)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '#!/bin/sh\n')
    return file
  }

  const nvmHome = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-nvm-'))
  makeNode(nvmHome, '.nvm', 'versions', 'node', 'v18.20.0', 'bin', 'node')
  const newest = makeNode(nvmHome, '.nvm', 'versions', 'node', 'v22.5.1', 'bin', 'node')
  assert.equal(resolveNodeCommand(nvmHome, 'linux'), newest, 'nvm must resolve, and to its newest version')

  const voltaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-volta-'))
  const volta = makeNode(voltaHome, '.volta', 'bin', 'node')
  assert.equal(resolveNodeCommand(voltaHome, 'linux'), volta)

  const asdfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-asdf-'))
  const asdf = makeNode(asdfHome, '.asdf', 'shims', 'node')
  assert.equal(resolveNodeCommand(asdfHome, 'linux'), asdf)

  const fnmHome = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-fnm-'))
  const fnm = makeNode(fnmHome, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node')
  assert.equal(resolveNodeCommand(fnmHome, 'linux'), fnm)
})

test('Claude Desktop on Windows finds the Store install, not just the Win32 one', () => {
  // Two installers, two locations. The MSIX/Store build is sandboxed: its
  // config lives under a per-package LocalCache and %APPDATA%\Claude is never
  // created, so checking only the roaming path reports it missing and installs
  // a file the app will not read.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-win-'))
  const appData = path.join(home, 'AppData', 'Roaming')
  const localAppData = path.join(home, 'AppData', 'Local')

  const roaming = path.join(appData, 'Claude', 'claude_desktop_config.json')
  const packaged = path.join(
    localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc',
    'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json',
  )

  // Nothing installed: the roaming path is the default to write to.
  assert.equal(
    getClaudeDesktopConfigPath(home, 'win32', appData, localAppData),
    roaming,
    'with no install, fall back to the Win32 location',
  )

  // A Store install exists and the Win32 one does not.
  fs.mkdirSync(path.dirname(packaged), { recursive: true })
  const candidates = getClaudeDesktopConfigCandidates(home, 'win32', appData, localAppData)
  assert.ok(candidates.includes(packaged), 'the packaged path must be a candidate')
  assert.ok(candidates.includes(roaming), 'the Win32 path must remain a candidate')
  assert.equal(
    getClaudeDesktopConfigPath(home, 'win32', appData, localAppData),
    packaged,
    'an existing Store install must win over the unused roaming default',
  )

  // With a real config file on the Win32 side and only an empty package
  // directory on the Store side, the file wins: a written configuration is
  // stronger evidence of the install in use than a folder that exists.
  fs.mkdirSync(path.dirname(roaming), { recursive: true })
  fs.writeFileSync(roaming, '{}')
  assert.equal(
    getClaudeDesktopConfigPath(home, 'win32', appData, localAppData),
    roaming,
    'an existing config file outranks a bare package directory',
  )

  // Once the Store install has a config of its own, it leads again.
  fs.writeFileSync(packaged, '{}')
  assert.equal(
    getClaudeDesktopConfigPath(home, 'win32', appData, localAppData),
    packaged,
    'a packaged config file is preferred over the roaming one',
  )
})

test('Claude Desktop keeps a single location on macOS and Linux', () => {
  const home = '/Users/dev'
  assert.deepEqual(
    getClaudeDesktopConfigCandidates(home, 'darwin', path.join(home, 'Library', 'Application Support')),
    [path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')],
  )
})
