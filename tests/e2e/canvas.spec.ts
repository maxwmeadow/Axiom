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

test('preserves tokenized app chrome geometry and toolbar interaction states', async () => {
  const toolbar = page.locator('.axiom-toolbar')
  const rail = page.locator('.axiom-sheet-rail')
  const status = page.locator('.axiom-status-bar')
  const [toolbarBox, railBox, statusBox] = await Promise.all([
    toolbar.boundingBox(),
    rail.boundingBox(),
    status.boundingBox(),
  ])

  expect(toolbarBox?.height).toBeCloseTo(48, 0)
  expect(railBox?.width).toBeCloseTo(176, 0)
  expect(statusBox?.height).toBeCloseTo(28, 0)

  const lasso = page.getByRole('button', { name: 'Lasso Select' })
  await lasso.hover()
  await expect.poll(() => lasso.evaluate(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, color: style.color }
  })).toEqual({ background: 'rgb(34, 38, 42)', color: 'rgb(226, 232, 240)' })

  await lasso.click()
  const active = page.getByRole('button', { name: 'Lasso Active' })
  await expect.poll(() => active.evaluate(element => {
    const style = getComputedStyle(element)
    return { border: style.borderColor, color: style.color }
  })).toEqual({ border: 'rgb(91, 138, 154)', color: 'rgb(91, 138, 154)' })
})

test('opens shared dialog chrome with the preserved visual tokens', async () => {
  const first = page.locator('.react-flow__node[data-id="file_canvas"]')
  const second = page.locator('.react-flow__node[data-id="file_types"]')
  const firstBox = await first.boundingBox()
  const secondBox = await second.boundingBox()
  expect(firstBox).not.toBeNull()
  expect(secondBox).not.toBeNull()
  if (!firstBox || !secondBox) return

  await page.getByRole('button', { name: 'Lasso Select' }).click()
  await page.mouse.move(
    Math.min(firstBox.x, secondBox.x) - 4,
    Math.min(firstBox.y, secondBox.y) - 4,
  )
  await page.mouse.down()
  await page.mouse.move(
    Math.max(firstBox.x + firstBox.width, secondBox.x + secondBox.width) + 4,
    Math.max(firstBox.y + firstBox.height, secondBox.y + secondBox.height) + 4,
    { steps: 8 },
  )
  await page.mouse.up()

  const newSheetButton = page.getByRole('button', { name: 'New Sheet', exact: true })
  await expect(newSheetButton).toBeVisible()
  await newSheetButton.click()
  const backdrop = page.locator('.axiom-dialog-backdrop')
  const surface = page.locator('.axiom-dialog-surface')
  await expect(surface).toBeVisible()
  await expect(surface.getByRole('heading', { name: 'New Sheet' })).toBeVisible()

  const backdropColor = await backdrop.evaluate(element => getComputedStyle(element).backgroundColor)
  const surfaceBox = await surface.boundingBox()
  const surfaceStyle = await surface.evaluate(element => {
    const style = getComputedStyle(element)
    return { padding: style.padding, borderRadius: style.borderRadius }
  })
  expect(backdropColor).toBe('rgba(5, 8, 15, 0.7)')
  expect(surfaceBox?.width).toBeCloseTo(420, 0)
  expect(surfaceStyle).toEqual({ padding: '28px', borderRadius: '0px' })

  await surface.getByRole('button', { name: 'Cancel' }).click()
  await expect(surface).toHaveCount(0)
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

test('drags a root node fluidly and keeps its persisted final frame', async () => {
  const node = page.locator('.react-flow__node[data-id="infra_mcp_proto"]')
  const before = await node.boundingBox()
  expect(before).not.toBeNull()
  if (!before) return

  const start = { x: before.x + before.width / 2, y: before.y + before.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 48, start.y + 32, { steps: 12 })
  await page.mouse.up()

  const after = await node.boundingBox()
  expect(after).not.toBeNull()
  expect(after!.x).toBeGreaterThan(before.x + 35)
  expect(after!.y).toBeGreaterThan(before.y + 20)
  await expect(node).toHaveClass(/selected/)
})

test('persists a container reparenting drop as one layout batch', async () => {
  let persistedParent: string | null | undefined
  page.on('request', request => {
    if (!request.url().includes('/api/layout/batch') || request.method() !== 'POST') return
    const payload = request.postDataJSON() as { layouts?: Array<{ nodeId: string; parentNodeId: string | null }> }
    const moved = payload.layouts?.find(layout => layout.nodeId === 'infra_mcp_proto')
    if (moved) persistedParent = moved.parentNodeId
  })

  const source = page.locator('.react-flow__node[data-id="infra_mcp_proto"]')
  const target = page.locator('.react-flow__node[data-id="sys_canvas"]')
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  if (!sourceBox || !targetBox) return

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + 20, targetBox.y + 20, { steps: 16 })
  await page.mouse.up()

  await expect.poll(() => persistedParent).toBe('sys_canvas')
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
