const path = require('node:path')
const { _electron: electron } = require('@playwright/test')

async function main() {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env
  const app = await electron.launch({
    args: ['.'],
    env: { ...env, AXIOM_E2E: '1' },
  })

  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
      const body = route.request().url().includes('/api/layout/batch')
        ? { revision: 1, layouts: [] }
        : []
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      })
    })
    await page.reload()
    await page.getByText('Axiom Canvas Fixture').waitFor()
    await page.locator('.react-flow__node[data-id="file_canvas"]').waitFor()
    await page.waitForTimeout(1000)
    await page.screenshot({
      path: path.join(__dirname, 'axiom-actual-toolbar.png'),
      animations: 'disabled',
    })
  } finally {
    await app.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
