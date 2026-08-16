/**
 * Axiom Architecture Seeder - Project Radial
 *
 * This script calls the Axiom agent API (http://localhost:7743) directly
 * to demonstrate the agent-first architecture workflow. Run this while
 * Axiom is open with Project Radial indexed.
 *
 * Usage: npx ts-node scripts/seed-architecture.ts
 *   OR:  node -e "require('./scripts/seed-architecture.js')"  (after build)
 */

const BASE = 'http://localhost:7743'

async function api(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`[${res.status}] ${path}: ${text}`)
  }
  return res.json()
}

async function createSystem(name: string, description: string): Promise<string> {
  const result = await api('/systems', 'POST', { name, description, layer: 'SERVICE' })
  console.log(`  ✓ Created system: "${name}" (${result.id})`)
  return result.id as string
}

async function assignFiles(systemId: string, filePaths: string[]) {
  const result = await api(`/systems/${systemId}/assign`, 'POST', { filePaths })
  console.log(`  ✓ Assigned ${result.assigned} files to system`)
}

async function connect(fromId: string, toId: string, label: string) {
  await api('/systems/connection', 'POST', { fromId, toId, type: 'DATA_FLOW', label })
  console.log(`  ✓ Connected: ${label}`)
}

async function main() {
  // ── 1. Check health ─────────────────────────────────────────────────────
  console.log('\n🔍 Checking Axiom connection...')
  let health: any
  try {
    health = await api('/health')
  } catch {
    console.error('❌ Cannot connect to Axiom. Make sure Axiom is running with a project indexed.')
    console.error('   Expected: http://localhost:7743/health')
    process.exit(1)
  }
  console.log(`✓ Connected - ${health.fileCount} files, ${health.nodeCount} nodes`)

  // ── 2. Get raw files so we can assign them to systems ───────────────────
  console.log('\n📂 Loading indexed files...')
  const { files } = await api('/raw-files') as { files: { filePath: string; language: string }[] }
  console.log(`  Found ${files.length} files across ${new Set(files.map(f => f.language)).size} languages`)

  // ── 3. Categorize files by path patterns ────────────────────────────────
  // This is what an AI agent does - but here we do it with path matching
  // for a predictable demo. A real agent would read the content/symbols.
  const bySystem: Record<string, string[]> = {
    'AI & NPC Behavior':    [],
    'Combat & Damage':      [],
    'World & Environment':  [],
    'UI & HUD':             [],
    'Audio':                [],
    'Cameras':              [],
    'Core Infrastructure':  [],
  }

  for (const f of files) {
    const p = f.filePath.toLowerCase()
    if (p.includes('ai') || p.includes('npc') || p.includes('pawn') || p.includes('brain') || p.includes('need') || p.includes('behavior')) {
      bySystem['AI & NPC Behavior'].push(f.filePath)
    } else if (p.includes('combat') || p.includes('damage') || p.includes('health') || p.includes('weapon') || p.includes('attack') || p.includes('hit')) {
      bySystem['Combat & Damage'].push(f.filePath)
    } else if (p.includes('world') || p.includes('tile') || p.includes('map') || p.includes('terrain') || p.includes('chunk') || p.includes('env')) {
      bySystem['World & Environment'].push(f.filePath)
    } else if (p.includes('ui') || p.includes('hud') || p.includes('menu') || p.includes('screen') || p.includes('panel') || p.includes('button')) {
      bySystem['UI & HUD'].push(f.filePath)
    } else if (p.includes('audio') || p.includes('sound') || p.includes('music') || p.includes('sfx')) {
      bySystem['Audio'].push(f.filePath)
    } else if (p.includes('camera') || p.includes('cinemachine') || p.includes('view')) {
      bySystem['Cameras'].push(f.filePath)
    } else {
      bySystem['Core Infrastructure'].push(f.filePath)
    }
  }

  // ── 4. Create systems and assign files ──────────────────────────────────
  console.log('\n🏗️  Creating architectural systems...')
  const systemIds: Record<string, string> = {}

  for (const [name, fps] of Object.entries(bySystem)) {
    if (fps.length === 0) {
      console.log(`  ⚠️  Skipping "${name}" - no matching files`)
      continue
    }
    const descriptions: Record<string, string> = {
      'AI & NPC Behavior':   'NPC decision-making, needs system, pawn controllers, and behavioral AI',
      'Combat & Damage':     'Attack resolution, damage calculation, health management, and combat feedback',
      'World & Environment': 'World generation, tile system, map loading, and environmental objects',
      'UI & HUD':            'All user interface elements, HUD components, menus, and screen management',
      'Audio':               'Sound effect triggers, music system, and audio mixing',
      'Cameras':             'Camera controllers, cinematic sequences, and viewport management',
      'Core Infrastructure': 'Game managers, utilities, data types, and shared infrastructure',
    }
    systemIds[name] = await createSystem(name, descriptions[name] ?? '')
    await assignFiles(systemIds[name], fps)
  }

  // ── 5. Create semantic connections between systems ───────────────────────
  console.log('\n🔗 Creating semantic connections...')
  const pairs: [string, string, string][] = [
    ['AI & NPC Behavior',   'Combat & Damage',     'NPC triggers combat → damage pipeline'],
    ['AI & NPC Behavior',   'World & Environment', 'Pathfinding reads world state'],
    ['Combat & Damage',     'UI & HUD',            'Health changes update HUD'],
    ['World & Environment', 'AI & NPC Behavior',   'World events wake NPC behaviors'],
    ['Core Infrastructure', 'AI & NPC Behavior',   'Shared utilities used by AI'],
    ['Core Infrastructure', 'Combat & Damage',     'Damage types defined in core'],
    ['Cameras',             'UI & HUD',            'Camera state drives UI transitions'],
    ['Audio',               'Combat & Damage',     'Combat events trigger SFX'],
  ]

  for (const [from, to, label] of pairs) {
    if (systemIds[from] && systemIds[to]) {
      await connect(systemIds[from], systemIds[to], label)
    }
  }

  // ── 6. Summary ──────────────────────────────────────────────────────────
  console.log('\n✅ Architecture mapped!')
  console.log('   Switch to Axiom - the canvas should now show semantic systems.')
  console.log('   Zoom in on any system to see its files appear inside it.')
  console.log('\n   Systems created:')
  for (const [name, id] of Object.entries(systemIds)) {
    const count = bySystem[name]?.length ?? 0
    console.log(`   • ${name.padEnd(24)} ${count} files  (${id})`)
  }
}

main().catch(err => {
  console.error('\n❌ Error:', err.message)
  process.exit(1)
})
