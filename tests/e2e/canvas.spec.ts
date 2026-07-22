import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let app: ElectronApplication
let page: Page

async function expectResizeChrome(nodeId: string) {
  const handles = page.locator(`.axiom-node-resizer[data-node-id="${nodeId}"] .axiom-floating-resize-handle`)
  await expect(handles).toHaveCount(8)
  for (const handle of await handles.all()) {
    const hitBox = await handle.boundingBox()
    const visualBox = await handle.locator('rect').first().boundingBox()
    expect(hitBox?.width).toBeCloseTo(18, 0)
    expect(hitBox?.height).toBeCloseTo(18, 0)
    expect(visualBox?.width).toBeCloseTo(8, 0)
    expect(visualBox?.height).toBeCloseTo(8, 0)
  }
  return handles
}

test.beforeEach(async () => {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env
  app = await electron.launch({
    args: ['.'],
    env: { ...env, AXIOM_E2E: '1' },
  })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
    const body = route.request().url().includes('/api/layout/batch')
      ? { revision: 1, layouts: [] }
      : []
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  // Reload after routing so even the fixture's initial layout persistence is
  // deterministic and cannot race a refused localhost request.
  await page.reload()
  await expect(page.getByText('Axiom Canvas Fixture')).toBeVisible()
  await expect(page.locator('.react-flow__node[data-id="file_canvas"]')).toBeVisible()
  await expect(page.getByText(/Zoom: \d+\.\d{2}x/)).toBeVisible()
  // Initial sheet chrome and fitView animations run for 500ms and 400ms.
  // Measure interactions only after both have reached their authored frame.
  await expect(page.locator('.layout-transition')).toHaveCount(0)
  await page.waitForTimeout(600)
})

test.afterEach(async () => {
  await app?.close()
})

test('renders the deterministic Floor baseline', async () => {
  await expect(page.locator('.react-flow')).toHaveScreenshot('floor-baseline.png')
})

test('keeps resize chrome screen-sized and attached while resizing', async () => {
  const node = page.locator('.react-flow__node[data-id="file_canvas"]')
  await node.click({ position: { x: 12, y: 12 } })
  await expect(node).toHaveClass(/selected/)

  const handles = await expectResizeChrome('file_canvas')

  const initialNode = await node.boundingBox()
  expect(initialNode).not.toBeNull()

  const bottomRight = page.locator('[data-resize-direction="bottom-right"]')
  const anchor = await bottomRight.boundingBox()
  expect(anchor).not.toBeNull()
  if (!anchor || !initialNode) return

  await page.mouse.move(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2)
  await page.mouse.down()
  await page.mouse.move(anchor.x + anchor.width / 2 + 36, anchor.y + anchor.height / 2 + 24, { steps: 12 })
  await page.mouse.up()

  const resizedNode = await node.boundingBox()
  expect(resizedNode).not.toBeNull()
  expect(resizedNode!.x).toBeCloseTo(initialNode.x, 0)
  expect(resizedNode!.y).toBeCloseTo(initialNode.y, 0)
  expect(resizedNode!.width).toBeGreaterThan(initialNode.width + 25)
  expect(resizedNode!.height).toBeGreaterThan(initialNode.height + 15)
})

test('supports click, pane deselection, and partial lasso selection', async () => {
  const node = page.locator('.react-flow__node[data-id="infra_mcp_proto"]')
  await node.click()
  await expect(node).toHaveClass(/selected/)

  await page.locator('.react-flow__pane').click({ position: { x: 1000, y: 650 } })
  await expect(node).not.toHaveClass(/selected/)

  await page.getByRole('button', { name: 'Lasso Select' }).click()
  await expect(page.getByRole('button', { name: 'Lasso Active' })).toBeVisible()
  const box = await node.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  await page.mouse.move(box.x - 8, box.y - 8)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect(node).toHaveClass(/selected/)
})

test('wheel zoom continues over revealed file content through 100x', async () => {
  const node = page.locator('.react-flow__node[data-id="file_canvas"]')
  await node.click({ position: { x: 12, y: 12 } })
  await expect(node).toHaveClass(/selected/)
  const box = await node.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 50; i += 1) {
    await page.mouse.wheel(0, -100)
  }

  await expect(page.getByText('Zoom: 100.00x')).toBeVisible({ timeout: 15_000 })
  await expect(node).toBeVisible()
  await expectResizeChrome('file_canvas')
})
