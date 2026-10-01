import { _electron as electron, expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('Send launches the selected CLI after saving, preserves failures, and supports editor handoff', async () => {
  test.setTimeout(90000)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-delivery-ui-'))
  const root = path.join(home, 'project')
  const bin = path.join(home, 'bin')
  fs.mkdirSync(root); fs.mkdirSync(bin); fs.mkdirSync(path.join(home, '.axiom'))
  fs.writeFileSync(path.join(home, '.axiom', 'projects.json'), JSON.stringify([{ id: 'demo', name: 'Delivery fixture', rootPath: root, ignoredPaths: [], createdAt: 1 }]))
  const fakeAgent = 'const fs=require("fs");const host=process.env.AXIOM_AGENT_HOST;const prompt=host==="copilot-cli"?process.argv[process.argv.indexOf("--prompt")+1]:fs.readFileSync(0,"utf8");fs.writeFileSync("captured-"+host+".json",JSON.stringify({args:process.argv.slice(2),prompt,cwd:process.cwd(),workspace:process.env.AXIOM_WORKSPACE_ID}));fs.writeSync(1,"Fixture agent started");process.exit(host==="copilot-cli"?7:0)'
  const scripts: Record<string, string> = { claude: '@anthropic-ai/claude-code/cli.js', codex: '@openai/codex/bin/codex.js', copilot: '@github/copilot/index.js' }
  for (const [name, entry] of Object.entries(scripts)) {
    const script = path.join(bin, 'node_modules', entry)
    fs.mkdirSync(path.dirname(script), { recursive: true }); fs.writeFileSync(script, fakeAgent)
    if (process.platform !== 'win32') fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${fakeAgent}`, { mode: 0o755 })
  }
  if (process.platform !== 'win32') fs.writeFileSync(path.join(bin, 'zed'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(path.join(root, 'editor-opened.json'))},JSON.stringify(process.argv.slice(2)))`, { mode: 0o755 })
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  const app = await electron.launch({
    args: ['.', ...(process.env.AXIOM_HEADLESS_E2E === '1' && process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : [])],
    env: { ...env, HOME: home, USERPROFILE: home, PATH: bin, AXIOM_E2E: '1', AXIOM_API_TOKEN: 'axiom-isolated-ui-delivery-test-token-12345' },
  })
  try {
    const page = await app.firstWindow()
    expect(await page.evaluate(() => window.axiom.listDeliveryHosts())).toHaveLength(10)
    await page.setViewportSize({ width: 1280, height: 1000 })
    const orders: any[] = []
    await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
      const url = new URL(route.request().url())
      let body: any = []
      if (url.pathname === '/api/canvas/send') {
        const sent = route.request().postDataJSON()
        orders.push({ ...sent, status: 'queued', createdAt: Date.now() }); body = orders.at(-1)
        // Main reads the durable request, independently of renderer routing.
        await app.evaluate((_, order) => {
          const runtime = globalThis as any
          runtime.deliveryOrders ??= {}
          runtime.deliveryOrders[order.id] = order
          runtime.fetch = async (input: string) => {
            const url = new URL(String(input))
            const found = runtime.deliveryOrders[url.searchParams.get('messageId') ?? '']
            return new Response(JSON.stringify(found ?? { error: 'not found' }), { status: found ? 200 : 404 })
          }
        }, body)
      }
      if (url.pathname === '/api/canvas/history') body = { messages: [...orders].reverse(), nextCursor: '', availableCount: orders.length }
      if (url.pathname === '/api/agent/presence') body = { connected: false, connections: [] }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.getByRole('button', { name: /^Message agent/ }).click()
    const inbox = page.getByRole('complementary', { name: 'Agent inbox' })
    const destination = inbox.getByRole('combobox', { name: 'Work-order destination' })
    await expect(destination.locator('option')).toHaveCount(11)
    for (const [host, label] of [['claude-code', 'Claude Code (CLI)'], ['codex', 'OpenAI Codex (CLI)'], ['copilot-cli', 'GitHub Copilot (CLI)']]) {
      await destination.selectOption(host)
      await inbox.getByRole('textbox', { name: 'Instruction for your agent' }).fill(`Handle only the ${host} fixture.`)
      await inbox.locator('form').getByRole('button', { name: `Start ${label}` }).click()
      const captured = path.join(root, `captured-${host}.json`)
      await expect.poll(() => fs.existsSync(captured)).toBe(true)
      const actual = JSON.parse(fs.readFileSync(captured, 'utf8'))
      expect(actual.workspace).toBe('demo'); expect(actual.cwd).toBe(fs.realpathSync(root))
      expect(actual.prompt).toContain(orders.at(-1).id)
      expect(actual.prompt).toContain('expectedWorkspaceId "demo"')
      await expect(inbox.locator('.axiom-inbox__delivery-run').last()).toContainText(host === 'copilot-cli' ? 'Agent exited 7' : 'Agent process finished')
      await expect(inbox.locator('.axiom-inbox__status').last()).toHaveText('Waiting for an agent')
    }
    // The nonzero process exit leaves one saved work order, with output and handoff.
    expect(orders).toHaveLength(3)
    await expect(inbox.getByRole('button', { name: 'Show agent output' })).toHaveCount(3)
    const firstMessageId = orders.at(-1).id
    await expect(inbox.locator('.axiom-inbox__message').last().getByRole('button', { name: 'Start GitHub Copilot (CLI)' })).toBeDisabled()
    const modifiedAt = fs.statSync(path.join(root, 'captured-copilot-cli.json')).mtimeMs
    await page.evaluate(messageId => window.axiom.deliverWorkOrder({ workspaceId: 'demo', messageId, hostId: 'copilot-cli' }), firstMessageId)
    expect(fs.statSync(path.join(root, 'captured-copilot-cli.json')).mtimeMs).toBe(modifiedAt)
    expect(orders.at(-1).id).toBe(firstMessageId)
    if (process.platform !== 'win32') {
      await destination.selectOption('zed')
      await inbox.getByRole('textbox', { name: 'Instruction for your agent' }).fill('Discuss this in Zed.')
      await inbox.locator('form').getByRole('button', { name: 'Copy + open Zed Editor' }).click()
      await expect.poll(() => fs.existsSync(path.join(root, 'editor-opened.json'))).toBe(true)
      expect(JSON.parse(fs.readFileSync(path.join(root, 'editor-opened.json'), 'utf8'))).toEqual([root])
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain(orders.at(-1).id)
      await expect(inbox.getByRole('status').filter({ hasText: 'work has not started yet' })).toBeVisible()
    }
    await page.screenshot({ path: 'test-results/agent-delivery.png' })
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }) }
})
