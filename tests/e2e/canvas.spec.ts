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

async function revealFileNode(nodeId: string) {
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
  if (await node.count() === 0) {
    const relPath = await page.evaluate(id => {
      const graphStore = (window as unknown as {
        __axiomGraphStore: { getState: () => { files: Array<{ id: string; relPath: string }> } }
      }).__axiomGraphStore
      return graphStore.getState().files.find(file => file.id === id)?.relPath ?? null
    }, nodeId)
    expect(relPath, `missing E2E file ${nodeId}`).not.toBeNull()
    await page.keyboard.press('Control+K')
    const search = page.getByRole('textbox', { name: 'Search project files' })
    await search.fill(relPath!)
    await page.getByRole('option').first().click()
    await expect(node).toBeAttached()
  }
  const box = await node.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return node
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let index = 0; index < 15; index += 1) {
    if (!await node.evaluate(element => element.classList.contains('axiom-node-hidden'))) break
    await page.mouse.wheel(0, -100)
    await page.waitForTimeout(30)
  }
  await expect(node).not.toHaveClass(/axiom-node-hidden/)
  // Wheel zoom is smoothed with requestAnimationFrame. The semantic class can
  // flip before the camera reaches its target, so interaction measurements
  // must wait for that final frame.
  await page.waitForTimeout(900)
  return node
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
    const url = route.request().url()
    const body = url.includes('/api/investigation/list?')
      ? {
          investigations: [{
            id: 'inv_checkout',
            name: 'Checkout timeout',
            commit: '9fc31ab4470',
            branch: 'fix/checkout',
            createdAt: 1_720_000_000_000,
            durationMs: 3_250,
            eventCount: 2,
          }],
        }
      : url.includes('/api/investigation/inv_checkout?')
        ? {
            id: 'inv_checkout',
            name: 'Checkout timeout',
            commit: '9fc31ab4470',
            branch: 'fix/checkout',
            createdAt: 1_720_000_000_000,
            durationMs: 3_250,
            events: [
              {
                type: 'investigation:note',
                offsetMs: 0,
                payload: { text: 'Checkout stalls after authorization' },
              },
              {
                type: 'runtime:call',
                offsetMs: 250,
                payload: { fileId: 'file_canvas', symbol: 'authorizePayment' },
              },
            ],
          }
      : url.includes('/api/layout/batch')
      ? { revision: 1, layouts: [] }
      : url.includes('/api/files/file_canvas/symbols?')
        ? [{
            id: 'symbol_render_canvas',
            fileId: 'file_canvas',
            name: 'renderCanvas',
            kind: 'function',
            lineStart: 3,
            lineEnd: 6,
          }]
      : url.includes('/api/files/file_canvas/source?')
        ? {
            fileId: 'file_canvas',
            relPath: 'src/renderer/canvas/AxiomCanvas.tsx',
            language: 'tsx',
            lineCount: 7,
            content: [
              "import React from 'react'",
              '',
              'export function renderCanvas() {',
              '  const ready = true',
              '  const canvas = <Canvas />',
              '  return ready ? canvas : null',
              '}',
            ].join('\n'),
          }
      : url.includes('/api/files/file_docs/source?')
        ? {
            fileId: 'file_docs',
            relPath: 'docs/ARCHITECTURE.md',
            language: 'markdown',
            lineCount: 3,
            content: '# Architecture\n\nThe renderer consumes indexed source only.',
          }
      : url.includes('/api/sheets/sheet_runtime?')
        ? {
            sheet: {
              id: 'sheet_runtime',
              workspaceId: 'demo',
              name: 'Runtime Draft',
              purpose: 'Focused runtime architecture',
              kind: 'structure',
              folder: '',
              createdBy: 'user',
              revision: 1,
              createdAt: 1,
              updatedAt: 1,
            },
            elements: [],
            annotations: [],
            planned: [],
            plannedEdges: [],
          }
      : url.includes('/api/sheets?workspace=')
        ? [{
            id: 'sheet_runtime',
            workspaceId: 'demo',
            name: 'Runtime Draft',
            purpose: 'Focused runtime architecture',
            kind: 'structure',
            folder: '',
            createdBy: 'user',
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
          }]
      : url.includes('/api/registry/services')
        ? {
            categories: [],
            services: [
              {
                id: 'aws/rds',
                name: 'Amazon RDS',
                category: 'database',
                subtype: 'relational',
                provider: 'aws',
                brand: { icon: '', color: '#d58b2d' },
              },
              {
                id: 'openai/api',
                name: 'OpenAI API',
                category: 'llm',
                provider: 'openai',
                brand: { icon: '', color: '#4f8b79' },
              },
            ],
          }
        : []
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  // Reload after routing so even the fixture's initial layout persistence is
  // deterministic and cannot race a refused localhost request.
  await page.reload()
  await expect(page.getByText('Axiom Canvas Fixture')).toBeVisible()
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
  await expect(page.locator('.axiom-zoom-indicator')).toBeVisible()
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

test('autofits complete system names while their contents are covered', async () => {
  const longName = 'Longitudinal Tracking and Trend Persistence'
  const targetId = await page.evaluate(name => {
    const graphStore = (window as any).__axiomGraphStore
    const state = graphStore.getState()
    const target = state.systems.find((system: any) => system.parentId == null) ?? state.systems[0]
    graphStore.getState().applySnapshot({
      workspaceId: state.currentProject.id,
      systems: state.systems.map((system: any) => system.id === target.id
        ? { ...system, name }
        : system),
      files: state.files,
      infraNodes: state.infraNodes,
      dependencies: state.dependencies,
      floorLayouts: state.floorLayouts,
    })
    return target.id
  }, longName)
  const node = page.locator(`.react-flow__node[data-id="${targetId}"]`)
  await expect(node.getByText(longName, { exact: true }).first()).toBeVisible()
  const titles = await node.getByText(longName, { exact: true }).evaluateAll(elements =>
    elements.map(element => {
      const parent = element.parentElement!
      const elementRect = element.getBoundingClientRect()
      const parentRect = parent.getBoundingClientRect()
      const parentStyle = getComputedStyle(parent)
      return {
        parentZIndex: parentStyle.zIndex,
        textOverflow: getComputedStyle(element).textOverflow,
        textWidth: elementRect.width,
        availableWidth: parentRect.width
          - Number.parseFloat(parentStyle.paddingLeft)
          - Number.parseFloat(parentStyle.paddingRight),
      }
    }),
  )
  const covered = titles.find(title => title.parentZIndex === '15')
  expect(covered).toBeDefined()
  expect(covered!.textOverflow).not.toBe('ellipsis')
  expect(covered!.textWidth).toBeLessThanOrEqual(covered!.availableWidth + 1)
})

test('defers and virtualizes an 805-file fresh-project overview', async () => {
  const fixture = await page.evaluate(() => {
    const graphStore = (window as any).__axiomGraphStore
    const state = graphStore.getState()
    const baseProject = state.currentProject
    const fileTemplate = state.files[0]
    const systemTemplate = state.systems[0]
    const files = Array.from({ length: 805 }, (_, index) => ({
      ...fileTemplate,
      id: `perf-file-${index}`,
      rootId: 'perf-root',
      relPath: `src/group-${index % 24}/file-${index}.ts`,
      path: `src/group-${index % 24}/file-${index}.ts`,
      systemId: null,
      positionX: 0,
      positionY: 0,
    }))
    const systems = Array.from({ length: 24 }, (_, index) => ({
      ...systemTemplate,
      id: `perf-system-${index}`,
      workspaceId: 'perf-large',
      name: `Group ${index}`,
      parentId: null,
      positionX: 0,
      positionY: 0,
    }))

    state.setCurrentProject({ ...baseProject, id: 'perf-large', name: 'Large Fixture' })
    state.beginIndexing()
    state.applySnapshot({ systems: [], files, infraNodes: [], dependencies: [], floorLayouts: [] })
    return { systems, files }
  })

  await expect(page.getByRole('status')).toContainText('Organizing 805 files')
  await expect(page.locator('.react-flow__node')).toHaveCount(0)

  await page.evaluate(({ systems, files }) => {
    const state = (window as any).__axiomGraphStore.getState()
    state.applyClassification({
      systems,
      files: files.map((file: any, index: number) => ({
        ...file,
        systemId: `perf-system-${index % systems.length}`,
      })),
      infraNodes: [],
      dependencies: [],
      floorLayouts: [],
    })
  }, fixture)

  await expect(page.getByRole('status')).toHaveCount(0)
  await expect(page.locator('.react-flow__node[data-id="perf-system-0"]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const state = (window as any).__axiomGraphStore.getState()
    return state.files.length
  })).toBe(805)
  await expect.poll(() => page.locator('.react-flow__node').count()).toBeLessThanOrEqual(24)
  await expect.poll(async () => {
    const label = await page.locator('.axiom-zoom-indicator').getAttribute('aria-label')
    return Number(label?.match(/[\d.]+/)?.[0] ?? Number.POSITIVE_INFINITY)
  }).toBeLessThanOrEqual(0.12)
})

test('keeps repeated hidden-node flows above every canvas node without clearing the scene', async () => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  const baselineNodeCount = await page.locator('.react-flow__node').count()
  const visibleNodeCount = () => page.locator('.react-flow__node').evaluateAll(nodes =>
    nodes.filter(node => {
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && Number(getComputedStyle(node).opacity) > 0.1
    }).length
  )
  const baselineVisibleNodeCount = await visibleNodeCount()

  // The demo graph deliberately leaves child positions at (0, 0) for the
  // layout engine. Give this same-system pair distinct authored geometry so
  // the regression exercises a real path as well as the inspection handoff.
  await page.evaluate(() => {
    const graphStore = (window as unknown as {
      __axiomGraphStore: {
        getState: () => {
          files: Array<Record<string, unknown>>
          applyDbPatch: (patch: unknown) => void
        }
      }
    }).__axiomGraphStore
    const state = graphStore.getState()
    for (const [id, positionX, positionY] of [
      ['file_systemnode', 48, 72],
      ['file_filenode', 344, 196],
    ] as const) {
      const file = state.files.find(candidate => candidate.id === id)
      if (!file) throw new Error(`missing E2E living geometry for ${id}`)
      state.applyDbPatch({
        type: 'file:updated',
        payload: {
          file: { ...file, positionX, positionY },
          change: 'updated',
          animate: false,
        },
      })
    }
  })

  const emitUpdate = async (traceId: string, lineCount: number) => {
    await page.evaluate(({ traceId, lineCount }) => {
      const graphStore = (window as unknown as {
        __axiomGraphStore: {
          getState: () => {
            files: Array<Record<string, unknown>>
            applyDbPatch: (patch: unknown) => void
          }
        }
      }).__axiomGraphStore
      const state = graphStore.getState()
      const file = state.files.find(candidate => candidate.id === 'file_systemnode')
      if (!file) throw new Error('missing E2E living target')
      state.applyDbPatch({
        type: 'file:updated',
        payload: {
          file: { ...file, lineCount },
          change: 'updated',
          animate: true,
          traceId,
        },
      })
      state.applyDbPatch({
        type: 'relationship:changed',
        payload: {
          src: 'file_filenode',
          dst: 'file_systemnode',
          originId: 'file_systemnode',
          relationship: 'CALLS',
          change: 'updated',
          callerSymbol: 'FileNode',
          calleeSymbol: 'SystemNode',
          animate: true,
          traceId,
        },
      })
    }, { traceId, lineCount })
  }

  const assertTopFlow = async (traceId: string) => {
    const overlay = page.locator('.axiom-living-flow-overlay')
    const flow = overlay.locator('.axiom-living-flow')
    await expect(flow).toHaveCount(1)
    await expect(flow).toHaveAttribute('data-living-flow-source', 'file_systemnode')
    await expect(flow).toHaveAttribute('data-living-flow-target', 'file_filenode')
    await expect(page.locator('.react-flow')).toBeVisible()
    await expect(page.locator('.react-flow__node[data-id="file_systemnode"]')).toBeVisible()
    await expect(
      page.locator('.react-flow__node[data-id="file_systemnode"] .axiom-living-file-signal'),
    ).toContainText('EDITED')
    await expect.poll(() => overlay.evaluate(element => getComputedStyle(element).zIndex))
      .toBe('2147483000')
    await expect(flow.locator('.axiom-living-flow__track')).toHaveCount(0)
    await expect.poll(() => flow.locator('.axiom-living-flow__pulse').evaluate(
      path => (path as SVGGeometryElement).getTotalLength(),
    )).toBeGreaterThan(0)
    const renderedBoundaryHit = await flow.locator('.axiom-living-flow__pulse').evaluate(path => {
      const geometry = path as SVGGeometryElement
      const endpoint = geometry.getPointAtLength(geometry.getTotalLength())
      const screenMatrix = geometry.getScreenCTM()
      if (!screenMatrix) throw new Error('living flow has no screen transform')
      const screenEndpoint = new DOMPoint(endpoint.x, endpoint.y).matrixTransform(screenMatrix)
      const target = document.querySelector<HTMLElement>(
        '.react-flow__node[data-id="file_filenode"]',
      )
      // A semantically hidden target is deliberately absent from the DOM. The
      // overlay still routes to its canonical geometry; unit geometry tests
      // cover that boundary exactly, while this E2E verifies the live route
      // remains painted and identifies the virtualized target.
      if (!target) return { virtualized: true, edgeDistance: null, projectsOntoBoundary: false }
      const rect = target.getBoundingClientRect()
      const edgeDistance = Math.min(
        Math.abs(screenEndpoint.x - rect.left),
        Math.abs(screenEndpoint.x - rect.right),
        Math.abs(screenEndpoint.y - rect.top),
        Math.abs(screenEndpoint.y - rect.bottom),
      )
      const projectsOntoBoundary =
        (screenEndpoint.x >= rect.left - 1 && screenEndpoint.x <= rect.right + 1) ||
        (screenEndpoint.y >= rect.top - 1 && screenEndpoint.y <= rect.bottom + 1)
      return { virtualized: false, edgeDistance, projectsOntoBoundary }
    })
    if (!renderedBoundaryHit.virtualized) {
      expect(renderedBoundaryHit.edgeDistance).toBeLessThanOrEqual(1)
      expect(renderedBoundaryHit.projectsOntoBoundary).toBe(true)
    }
    await expect.poll(() => flow.locator('.axiom-living-flow__pulse').evaluate(path =>
      getComputedStyle(path).animationTimingFunction
    )).toBe('linear')
    await expect.poll(() => page.evaluate(activeTraceId => {
      const diagnostics = (window as unknown as {
        __axiomLivingFlowLog?: Array<{
          traceId: string
          stage: string
          paintAttempt?: number
        }>
      }).__axiomLivingFlowLog ?? []
      const trace = diagnostics.filter(entry => entry.traceId === activeTraceId)
      return {
        scheduled: trace.filter(entry => entry.stage === 'renderer-scheduled').length,
        paintStarts: trace.filter(entry => entry.stage === 'paint-start').length,
        attempts: trace
          .filter(entry => entry.stage === 'paint-start')
          .map(entry => entry.paintAttempt),
      }
    }, traceId)).toEqual({
      scheduled: 1,
      paintStarts: 1,
      attempts: [1],
    })
    await expect.poll(() => page.locator('.react-flow__node').count()).toBeGreaterThanOrEqual(baselineNodeCount)
    await expect(page.getByText('Render Error')).toHaveCount(0)
    expect(pageErrors, `page errors after ${traceId}`).toEqual([])
  }

  await emitUpdate('E2E-LIVING-1', 156)
  await assertTopFlow('E2E-LIVING-1')
  const continuousInspectionLayer = page.locator('.axiom-living-inspection-layer').first()
  await expect(continuousInspectionLayer).toBeVisible()
  await continuousInspectionLayer.evaluate(element => {
    element.setAttribute('data-choreography-instance', 'origin-window')
  })
  await expect(
    page.locator('.react-flow__node[data-id="file_filenode"] .axiom-living-file-signal'),
  ).toContainText('IMPACT', { timeout: 2_500 })
  await expect(continuousInspectionLayer).toHaveAttribute(
    'data-choreography-instance',
    'origin-window',
  )
  await expect(
    page.locator('.react-flow__node[data-id="file_systemnode"] .axiom-living-file-signal'),
  ).toHaveCount(0)
  await expect(continuousInspectionLayer).toHaveAttribute(
    'data-choreography-instance',
    'origin-window',
  )
  await expect(page.locator('.axiom-living-flow')).toHaveCount(0, { timeout: 4_000 })
  await expect(page.locator('.react-flow')).toBeVisible()

  await emitUpdate('E2E-LIVING-2', 155)
  await assertTopFlow('E2E-LIVING-2')
  await expect(
    page.locator('.react-flow__node[data-id="file_filenode"] .axiom-living-file-signal'),
  ).toContainText('IMPACT', { timeout: 2_500 })
  await expect(page.locator('.axiom-living-flow')).toHaveCount(0, { timeout: 4_000 })
  await expect(page.locator('.react-flow')).toBeVisible()
  await expect.poll(() => page.locator('.react-flow__node').count()).toBe(baselineNodeCount)

  // Simulate a delayed JavaScript expiry timer. CSS animations may finish
  // independently, but an active signal must never become a blank node or
  // leave its inspection system visually empty while state is still active.
  await expect(page.locator('.axiom-living-file-signal')).toHaveCount(0, { timeout: 3_000 })
  await page.evaluate(() => {
    const graphStore = (window as unknown as {
      __axiomGraphStore: {
        setState: (state: unknown) => void
      }
    }).__axiomGraphStore
    graphStore.setState({
      nodeFx: {
        file_systemnode: {
          kind: 'edit',
          key: 99_001,
          traceId: 'E2E-DELAYED-EXPIRY',
        },
      },
    })
  })
  const delayedSignal = page.locator(
    '.react-flow__node[data-id="file_systemnode"] .axiom-living-file-signal',
  )
  await expect(delayedSignal).toContainText('EDITED')
  await page.waitForTimeout(1_700)
  await expect(delayedSignal).toBeVisible()
  await expect.poll(() => delayedSignal.evaluate(element =>
    Number(getComputedStyle(element).opacity)
  )).toBeGreaterThan(0.9)
  await expect.poll(() => delayedSignal.evaluate(element =>
    getComputedStyle(element).filter
  )).toBe('none')
  await expect.poll(() => page.locator(
    '.react-flow__node[data-id="file_systemnode"] .axiom-file-node__normal',
  ).evaluate(element => Number(getComputedStyle(element).opacity))).toBeGreaterThan(0.9)
  await expect.poll(visibleNodeCount).toBeGreaterThanOrEqual(baselineVisibleNodeCount)
  for (const layer of await page.locator('.axiom-living-inspection-layer').all()) {
    await expect.poll(() => layer.evaluate(element =>
      Number(getComputedStyle(element).opacity)
    )).toBeGreaterThan(0.9)
    await expect.poll(() => layer.locator('xpath=..').locator(
      '.axiom-system-node__shell',
    ).evaluate(element => getComputedStyle(element).filter)).toBe('none')
  }
  await page.evaluate(() => {
    const graphStore = (window as unknown as {
      __axiomGraphStore: {
        setState: (state: unknown) => void
      }
    }).__axiomGraphStore
    graphStore.setState({ nodeFx: {} })
  })
  await expect(delayedSignal).toHaveCount(0)
  await expect.poll(visibleNodeCount).toBe(baselineVisibleNodeCount)
  expect(pageErrors).toEqual([])
})

test('never commits an empty canvas frame during rapid save and resync bursts', async () => {
  const pageErrors: string[] = []
  const integrityErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' && message.text().includes('[scene-integrity]')) {
      integrityErrors.push(message.text())
    }
  })
  const baselineNodeCount = await page.locator('.react-flow__node').count()
  expect(baselineNodeCount).toBeGreaterThan(0)

  await page.evaluate(() => {
    const monitor = {
      active: true,
      frames: 0,
      blankFrames: 0,
      minimumVisibleNodeCount: Number.POSITIVE_INFINITY,
    }
    ;(window as any).__axiomSceneFrameMonitor = monitor
    const sample = () => {
      if (!monitor.active) return
      const graphStore = (window as any).__axiomGraphStore
      const state = graphStore.getState()
      const canonicalCount = state.systems.length + state.files.length + state.infraNodes.length
      if (canonicalCount > 0) {
        const visibleCount = [...document.querySelectorAll<HTMLElement>('.react-flow__node')]
          .filter(node => {
            const style = getComputedStyle(node)
            return style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              Number(style.opacity) > 0.1
          })
          .length
        monitor.frames++
        monitor.minimumVisibleNodeCount = Math.min(
          monitor.minimumVisibleNodeCount,
          visibleCount,
        )
        if (visibleCount === 0) monitor.blankFrames++
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })

  for (let index = 0; index < 36; index++) {
    await page.evaluate((iteration) => {
      const graphStore = (window as any).__axiomGraphStore
      const state = graphStore.getState()
      const edited = state.files.find((file: any) => file.id === 'file_systemnode')
      const dependency = state.dependencies.find((item: any) =>
        item.src === 'file_canvas' && item.dst === 'file_systemnode')
      if (!edited || !dependency) throw new Error('missing rapid-save fixture data')

      if (iteration > 0 && iteration % 9 === 0) {
        state.applySnapshot({
          systems: state.systems,
          files: state.files,
          infraNodes: state.infraNodes,
          dependencies: state.dependencies,
          floorLayouts: state.floorLayouts,
        })
        return
      }
      if (iteration > 0 && iteration % 5 === 0) {
        state.applyClassification({
          systems: state.systems,
          files: state.files,
          infraNodes: state.infraNodes,
          dependencies: state.dependencies,
          floorLayouts: state.floorLayouts,
        })
        return
      }

      const traceId = `E2E-SAVE-STRESS-${iteration}`
      state.applyDbPatch({
        type: 'file:updated',
        payload: {
          file: { ...edited, lineCount: 155 + (iteration % 2) },
          change: 'updated',
          animate: true,
          traceId,
        },
      })
      state.applyDbPatch({
        type: 'relationship:changed',
        payload: {
          src: 'file_canvas',
          dst: 'file_systemnode',
          originId: 'file_systemnode',
          relationship: 'CALLS',
          change: 'updated',
          dependency: { ...dependency },
          callerSymbol: 'renderCanvas',
          calleeSymbol: 'SystemNode',
          animate: true,
          traceId,
        },
      })
    }, index)
    await page.waitForTimeout(18)
  }

  await page.waitForTimeout(1_800)
  const monitor = await page.evaluate(() => {
    const value = (window as any).__axiomSceneFrameMonitor
    value.active = false
    return value
  })
  expect(monitor.frames).toBeGreaterThan(20)
  expect(monitor.blankFrames).toBe(0)
  expect(monitor.minimumVisibleNodeCount).toBeGreaterThan(0)
  await expect(page.locator('.react-flow__node')).toHaveCount(baselineNodeCount)
  await expect(page.locator('.react-flow')).toBeVisible()

  // React Flow is an interaction renderer, not the owner of Axiom's semantic
  // nodes. Its default deletion shortcut must never erase the controlled Floor.
  await page.locator('.react-flow__node[data-id="sys_shared"]').click({ force: true })
  await page.keyboard.press('Delete')
  await expect(page.locator('.react-flow__node')).toHaveCount(baselineNodeCount)
  expect(integrityErrors).toEqual([])
  expect(pageErrors).toEqual([])
})

test('presents project navigation as a desktop workbench launcher', async () => {
  const launcherUrl = new URL(page.url())
  launcherUrl.searchParams.set('home', '1')
  await page.goto(launcherUrl.toString())

  const launcher = page.locator('.axiom-launcher')
  const titlebar = page.locator('.axiom-launcher__titlebar')
  const body = page.locator('.axiom-launcher__body')
  const openCodebase = page.getByRole('button', { name: 'Open Codebase' })

  await expect(launcher).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Axiom', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Command Deck' })).toBeVisible()
  await expect(openCodebase).toBeVisible()
  await expect(page.getByText('Living code topology')).toBeVisible()
  await expect(page.getByText('Visual agent dispatch')).toBeVisible()
  await expect(page.getByText('Semantic zoom')).toBeVisible()
  await expect(page.locator('button button')).toHaveCount(0)

  const [titlebarBox, bodyBox] = await Promise.all([titlebar.boundingBox(), body.boundingBox()])
  expect(titlebarBox?.height).toBeCloseTo(44, 0)
  expect(bodyBox?.width).toBeGreaterThan(900)
  expect(bodyBox?.height).toBeGreaterThan(700)
  const launcherType = await page.evaluate(() => ({
    description: parseFloat(getComputedStyle(document.querySelector('.axiom-launcher__description')!).fontSize),
    workspaceHeading: parseFloat(getComputedStyle(document.querySelector('.axiom-launcher__workspace-heading h2')!).fontSize),
    actionLabel: parseFloat(getComputedStyle(document.querySelector('.axiom-launcher__fork-copy strong')!).fontSize),
    actionHeight: document.querySelector('.axiom-launcher__fork')!.getBoundingClientRect().height,
  }))
  expect(launcherType.description).toBeGreaterThanOrEqual(15)
  expect(launcherType.workspaceHeading).toBeGreaterThanOrEqual(26)
  expect(launcherType.actionLabel).toBeGreaterThanOrEqual(16)
  expect(launcherType.actionHeight).toBeGreaterThanOrEqual(78)
  await expect.poll(() => openCodebase.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      display: style.display,
      background: style.backgroundImage,
      border: style.borderStyle,
    }
  })).toEqual({
    display: 'grid',
    background: expect.stringContaining('linear-gradient'),
    border: 'solid',
  })
})

test('chooses project sources in a folder-first file browser', async () => {
  const setupUrl = new URL(page.url())
  setupUrl.searchParams.set('setup', '1')
  await page.goto(setupUrl.toString())

  await expect(page.getByRole('heading', { name: 'Set up Axiom Canvas Fixture' })).toBeVisible()
  await expect(page.getByText('Choose what Axiom reads')).toBeVisible()
  const sourceTree = page.getByRole('tree', { name: 'Project files and folders' })
  await expect(sourceTree).toBeVisible()
  await expect(sourceTree.getByText('package.json', { exact: true })).toBeVisible()

  const startIndexing = page.getByRole('button', { name: /Index this project/ })
  await expect(startIndexing).toBeEnabled()

  const rootKinds = await sourceTree.locator(':scope > .axiom-setup-tree__branch').evaluateAll(branches =>
    branches.map(branch => branch.getAttribute('data-kind')),
  )
  const firstNonFolder = rootKinds.findIndex(kind => kind !== 'folder')
  expect(firstNonFolder).toBeGreaterThan(0)
  expect(rootKinds.slice(0, firstNonFolder).every(kind => kind === 'folder')).toBe(true)
  expect(rootKinds.slice(firstNonFolder).every(kind => kind !== 'folder')).toBe(true)

  const packageCheckbox = page.getByLabel('Include package.json', { exact: true })
  const packageRow = packageCheckbox.locator('xpath=ancestor::div[contains(@class, "axiom-setup-tree__row")]')
  await expect(packageRow.locator('.axiom-setup-tree__kind')).toHaveText('Unsupported')
  await expect(packageRow.locator('.axiom-setup-tree__state-label')).toHaveText('Skipped')
  await expect(packageCheckbox).toBeDisabled()

  const documentCheckbox = page.getByLabel('Include ARCHITECTURE.md', { exact: true })
  const documentRow = documentCheckbox.locator('xpath=ancestor::div[contains(@class, "axiom-setup-tree__row")]')
  await expect(documentRow.locator('.axiom-setup-tree__kind')).toHaveText('Document')
  await expect(documentRow.locator('.axiom-setup-tree__state-label')).toHaveText('Documents')
  await expect(documentCheckbox).toBeChecked()

  const sourceCheckbox = page.getByLabel('Include electron.vite.config.ts', { exact: true })
  const sourceRow = sourceCheckbox.locator('xpath=ancestor::div[contains(@class, "axiom-setup-tree__row")]')
  await expect(sourceRow.locator('.axiom-setup-tree__kind')).toHaveText('Source')
  await sourceCheckbox.click()
  await expect(sourceCheckbox).not.toBeChecked()
  await expect(sourceRow.locator('.axiom-setup-tree__state-label')).toHaveText('Excluded')

  const screenBox = await page.locator('.axiom-source-setup').boundingBox()
  expect(screenBox?.width).toBeGreaterThan(1200)
  expect(screenBox?.height).toBeGreaterThan(780)
  const setupScale = await page.evaluate(() => ({
    bodyCopy: parseFloat(getComputedStyle(document.querySelector('.axiom-source-setup__description')!).fontSize),
    treeLabel: parseFloat(getComputedStyle(document.querySelector('.axiom-setup-tree__name')!).fontSize),
    rowHeight: document.querySelector('.axiom-setup-tree__row')!.getBoundingClientRect().height,
    checkboxSize: document.querySelector('.axiom-setup-tree__check')!.getBoundingClientRect().width,
    primaryHeight: document.querySelector('.axiom-source-setup__submit')!.getBoundingClientRect().height,
  }))
  expect(setupScale.bodyCopy).toBeGreaterThanOrEqual(14)
  expect(setupScale.treeLabel).toBeGreaterThanOrEqual(15)
  expect(setupScale.rowHeight).toBeGreaterThanOrEqual(52)
  expect(setupScale.checkboxSize).toBeGreaterThanOrEqual(18)
  expect(setupScale.primaryHeight).toBeGreaterThanOrEqual(58)
  await expect(page.locator('button button')).toHaveCount(0)
})

test('keeps documentation in its library and off the architecture canvas', async () => {
  await page.evaluate(() => {
    const graphStore = (window as any).__axiomGraphStore
    const state = graphStore.getState()
    const template = state.files[0]
    graphStore.getState().applySnapshot({
      workspaceId: state.currentProject.id,
      systems: state.systems,
      files: [
        ...state.files,
        {
          ...template,
          id: 'file_docs',
          path: '/axiom-e2e/docs/ARCHITECTURE.md',
          relPath: 'docs/ARCHITECTURE.md',
          language: 'markdown',
          systemId: null,
          lineCount: 3,
        },
      ],
      infraNodes: state.infraNodes,
      dependencies: state.dependencies,
      floorLayouts: state.floorLayouts,
    })
  })

  await expect(page.locator('.react-flow__node[data-id="file_docs"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Project documents' }).click()
  const documents = page.getByRole('region', { name: 'Documents' })
  await expect(documents).toBeVisible()

  // The reader opens on its list rather than on whatever sorts first; a
  // document is shown because it was chosen.
  await documents.getByRole('button', { name: /ARCHITECTURE\.md/ }).click()

  // Markdown is rendered, not printed: the heading is a heading, and the prose
  // is prose.
  await expect(documents.getByRole('heading', { name: 'Architecture' })).toBeVisible()
  await expect(documents.getByText('The renderer consumes indexed source only.')).toBeVisible()
})

test('uses two-step agent setup for blank projects without changing codebase setup', async () => {
  let agentConnected = true
  await page.route(/\/api\/agent\/presence\?/, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      connected: agentConnected,
      connections: agentConnected
        ? [{ connectionId: 'connection-e2e', hostId: 'codex', lastSeenAt: Date.now() }]
        : [],
    }),
  }))
  const connectUrl = new URL(page.url())
  connectUrl.searchParams.set('connect', '1')
  connectUrl.searchParams.set('blank', '1')
  await page.goto(connectUrl.toString())

  const card = page.locator('.axiom-connect__card')
  await expect(card).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Bring an agent into Axiom' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Add Axiom to your agent' })).toBeVisible()

  const steps = page.getByRole('tablist', { name: 'Agent setup steps' }).getByRole('tab')
  await expect(steps).toHaveCount(2)
  await expect(steps.nth(0)).toHaveAttribute('aria-selected', 'true')

  const agents = page.getByRole('list', { name: 'Supported agents' })
  await expect(agents.locator(':scope > li')).toHaveCount(6)
  await expect(agents.getByText('found on this machine')).toHaveCount(0)
  await expect(agents.getByText(/Axiom configured|workflow missing|connected now/)).toHaveCount(0)
  await expect(agents.locator('.axiom-connect__host-signal')).toHaveCount(6)
  await expect(agents.locator('.axiom-connect__host-signal[data-state="live"]')).toHaveCount(1)
  const mascot = page.locator('.axiom-connect__mascot .axiom-final-gemini')
  await expect(mascot).toHaveAttribute('data-state', 'connected')

  const readStableFrame = () => page.evaluate(() => {
    const screen = document.querySelector('.axiom-connect')!
    const card = document.querySelector('.axiom-connect__card')!.getBoundingClientRect()
    const stage = document.querySelector('.axiom-connect__workspace')!.getBoundingClientRect()
    return {
      cardWidth: Math.round(card.width),
      cardHeight: Math.round(card.height),
      stageHeight: Math.round(stage.height),
      hasPageScrollbar: screen.scrollHeight > screen.clientHeight,
    }
  })
  const firstFrame = await readStableFrame()
  expect(firstFrame.hasPageScrollbar).toBe(false)

  await steps.getByText('Connect').click()
  await expect(page.getByRole('heading', { name: /Connect/ })).toBeVisible()
  expect(await readStableFrame()).toEqual(firstFrame)
  await expect(page.getByText('Live connection confirmed')).toBeVisible()
  const openCanvas = page.getByRole('button', { name: /Open canvas/ })
  await expect(openCanvas).toBeEnabled()
  await openCanvas.click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('agent_setup_completed_demo'))).toBe('true')
  await expect(page.locator('button button')).toHaveCount(0)

  const cardBox = await card.boundingBox()
  expect(cardBox?.width).toBeGreaterThan(900)
  expect(cardBox?.height).toBeLessThanOrEqual(820)

  agentConnected = false
  await expect(mascot).toHaveAttribute('data-state', 'sleeping', { timeout: 5_000 })
  await expect(agents.locator('.axiom-connect__host-signal[data-state="live"]')).toHaveCount(0)
  await expect(openCanvas).toBeDisabled()

  agentConnected = true
  const codebaseUrl = new URL(page.url())
  codebaseUrl.searchParams.delete('blank')
  await page.goto(codebaseUrl.toString())
  const codebaseSteps = page.getByRole('tablist', { name: 'Agent setup steps' }).getByRole('tab')
  await expect(codebaseSteps).toHaveCount(4)
  await expect(codebaseSteps.getByText('Map project')).toBeVisible()
  await expect(codebaseSteps.getByText('Review')).toBeVisible()
})

test('reviews the proposed system hierarchy in the unified workbench workflow', async () => {
  const indexedSnapshot = await page.evaluate(() => {
    const state = (window as any).__axiomGraphStore.getState()
    return {
      workspaceId: state.currentProject.id,
      systems: state.systems,
      files: state.files,
      infraNodes: state.infraNodes,
      dependencies: state.dependencies,
      floorLayouts: state.floorLayouts,
    }
  })
  const proposalBody = {
    id: 'proposal-e2e',
    workspaceId: 'demo',
    currentRevision: 1,
    createdAt: Date.now(),
    round: {
      rationale: 'Group the rendering pipeline by responsibility.',
      evidenceSummary: 'Entry points, imports, and shared state agree on these boundaries.',
      systems: [
        {
          systemKey: 'canvas', name: 'Living Canvas', description: 'Owns the interactive architecture Floor.',
          parentRefType: 'scope', parentRefId: null, depth: 0, decision: 'pending',
          fileCount: 2, affectedFileCount: 2,
        },
        {
          systemKey: 'zoom', name: 'Semantic Zoom', description: 'Controls progressive detail and visibility.',
          parentRefType: 'proposed_system', parentRefId: 'canvas', depth: 1, decision: 'pending',
          fileCount: 1, affectedFileCount: 1,
        },
      ],
      memberships: [
        {
          id: 'member-a', fileId: 'file_canvas', rootId: 'root_demo', filePath: 'src/renderer/canvas/AxiomCanvas.tsx',
          targetSystemKey: 'canvas', disposition: 'assign', rationale: '',
        },
        {
          id: 'member-b', fileId: 'file_layerzoom', rootId: 'root_demo', filePath: 'src/renderer/canvas/hooks/useLayerZoom.ts',
          targetSystemKey: 'zoom', disposition: 'assign', rationale: '',
        },
      ],
      layouts: [],
    },
  }
  await page.route('http://127.0.0.1:7743/api/architecture-proposals?workspace=demo', route =>
    route.fulfill({ json: [{ id: 'proposal-e2e' }] }),
  )
  await page.route(/http:\/\/127\.0\.0\.1:7743\/api\/architecture-proposals\/proposal-e2e\?workspace=demo/, route =>
    route.fulfill({ json: proposalBody }),
  )
  let proposalLayoutSaves = 0
  let proposalFinalizations = 0
  const proposalLayoutWriteKeys: string[][] = []
  let deferNextLayoutResponse = false
  let releaseDeferredLayoutResponse: (() => void) | null = null
  await page.route('http://127.0.0.1:7743/api/architecture-proposals/proposal-e2e/layouts', async route => {
    const request = route.request()
    const payload = request.postDataJSON() as { layouts: typeof proposalBody.round.layouts }
    proposalLayoutSaves += 1
    proposalLayoutWriteKeys.push((payload.layouts as Array<{ nodeType: string; nodeKey: string }>)
      .map(layout => `${layout.nodeType}:${layout.nodeKey}`))
    proposalBody.round.layouts = [
      ...proposalBody.round.layouts.filter(previous => !payload.layouts.some(layout =>
        layout.nodeType === previous.nodeType && layout.nodeKey === previous.nodeKey)),
      ...payload.layouts,
    ]
    if (deferNextLayoutResponse) {
      deferNextLayoutResponse = false
      await new Promise<void>(resolve => { releaseDeferredLayoutResponse = resolve })
      releaseDeferredLayoutResponse = null
    }
    await route.fulfill({ json: proposalBody })
  })
  await page.route('http://127.0.0.1:7743/api/architecture-proposals/proposal-e2e/finalize', async route => {
    proposalFinalizations += 1
    const request = route.request().postDataJSON() as {
      workspaceId: string
      revision: number
      decidedBy: string
      establishDeltaBaseline: boolean
    }
    expect(request).toEqual({
      workspaceId: 'demo',
      revision: 1,
      decidedBy: 'user',
      establishDeltaBaseline: true,
    })
    const materialized = new Map([
      ['canvas', 'committed-canvas'],
      ['zoom', 'committed-zoom'],
    ])
    proposalBody.round.systems = proposalBody.round.systems.map(system => ({
      ...system,
      decision: 'approved',
      materializedSystemId: materialized.get(system.systemKey),
    }))
    const systemTemplate = indexedSnapshot.systems[0]
    const committedSystems = proposalBody.round.systems.map(system => ({
      ...systemTemplate,
      id: materialized.get(system.systemKey)!,
      workspaceId: 'demo',
      name: system.name,
      description: system.description,
      source: 'agent',
      parentId: system.parentRefType === 'proposed_system'
        ? materialized.get(system.parentRefId ?? '') ?? null
        : null,
      depth: system.depth,
    }))
    const fileAssignments = new Map([
      ['file_canvas', 'committed-canvas'],
      ['file_layerzoom', 'committed-zoom'],
    ])
    const nodeId = (layout: { nodeType: string; nodeKey: string }) => layout.nodeType === 'system'
      ? materialized.get(layout.nodeKey)!
      : layout.nodeKey === 'member-a' ? 'file_canvas' : 'file_layerzoom'
    const reviewedLayouts = proposalBody.round.layouts as Array<{
      nodeType: 'system' | 'file'
      nodeKey: string
      parentRefType: 'scope' | 'live_system' | 'proposed_system'
      parentRefId: string
      positionX: number
      positionY: number
      width: number
      height: number
      scale: number
      interiorScale: number
    }>
    const committedLayouts = reviewedLayouts.map(layout => {
      const parentNodeId = layout.parentRefType === 'proposed_system'
        ? materialized.get(layout.parentRefId) ?? null
        : null
      return {
        workspaceId: 'demo',
        nodeId: nodeId(layout),
        nodeType: layout.nodeType,
        parentNodeId,
        parentNodeType: parentNodeId ? 'system' : null,
        containmentKind: parentNodeId ? 'part_of' : 'root',
        positionX: layout.positionX,
        positionY: layout.positionY,
        width: layout.width,
        height: layout.height,
        scale: layout.scale,
        interiorScale: layout.interiorScale,
        updatedAt: Date.now(),
      }
    })
    await route.fulfill({ json: {
      proposal: proposalBody,
      deltaBaselineAt: Date.now(),
      snapshot: {
        ...indexedSnapshot,
        systems: committedSystems,
        files: indexedSnapshot.files.map(file => ({
          ...file,
          systemId: fileAssignments.get(file.id) ?? null,
        })),
        floorLayouts: committedLayouts,
      },
    } })
  })
  const reviewUrl = new URL(page.url())
  reviewUrl.searchParams.set('review', '1')
  await page.goto(reviewUrl.toString())

  await expect(page.getByRole('heading', { name: 'Review the architecture your agent found' })).toBeVisible()
  await expect(page.getByText('STEP 04 / REVIEW THE MAP')).toBeVisible()
  const proposalPanel = page.getByRole('complementary', { name: 'Proposed architecture' })
  await expect(proposalPanel).toBeVisible()
  await expect(proposalPanel.getByText('Living Canvas', { exact: true })).toBeVisible()
  await expect(proposalPanel.getByText('Semantic Zoom', { exact: true })).toBeVisible()
  await expect(page.locator('.axiom-review__canvas').getByText('AxiomCanvas.tsx', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Done Reviewing' })).toBeVisible()
  await expect(page.locator('.axiom-review__canvas .react-flow')).toBeVisible()
  await expect(page.locator('.axiom-review__canvas .react-flow__background')).toHaveCount(1)
  await expect(page.locator('.axiom-review__canvas .axiom-canvas-review')).toHaveCount(1)
  await expect(page.getByText('PROPOSED SYSTEM FLOOR')).toBeVisible()
  // A review starts by freezing the same complete generated frame that the
  // live Floor freezes. No gesture may be the first sparse layout write.
  await expect.poll(() => proposalLayoutSaves).toBe(1)
  await expect(page.locator('.axiom-review__canvas .axiom-canvas-review-ready')).toHaveCount(1)
  expect(new Set(proposalLayoutWriteKeys[0]))
    .toEqual(new Set(['system:canvas', 'system:zoom', 'file:member-a', 'file:member-b']))

  const panelBox = await page.locator('.axiom-review__panel').boundingBox()
  const canvasBox = await page.locator('.axiom-review__canvas').boundingBox()
  expect(panelBox?.width).toBeGreaterThanOrEqual(560)
  expect(canvasBox?.width).toBeGreaterThan(760)
  const reviewScale = await page.evaluate(() => ({
    heading: parseFloat(getComputedStyle(document.querySelector('.axiom-review__heading h1')!).fontSize),
    purpose: parseFloat(getComputedStyle(document.querySelector('.axiom-proposal__purpose')!).fontSize),
    systemName: parseFloat(getComputedStyle(document.querySelector('.axiom-proposal__name')!).fontSize),
    decisionHeight: document.querySelector('.axiom-proposal__approve')!.getBoundingClientRect().height,
  }))
  expect(reviewScale.heading).toBeGreaterThanOrEqual(28)
  expect(reviewScale.purpose).toBeGreaterThanOrEqual(14)
  expect(reviewScale.systemName).toBeGreaterThanOrEqual(18)
  expect(reviewScale.decisionHeight).toBeGreaterThanOrEqual(40)
  await expect(proposalPanel.getByText('3 files in branch', { exact: true })).toBeVisible()

  await proposalPanel.getByRole('button', { name: 'Collapse Living Canvas' }).click()
  await expect(proposalPanel.getByText('Semantic Zoom', { exact: true })).toHaveCount(0)
  await proposalPanel.getByRole('button', { name: 'Expand Living Canvas' }).click()
  await expect(proposalPanel.getByText('Semantic Zoom', { exact: true })).toBeVisible()

  await page.locator('.axiom-review__canvas .react-flow__node-system')
    .filter({ hasText: 'Semantic Zoom' }).click({ position: { x: 10, y: 10 } })
  await expect(proposalPanel.locator('.axiom-proposal__item').filter({ hasText: 'Semantic Zoom' }))
    .toHaveAttribute('data-active', 'true')
  await expect(page.locator('.axiom-review__canvas .react-flow__node')).toHaveCount(4)

  // Review uses AxiomCanvas itself. Persisting a node drag must update only the
  // proposal geometry; it must not refit the camera or relayout its siblings.
  const draggedNode = page.locator('.axiom-review__canvas .react-flow__node[data-id="proposal-file:proposal-e2e:member-a"]')
  const nestedSystem = page.locator('.axiom-review__canvas .react-flow__node[data-id="proposal:proposal-e2e:zoom"]')
  const viewport = page.locator('.axiom-review__canvas .react-flow__viewport')
  const stableNodes = page.locator(
    '.axiom-review__canvas .react-flow__node:not([data-id="proposal-file:proposal-e2e:member-a"])',
  )
  const [dragBox, nestedLocalBefore, stableGeometryBefore, cameraBefore] = await Promise.all([
    draggedNode.boundingBox(),
    nestedSystem.evaluate(element => (element as HTMLElement).style.transform),
    stableNodes.evaluateAll(elements => elements.map(element => ({
      id: element.getAttribute('data-id'),
      transform: (element as HTMLElement).style.transform,
      width: (element as HTMLElement).style.width,
      height: (element as HTMLElement).style.height,
    }))),
    viewport.getAttribute('style'),
  ])
  expect(dragBox).not.toBeNull()
  const pointerStart = await draggedNode.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const id = element.getAttribute('data-id')
    for (let y = rect.top + 4; y < rect.bottom - 4; y += 6) {
      for (let x = rect.left + 4; x < rect.right - 4; x += 6) {
        const target = document.elementFromPoint(x, y) as HTMLElement | null
        if (target?.closest('.react-flow__node')?.getAttribute('data-id') === id &&
            !target.closest('.nodrag')) {
          return { x, y }
        }
      }
    }
    return null
  })
  expect(pointerStart).not.toBeNull()
  await draggedNode.evaluate(element => {
    const state = window as typeof window & {
      __axiomReviewDragTransforms?: string[]
      __axiomReviewDragObserver?: MutationObserver
    }
    state.__axiomReviewDragTransforms = [(element as HTMLElement).style.transform]
    state.__axiomReviewDragObserver?.disconnect()
    state.__axiomReviewDragObserver = new MutationObserver(() => {
      state.__axiomReviewDragTransforms!.push((element as HTMLElement).style.transform)
    })
    state.__axiomReviewDragObserver.observe(element, {
      attributes: true,
      attributeFilter: ['style'],
    })
  })
  await page.mouse.move(pointerStart!.x, pointerStart!.y)
  await page.mouse.down()
  await page.mouse.move(pointerStart!.x + 42, pointerStart!.y + 28, { steps: 12 })
  const [dragSamples, liveDragBox] = await Promise.all([
    draggedNode.evaluate(() => {
      const state = window as typeof window & {
        __axiomReviewDragTransforms?: string[]
        __axiomReviewDragObserver?: MutationObserver
      }
      state.__axiomReviewDragObserver?.disconnect()
      return (state.__axiomReviewDragTransforms ?? []).flatMap(transform => {
        const match = transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)
        return match ? [{ x: Number(match[1]), y: Number(match[2]) }] : []
      })
    }),
    draggedNode.boundingBox(),
  ])
  await expect(viewport).toHaveAttribute('style', cameraBefore ?? '')
  expect(liveDragBox).not.toBeNull()
  expect(dragSamples.length).toBeGreaterThan(2)
  for (let index = 1; index < dragSamples.length; index++) {
    // A controlled scene rebuild used to restore the persisted position on
    // alternating frames. A deliberate right/down drag may never move back.
    expect(dragSamples[index].x).toBeGreaterThanOrEqual(dragSamples[index - 1].x - 0.5)
    expect(dragSamples[index].y).toBeGreaterThanOrEqual(dragSamples[index - 1].y - 0.5)
  }
  expect(liveDragBox!.x).toBeGreaterThan(dragBox!.x + 25)
  expect(liveDragBox!.y).toBeGreaterThan(dragBox!.y + 15)
  deferNextLayoutResponse = true
  await page.mouse.up()
  await expect.poll(() => proposalLayoutSaves).toBe(2)
  await expect.poll(() => releaseDeferredLayoutResponse !== null).toBe(true)
  await expect.poll(() => viewport.getAttribute('style')).toBe(cameraBefore)
  await expect.poll(() => nestedSystem.evaluate(element => (element as HTMLElement).style.transform))
    .toBe(nestedLocalBefore)
  await expect.poll(() => stableNodes.evaluateAll(elements => elements.map(element => ({
    id: element.getAttribute('data-id'),
    transform: (element as HTMLElement).style.transform,
    width: (element as HTMLElement).style.width,
    height: (element as HTMLElement).style.height,
  })))).toEqual(stableGeometryBefore)

  // A held resize is also a controlled React Flow interaction. The fixed
  // opposite edge may not oscillate while proposal state is being previewed.
  const resizedSystem = page.locator(
    '.axiom-review__canvas .react-flow__node[data-id="proposal:proposal-e2e:canvas"]',
  )
  await resizedSystem.click({ position: { x: 18, y: 18 }, force: true })
  await expect(resizedSystem).toHaveClass(/selected/)
  const rightResizeHandle = resizedSystem.locator('[data-resize-direction="right"]')
  await expect(rightResizeHandle).toBeVisible()
  const [systemBoxBefore, resizeHandleBox] = await Promise.all([
    resizedSystem.boundingBox(),
    rightResizeHandle.boundingBox(),
  ])
  expect(systemBoxBefore).not.toBeNull()
  expect(resizeHandleBox).not.toBeNull()
  await resizedSystem.evaluate(element => {
    const state = window as typeof window & {
      __axiomReviewResizeFrames?: Array<{
        left: number
        right: number
        width: number
        bodyRight: number
        outlineRight: number
      }>
      __axiomReviewResizeObserver?: MutationObserver
    }
    const sample = () => {
      const rect = element.getBoundingClientRect()
      const body = element.querySelector<SVGElement>('.axiom-system-node__shell > svg')?.getBoundingClientRect()
      const outline = element.querySelector<HTMLElement>('.axiom-node-resizer')?.getBoundingClientRect()
      state.__axiomReviewResizeFrames!.push({
        left: rect.left,
        right: rect.right,
        width: rect.width,
        bodyRight: body?.right ?? Number.NaN,
        outlineRight: outline?.right ?? Number.NaN,
      })
    }
    state.__axiomReviewResizeFrames = []
    sample()
    state.__axiomReviewResizeObserver?.disconnect()
    state.__axiomReviewResizeObserver = new MutationObserver(sample)
    state.__axiomReviewResizeObserver.observe(element, {
      attributes: true,
      attributeFilter: ['style'],
    })
  })
  await page.mouse.move(
    resizeHandleBox!.x + resizeHandleBox!.width / 2,
    resizeHandleBox!.y + resizeHandleBox!.height / 2,
  )
  await page.mouse.down()
  for (let step = 1; step <= 16; step++) {
    await page.mouse.move(
      resizeHandleBox!.x + resizeHandleBox!.width / 2 + step * 3,
      resizeHandleBox!.y + resizeHandleBox!.height / 2,
    )
    await page.waitForTimeout(18)
    if (step === 8) {
      releaseDeferredLayoutResponse?.()
      await page.waitForTimeout(80)
    }
  }
  const resizeFrames = await resizedSystem.evaluate(() => {
    const state = window as typeof window & {
      __axiomReviewResizeFrames?: Array<{
        left: number
        right: number
        width: number
        bodyRight: number
        outlineRight: number
      }>
      __axiomReviewResizeObserver?: MutationObserver
    }
    state.__axiomReviewResizeObserver?.disconnect()
    return state.__axiomReviewResizeFrames ?? []
  })
  expect(resizeFrames.length).toBeGreaterThan(2)
  for (let index = 1; index < resizeFrames.length; index++) {
    expect(resizeFrames[index].left).toBeCloseTo(resizeFrames[0].left, 0)
    expect(resizeFrames[index].width).toBeGreaterThanOrEqual(resizeFrames[index - 1].width - 0.5)
    expect(resizeFrames[index].right).toBeGreaterThanOrEqual(resizeFrames[index - 1].right - 0.5)
    expect(resizeFrames[index].outlineRight).toBeCloseTo(resizeFrames[index].right, 0)
    expect(resizeFrames[index].bodyRight).toBeCloseTo(resizeFrames[index].right, 0)
  }
  expect(resizeFrames.at(-1)!.width).toBeGreaterThan(resizeFrames[0].width + 30)
  await page.mouse.up()
  await expect.poll(() => proposalLayoutSaves).toBe(3)
  await expect.poll(() => viewport.getAttribute('style')).toBe(cameraBefore)

  const leftResizeHandle = resizedSystem.locator('[data-resize-direction="left"]')
  const [systemBoxBeforeLeftResize, leftResizeHandleBox] = await Promise.all([
    resizedSystem.boundingBox(),
    leftResizeHandle.boundingBox(),
  ])
  expect(systemBoxBeforeLeftResize).not.toBeNull()
  expect(leftResizeHandleBox).not.toBeNull()
  await resizedSystem.evaluate(element => {
    const state = window as typeof window & {
      __axiomReviewResizeFrames?: Array<{
        left: number
        right: number
        width: number
        bodyRight: number
        outlineRight: number
      }>
      __axiomReviewResizeObserver?: MutationObserver
    }
    const sample = () => {
      const rect = element.getBoundingClientRect()
      const body = element.querySelector<SVGElement>('.axiom-system-node__shell > svg')?.getBoundingClientRect()
      const outline = element.querySelector<HTMLElement>('.axiom-node-resizer')?.getBoundingClientRect()
      state.__axiomReviewResizeFrames!.push({
        left: rect.left,
        right: rect.right,
        width: rect.width,
        bodyRight: body?.right ?? Number.NaN,
        outlineRight: outline?.right ?? Number.NaN,
      })
    }
    state.__axiomReviewResizeFrames = []
    sample()
    state.__axiomReviewResizeObserver?.disconnect()
    state.__axiomReviewResizeObserver = new MutationObserver(sample)
    state.__axiomReviewResizeObserver.observe(element, {
      attributes: true,
      attributeFilter: ['style'],
    })
  })
  await page.mouse.move(
    leftResizeHandleBox!.x + leftResizeHandleBox!.width / 2,
    leftResizeHandleBox!.y + leftResizeHandleBox!.height / 2,
  )
  await page.mouse.down()
  // Vary pointer velocity within one monotonic gesture. The review used to
  // look nearly correct at a slow pace while its secondary geometry stream
  // became visibly farther behind during these faster samples.
  const westResizeOffsets = [2, 4, 6, 10, 18, 30, 33, 36, 39, 42, 45, 48]
  for (const offset of westResizeOffsets) {
    await page.mouse.move(
      leftResizeHandleBox!.x + leftResizeHandleBox!.width / 2 - offset,
      leftResizeHandleBox!.y + leftResizeHandleBox!.height / 2,
    )
    await page.waitForTimeout(8)
  }
  const westResizeFrames = await resizedSystem.evaluate(() => {
    const state = window as typeof window & {
      __axiomReviewResizeFrames?: Array<{
        left: number
        right: number
        width: number
        bodyRight: number
        outlineRight: number
      }>
      __axiomReviewResizeObserver?: MutationObserver
    }
    state.__axiomReviewResizeObserver?.disconnect()
    return state.__axiomReviewResizeFrames ?? []
  })
  expect(westResizeFrames.length).toBeGreaterThan(2)
  for (let index = 1; index < westResizeFrames.length; index++) {
    expect(westResizeFrames[index].right).toBeCloseTo(westResizeFrames[0].right, 0)
    expect(westResizeFrames[index].width).toBeGreaterThanOrEqual(westResizeFrames[index - 1].width - 0.5)
    expect(westResizeFrames[index].left).toBeLessThanOrEqual(westResizeFrames[index - 1].left + 0.5)
    expect(westResizeFrames[index].outlineRight).toBeCloseTo(westResizeFrames[index].right, 0)
    expect(westResizeFrames[index].bodyRight).toBeCloseTo(westResizeFrames[index].right, 0)
  }
  expect(westResizeFrames.at(-1)!.width).toBeGreaterThan(westResizeFrames[0].width + 30)
  await page.mouse.up()
  await expect.poll(() => proposalLayoutSaves).toBe(4)
  await expect.poll(() => viewport.getAttribute('style')).toBe(cameraBefore)

  // Selecting a proposal file keeps that exact canvas node selected even
  // though the review panel follows the containing semantic branch.
  await draggedNode.click({ position: { x: 12, y: 12 }, force: true })
  await expect(draggedNode).toHaveClass(/selected/)
  await expect(resizedSystem).not.toHaveClass(/selected/)
  await expect(draggedNode.locator('[data-resize-direction="right"]')).toBeVisible()

  await nestedSystem.click({ position: { x: 12, y: 12 }, force: true })
  await expect(nestedSystem).toHaveClass(/selected/)
  const nestedWestHandle = nestedSystem.locator('[data-resize-direction="left"]')
  const nestedHandleBox = await nestedWestHandle.boundingBox()
  expect(nestedHandleBox).not.toBeNull()
  await nestedSystem.evaluate(element => {
    const state = window as typeof window & {
      __axiomReviewResizeFrames?: Array<{ left: number; right: number; width: number }>
      __axiomReviewResizeObserver?: MutationObserver
    }
    const sample = () => {
      const rect = element.getBoundingClientRect()
      state.__axiomReviewResizeFrames!.push({ left: rect.left, right: rect.right, width: rect.width })
    }
    state.__axiomReviewResizeFrames = []
    sample()
    state.__axiomReviewResizeObserver?.disconnect()
    state.__axiomReviewResizeObserver = new MutationObserver(sample)
    state.__axiomReviewResizeObserver.observe(element, {
      attributes: true,
      attributeFilter: ['style'],
    })
  })
  const nestedHandleCenter = {
    x: nestedHandleBox!.x + nestedHandleBox!.width / 2,
    y: nestedHandleBox!.y + nestedHandleBox!.height / 2,
  }
  await page.mouse.move(nestedHandleCenter.x, nestedHandleCenter.y)
  await page.mouse.down()
  for (let step = 1; step <= 12; step++) {
    await page.mouse.move(nestedHandleCenter.x - step * 2, nestedHandleCenter.y)
    await page.waitForTimeout(18)
  }
  const nestedWestFrames = await nestedSystem.evaluate(() => {
    const state = window as typeof window & {
      __axiomReviewResizeFrames?: Array<{ left: number; right: number; width: number }>
      __axiomReviewResizeObserver?: MutationObserver
    }
    state.__axiomReviewResizeObserver?.disconnect()
    return state.__axiomReviewResizeFrames ?? []
  })
  expect(nestedWestFrames.length).toBeGreaterThan(2)
  for (let index = 1; index < nestedWestFrames.length; index++) {
    expect(nestedWestFrames[index].right).toBeCloseTo(nestedWestFrames[0].right, 0)
    expect(nestedWestFrames[index].width).toBeGreaterThanOrEqual(nestedWestFrames[index - 1].width - 0.5)
    expect(nestedWestFrames[index].left).toBeLessThanOrEqual(nestedWestFrames[index - 1].left + 0.5)
  }
  await page.mouse.up()
  await expect.poll(() => proposalLayoutSaves).toBe(5)

  const beforePan = await viewport.getAttribute('style')
  await page.keyboard.down('d')
  await page.waitForTimeout(80)
  await page.keyboard.up('d')
  await expect.poll(() => viewport.getAttribute('style')).not.toBe(beforePan)
  await expect(page.locator('button button')).toHaveCount(0)

  // Review completion is the canonical commit, not a local navigation flag.
  // The exact daemon snapshot returned by finalization must be installed before
  // the live Floor mounts, including semantic nesting, memberships, and layout.
  await page.getByRole('button', { name: 'Done Reviewing' }).click()
  await expect.poll(() => proposalFinalizations).toBe(1)
  await expect(page.locator('.axiom-toolbar')).toBeVisible()
  const committed = await page.evaluate(() => {
    const state = (window as any).__axiomGraphStore.getState()
    return {
      systems: state.systems.map((system: any) => ({ id: system.id, name: system.name, parentId: system.parentId })),
      memberships: state.files
        .filter((file: any) => file.id === 'file_canvas' || file.id === 'file_layerzoom')
        .map((file: any) => ({ id: file.id, systemId: file.systemId })),
      layoutNodeIds: state.floorLayouts.map((layout: any) => layout.nodeId),
    }
  })
  expect(committed.systems).toEqual([
    { id: 'committed-canvas', name: 'Living Canvas', parentId: null },
    { id: 'committed-zoom', name: 'Semantic Zoom', parentId: 'committed-canvas' },
  ])
  expect(committed.memberships).toEqual([
    { id: 'file_canvas', systemId: 'committed-canvas' },
    { id: 'file_layerzoom', systemId: 'committed-zoom' },
  ])
  expect(committed.layoutNodeIds).toEqual(expect.arrayContaining([
    'committed-canvas',
    'committed-zoom',
    'file_canvas',
    'file_layerzoom',
  ]))
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

  expect(toolbarBox?.height).toBeCloseTo(82, 0)
  expect(railBox?.width).toBeCloseTo(176, 0)
  expect(statusBox?.height).toBeCloseTo(28, 0)

  const connection = status.locator('.axiom-status-bar__connection')
  const metrics = status.locator('.axiom-status-bar__metric')
  await expect(connection).toHaveAttribute('data-connection-state', 'connected')
  await expect(connection).toContainText('archd connected')
  await expect(metrics).toHaveCount(3)
  await expect(metrics.nth(0)).toContainText('6systems')
  await expect(metrics.nth(1)).toContainText('14files')
  await expect(metrics.nth(2)).toContainText('16dependencies')
  await expect(status).not.toContainText('Index clean')
  await expect(status).not.toContainText('Navigate')
  await expect(status).not.toContainText('The Floor')
  await expect.poll(() => status.evaluate(element => {
    const style = getComputedStyle(element)
    return { color: style.color, border: style.borderTopColor, background: style.backgroundImage }
  })).toEqual({
    color: 'rgb(195, 203, 200)',
    border: 'rgb(80, 91, 89)',
    background: 'linear-gradient(rgb(42, 52, 50), rgb(32, 40, 39))',
  })

  const lasso = page.getByRole('button', { name: 'Lasso Select' })
  await lasso.hover()
  await expect.poll(() => lasso.evaluate(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, color: style.color }
  })).toEqual({ background: 'rgb(238, 242, 236)', color: 'rgb(31, 57, 51)' })

  await lasso.click()
  const active = page.getByRole('button', { name: 'Lasso Active' })
  await expect.poll(() => active.evaluate(element => {
    const style = getComputedStyle(element)
    return { border: style.borderColor, color: style.color }
  })).toEqual({ border: 'rgb(52, 106, 98)', color: 'rgb(36, 93, 85)' })
})

test('searches the project index and navigates to a keyboard-selected file', async () => {
  await page.getByRole('button', { name: 'Search' }).click()

  const searchDialog = page.getByRole('dialog', { name: 'Search files' })
  const searchInput = searchDialog.getByRole('textbox', { name: 'Search project files' })
  const searchWindow = searchDialog
  await expect(searchDialog).toBeVisible()
  await expect(searchInput).toBeFocused()
  await expect(searchDialog).toContainText('Search the project index')

  await expect.poll(() => searchWindow.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      borderRadius: style.borderRadius,
      width: style.width,
    }
  })).toEqual({
    background: 'rgb(217, 215, 208)',
    borderRadius: '2px',
    width: '620px',
  })
  await expect.poll(() => searchInput.evaluate(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, color: style.color }
  })).toEqual({ background: 'rgb(255, 254, 248)', color: 'rgb(24, 37, 31)' })

  await searchInput.fill('not-a-real-indexed-path')
  await expect(searchDialog).toContainText('No matching files')

  await searchInput.fill('src/renderer')
  const results = searchDialog.getByRole('option')
  await expect(results).not.toHaveCount(0)
  await expect(results.first()).toHaveAttribute('aria-selected', 'true')
  await expect(results.first().locator('mark').first()).toHaveText('src/renderer')

  await searchInput.press('ArrowDown')
  await expect(results.nth(1)).toHaveAttribute('aria-selected', 'true')
  const resultId = await results.nth(1).getAttribute('id')
  expect(resultId).toBeTruthy()
  const fileId = resultId!.replace('axiom-search-result-', '')
  await searchInput.press('Enter')

  await expect(searchDialog).toHaveCount(0)
  const selectedNode = page.locator(`.react-flow__node[data-id="${fileId}"]`)
  await expect(selectedNode).toBeVisible()
  await expect(selectedNode).toHaveClass(/selected/)

  await page.keyboard.press('Control+K')
  await expect(page.getByRole('dialog', { name: 'Search files' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Search project files' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Search files' })).toHaveCount(0)
})

test('opens saved investigations and controls replay through the workbench transport', async () => {
  const trigger = page.getByRole('button', { name: 'Investigations' })
  await trigger.click()

  const menu = page.getByRole('menu', { name: 'Investigation captures' })
  const capture = menu.getByRole('menuitem', { name: /Checkout timeout/ })
  await expect(menu).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(capture).toBeVisible()
  await expect(capture).toContainText('2 events')
  await expect(capture).toContainText('fix/checkout@9fc31ab')

  const toolbarBox = await page.locator('.axiom-toolbar').boundingBox()
  const menuBox = await menu.boundingBox()
  expect(menuBox?.y).toBeGreaterThan(toolbarBox!.height - 12)
  expect(menuBox?.height).toBeGreaterThan(120)
  await expect.poll(() => menu.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      borderRadius: style.borderRadius,
      width: style.width,
    }
  })).toEqual({
    background: 'rgb(217, 215, 208)',
    borderRadius: '2px',
    width: '360px',
  })

  await capture.click()
  await expect(menu).toHaveCount(0)
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')

  const replay = page.getByRole('region', { name: 'Investigation replay: Checkout timeout' })
  const timeline = replay.getByRole('slider', { name: 'Investigation timeline' })
  await expect(replay).toBeVisible()
  await expect(replay).toContainText('fix/checkout@9fc31ab4')
  await expect(replay).toContainText('0/2')
  await expect(replay).toContainText('Ready to replay')
  await expect(timeline).toHaveValue('-1')
  await expect.poll(() => replay.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      borderRadius: style.borderRadius,
      width: style.width,
    }
  })).toEqual({
    background: 'rgb(217, 215, 208)',
    borderRadius: '2px',
    width: '680px',
  })

  await replay.getByRole('button', { name: 'Step' }).click()
  await expect(replay).toContainText('1/2')
  await expect(replay).toContainText('Checkout stalls after authorization')
  await expect(timeline).toHaveValue('0')

  await replay.getByRole('button', { name: 'Restart' }).click()
  await expect(replay).toContainText('0/2')
  await expect(timeline).toHaveValue('-1')

  const play = replay.getByRole('button', { name: 'Play', exact: true })
  await play.click()
  await expect(replay.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await replay.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(replay.getByRole('button', { name: 'Play', exact: true })).toBeVisible()

  await replay.getByRole('button', { name: 'Exit replay' }).click()
  await expect(replay).toHaveCount(0)

  await trigger.click()
  await expect(page.getByRole('menu', { name: 'Investigation captures' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: 'Investigation captures' })).toHaveCount(0)
})

test('keeps canvas utility chrome screen-sized, legible, and interactive', async () => {
  const tidy = page.getByRole('button', { name: 'Tidy Layout' })
  const controls = page.locator('.axiom-canvas-controls')
  const controlButtons = controls.locator('.react-flow__controls-button')
  const minimap = page.locator('.axiom-canvas-minimap')
  const zoom = page.locator('.axiom-zoom-indicator')

  await expect(tidy).toBeVisible()
  await expect(controls).toBeVisible()
  await expect(controlButtons).toHaveCount(3)
  await expect(minimap).toBeVisible()
  await expect(zoom).toBeVisible()

  const [minimapBox, zoomBox] = await Promise.all([minimap.boundingBox(), zoom.boundingBox()])
  expect(minimapBox?.width).toBeCloseTo(160, 0)
  expect(minimapBox?.height).toBeCloseTo(100, 0)
  expect(zoomBox?.height).toBeGreaterThanOrEqual(26)

  await expect.poll(() => tidy.evaluate(element => {
    const style = getComputedStyle(element)
    return { border: style.borderColor, color: style.color }
  })).toEqual({ border: 'rgb(115, 125, 120)', color: 'rgb(49, 94, 88)' })
  await expect.poll(() => minimap.evaluate(element => getComputedStyle(element).backgroundColor))
    .toBe('rgb(203, 201, 191)')

  const initialZoom = await zoom.getAttribute('aria-label')
  await controlButtons.first().click()
  await expect.poll(() => zoom.getAttribute('aria-label')).not.toBe(initialZoom)

  await tidy.click()
  await expect(page.locator('.layout-transition')).toHaveCount(0, { timeout: 5_000 })
  await expect(page.getByRole('button', { name: 'Tidy Layout' })).toBeEnabled()
})

test('preserves sheet rail hierarchy, layer visibility, and Floor navigation', async () => {
  const rail = page.getByRole('complementary', { name: 'Drawings' })
  const floor = rail.getByRole('button', { name: /The Floor/ })
  const runtime = rail.getByRole('button', { name: 'Runtime Draft STR', exact: true })
  const visibility = rail.getByRole('button', { name: 'Show Runtime Draft' })

  await expect(rail.getByText('Live model', { exact: true })).toBeVisible()
  await expect(rail.getByText('Overlay sheets', { exact: true })).toBeVisible()
  await expect(rail.getByText('STR', { exact: true })).toBeVisible()
  await expect(floor).toHaveAttribute('aria-current', 'page')
  await expect(visibility).toHaveAttribute('aria-pressed', 'false')

  await runtime.click()
  await expect(runtime).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.axiom-surface-readout')).toContainText('Runtime Draft')
  await expect(rail.getByRole('button', { name: 'Hide Runtime Draft' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.axiom-sheet-layer-indicator')).toContainText('Sheet Layer Active')
  await expect(page.locator('.axiom-sheet-palette')).toBeVisible()
  await expect(page.locator('.axiom-sheet-palette__item')).toHaveCount(6)

  await floor.click()
  await expect(floor).toHaveAttribute('aria-current', 'page')
  await expect(rail.getByRole('button', { name: 'Show Runtime Draft' })).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.axiom-sheet-layer-indicator')).toHaveCount(0)
  await expect(page.locator('.axiom-sheet-palette')).toHaveCount(0)
  await expect.poll(() => runtime.evaluate(element => {
    const style = getComputedStyle(element)
    return { color: style.color, background: style.backgroundColor }
  })).toEqual({ color: 'rgb(38, 51, 47)', background: 'rgb(231, 229, 223)' })

  const addSheet = rail.getByRole('button', { name: 'Create new overlay sheet' })
  await addSheet.click()
  const nameInput = rail.getByRole('textbox', { name: 'New sheet name' })
  await expect(nameInput).toBeVisible()
  await expect(nameInput).toBeFocused()
  await expect(nameInput).toHaveValue('New Sheet')
  await expect.poll(() => nameInput.evaluate(input => ({
    start: (input as HTMLInputElement).selectionStart,
    end: (input as HTMLInputElement).selectionEnd,
  }))).toEqual({ start: 0, end: 'New Sheet'.length })
  await expect.poll(() => nameInput.evaluate(element => {
    const style = getComputedStyle(element)
    return { color: style.color, background: style.backgroundColor }
  })).toEqual({ color: 'rgb(23, 36, 31)', background: 'rgb(255, 254, 248)' })
  await expect(addSheet).toHaveAttribute('aria-expanded', 'true')
  await nameInput.press('Escape')
  await expect(nameInput).toHaveCount(0)
  await expect(addSheet).toBeEnabled()
  await expect(addSheet).toHaveAttribute('aria-expanded', 'false')
})

test('uses the shared workbench dialog system without dropping form behavior', async () => {
  // Files begin behind collapsed semantic-zoom containers. Navigate to their
  // shared system through the product search path, then create a deliberate
  // multi-file selection without depending on overview DOM materialization.
  const canvasFile = await revealFileNode('file_canvas')
  const storeFile = await revealFileNode('file_store')
  await canvasFile.click()
  const storeBox = await storeFile.boundingBox()
  expect(storeBox).not.toBeNull()
  if (!storeBox) return
  const viewport = page.viewportSize()!
  const storePoint = {
    x: Math.max(1, Math.min(viewport.width - 1, storeBox.x + Math.min(20, storeBox.width / 2))),
    y: Math.max(1, Math.min(viewport.height - 1, storeBox.y + Math.min(20, storeBox.height / 2))),
  }
  await page.keyboard.down('Control')
  await page.mouse.click(storePoint.x, storePoint.y)
  await page.keyboard.up('Control')

  const selectionActions = page.locator('.axiom-selection-actions')
  await expect(selectionActions).toBeVisible()
  await expect(selectionActions.locator('.axiom-selection-actions__summary')).toContainText(/\d+\s*files selected/i)
  await expect.poll(() => selectionActions.evaluate(element => {
    const style = getComputedStyle(element)
    return { border: style.borderColor, radius: style.borderRadius }
  })).toEqual({ border: 'rgb(98, 109, 104)', radius: '2px' })

  const newSheetButton = page.getByRole('button', { name: 'New Sheet', exact: true })
  await expect(newSheetButton).toBeVisible()
  await newSheetButton.click()
  const backdrop = page.locator('.axiom-dialog-backdrop')
  const surface = page.getByRole('dialog', { name: 'New Sheet' })
  await expect(surface).toBeVisible()
  await expect(surface.getByRole('heading', { name: 'New Sheet' })).toBeVisible()
  await expect(surface.getByRole('textbox', { name: 'Sheet name' })).toBeFocused()
  await expect(surface.getByRole('textbox', { name: /Purpose/ })).toBeVisible()
  await expect(surface).toContainText(/Curating \d+ selected files/)

  const backdropColor = await backdrop.evaluate(element => getComputedStyle(element).backgroundColor)
  const surfaceBox = await surface.boundingBox()
  const surfaceStyle = await surface.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      padding: style.padding,
      borderRadius: style.borderRadius,
    }
  })
  const contentStyle = await surface.locator('.axiom-dialog-content').evaluate(element => {
    const style = getComputedStyle(element)
    return { color: style.color, padding: style.padding }
  })
  expect(backdropColor).toBe('rgba(18, 23, 21, 0.66)')
  expect(surfaceBox?.width).toBeCloseTo(420, 0)
  expect(surfaceStyle).toEqual({
    background: 'rgb(229, 227, 220)',
    padding: '0px',
    borderRadius: '2px',
  })
  expect(contentStyle).toEqual({ color: 'rgb(38, 51, 47)', padding: '18px' })

  await surface.getByRole('button', { name: 'Cancel' }).click()
  await expect(surface).toHaveCount(0)

  await selectionActions.getByRole('button', { name: 'Group into System' }).click()
  const systemDialog = page.getByRole('dialog', { name: 'New System' })
  await expect(systemDialog.getByRole('textbox', { name: 'System name' })).toBeFocused()
  await expect(systemDialog.getByRole('textbox', { name: /Description/ })).toBeVisible()
  await expect(systemDialog).toContainText(/Grouping \d+ selected files/)
  await systemDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(systemDialog).toHaveCount(0)

  await page.getByRole('button', { name: /Message agent/ }).click()
  const agentDialog = page.getByRole('dialog', { name: 'Message the Agent' })
  await expect(agentDialog.getByRole('textbox', { name: 'Message' })).toBeFocused()
  await expect(agentDialog).toContainText('through the Axiom MCP channel')
  await expect(agentDialog.getByRole('button', { name: 'Send to Agent' })).toBeDisabled()
  await agentDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(agentDialog).toHaveCount(0)
})

test('opens the categorized infrastructure browser from the toolbar', async () => {
  await page.getByRole('button', { name: 'Add infra' }).click()

  const picker = page.getByRole('dialog', { name: 'Choose infrastructure' })
  await expect(picker).toBeVisible()
  const catalogWindow = picker.locator('.axiom-infra-picker__window')
  const catalog = picker.locator('.axiom-infra-picker__catalog')
  const search = picker.getByRole('textbox', { name: 'Search infrastructure catalog' })
  await expect(search).toBeFocused()
  await expect(picker.getByRole('button', { name: 'Database', exact: true })).toBeVisible()
  await expect(picker.getByRole('button', { name: 'Infrastructure type' })).toHaveAttribute('aria-pressed', 'true')
  await expect(picker.getByRole('button', { name: 'Provider' })).toBeVisible()

  await expect.poll(() => catalogWindow.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      borderRadius: style.borderRadius,
      width: style.width,
    }
  })).toEqual({
    background: 'rgb(217, 215, 208)',
    borderRadius: '2px',
    width: '960px',
  })
  await expect.poll(() => catalog.evaluate(element => getComputedStyle(element).backgroundColor))
    .toBe('rgb(240, 238, 230)')
  await expect.poll(() => search.evaluate(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, color: style.color }
  })).toEqual({ background: 'rgb(255, 254, 248)', color: 'rgb(24, 37, 31)' })

  await search.fill('OpenAI')
  await expect(picker.getByRole('button', { name: /OpenAI API/ })).toBeVisible()
  await expect(picker.getByRole('button', { name: /Amazon RDS/ })).toHaveCount(0)
  await search.clear()

  await picker.getByRole('button', { name: 'Database', exact: true }).click()
  await expect(picker.getByRole('button', { name: /Amazon RDS/ })).toBeVisible()
  await expect(picker.getByRole('button', { name: /OpenAI API/ })).toHaveCount(0)

  await picker.getByRole('button', { name: 'Provider' }).click()
  await expect(picker.getByText('aws', { exact: true })).toBeVisible()
  const rdsService = picker.getByRole('button', { name: /Amazon RDS/ })
  await rdsService.click()
  await expect(rdsService).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => rdsService.evaluate(element => getComputedStyle(element).backgroundColor))
    .toBe('rgb(223, 234, 230)')
  await expect(picker.getByRole('textbox', { name: /Name/ })).toHaveAttribute('placeholder', /Primary Amazon RDS/)
  await expect(picker.getByRole('button', { name: 'Add to Canvas' })).toBeEnabled()

  await picker.getByRole('button', { name: 'Close infrastructure picker' }).click()
  await expect(picker).toHaveCount(0)
})

test('opens the workbench properties inspector without changing canvas selection behavior', async () => {
  const node = await revealFileNode('file_canvas')
  await node.dblclick({ position: { x: 12, y: 12 }, force: true })

  const inspector = page.getByRole('complementary', { name: 'File properties' })
  await expect(inspector).toBeVisible()
  await expect(inspector.getByRole('heading', { name: 'AxiomCanvas.tsx' })).toBeVisible()
  await expect(inspector.getByRole('heading', { name: 'General' })).toBeVisible()
  await expect(inspector).toContainText('Language')
  await expect(inspector).toContainText('420')
  await expect(node).toHaveClass(/selected/)

  await expect.poll(() => inspector.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      width: style.width,
      background: style.backgroundColor,
      color: style.color,
    }
  })).toEqual({
    width: '286px',
    background: 'rgb(229, 227, 220)',
    color: 'rgb(38, 51, 47)',
  })

  await inspector.getByRole('button', { name: 'Close properties' }).click()
  await expect(inspector).toHaveCount(0)
  await expect(node).toHaveClass(/selected/)
})

test('opens source symbols in the workbench code preview without losing syntax context', async () => {
  const node = await revealFileNode('file_canvas')
  const box = await node.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 15; i += 1) {
    await page.mouse.wheel(0, -100)
  }

  const symbol = node.getByTitle('Open renderCanvas in source')
  await expect(symbol).toBeVisible()
  await symbol.click()

  const preview = page.getByRole('dialog', { name: /renderCanvas in src\/renderer\/canvas\/AxiomCanvas\.tsx/ })
  const code = preview.locator('.source-preview-code')
  await expect(preview).toBeVisible()
  await expect(preview.getByText('function renderCanvas · lines 3–6')).toBeVisible()
  await expect(preview.getByRole('button', { name: 'Close source preview' })).toBeFocused()
  await expect(code).toContainText('const ready = true')
  await expect(code.locator('.source-preview-line-highlighted')).toHaveCount(4)

  await expect.poll(() => preview.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      borderRadius: style.borderRadius,
      height: style.height,
      width: style.width,
    }
  })).toEqual({
    background: 'rgb(217, 215, 208)',
    borderRadius: '2px',
    height: '820px',
    width: '1100px',
  })
  await expect.poll(() => code.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      border: style.borderColor,
      margin: style.margin,
    }
  })).toEqual({ border: 'rgb(77, 89, 85)', margin: '6px' })

  await page.keyboard.press('Escape')
  await expect(preview).toHaveCount(0)
  await expect(node).toBeVisible()
})

test('keeps resize chrome screen-sized and attached while resizing', async () => {
  const node = await revealFileNode('file_canvas')
  await node.click({ position: { x: 12, y: 12 }, force: true })
  await expect(node).toHaveClass(/selected/)

  const handles = await expectResizeChrome('file_canvas')

  const initialNode = await node.boundingBox()
  expect(initialNode).not.toBeNull()

  const right = page.locator('[data-resize-direction="right"]')
  const anchor = await right.boundingBox()
  expect(anchor).not.toBeNull()
  if (!anchor || !initialNode) return

  await page.mouse.move(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2)
  await page.mouse.down()
  await page.mouse.move(anchor.x + anchor.width / 2 + 36, anchor.y + anchor.height / 2, { steps: 12 })
  await page.mouse.up()

  const resizedNode = await node.boundingBox()
  expect(resizedNode).not.toBeNull()
  expect(resizedNode!.x).toBeCloseTo(initialNode.x, 0)
  expect(resizedNode!.y).toBeCloseTo(initialNode.y, 0)
  expect(resizedNode!.width).toBeGreaterThan(initialNode.width + 25)
  expect(resizedNode!.height).toBeCloseTo(initialNode.height, 0)
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
  await page.mouse.move(
    targetBox.x + targetBox.width - 20,
    targetBox.y + targetBox.height - 20,
    { steps: 16 },
  )
  await page.mouse.up()

  await expect.poll(() => persistedParent).toBe('sys_canvas')
})

test('wheel zoom continues over revealed file content through 100x', async () => {
  const node = await revealFileNode('file_canvas')
  await node.click({ position: { x: 12, y: 12 }, force: true })
  await expect(node).toHaveClass(/selected/)
  const box = await node.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 50; i += 1) {
    await page.mouse.wheel(0, -100)
  }

  await expect(page.locator('.axiom-zoom-indicator')).toHaveAttribute('aria-label', 'Zoom 100.00x', { timeout: 15_000 })
  await expect(node).toBeVisible()
  await expectResizeChrome('file_canvas')

  // Selection mode is an interaction policy only. Toggling it must not
  // rebuild semantic-zoom visibility or permanently remove the current frame.
  const nodeCount = await page.locator('.react-flow__node').count()
  const beforeToggle = await node.boundingBox()
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await page.getByRole('button', { name: 'Lasso Select' }).click()
    await expect(page.getByRole('button', { name: 'Lasso Active' })).toBeVisible()
    await page.getByRole('button', { name: 'Lasso Active' }).click()
    await expect(page.getByRole('button', { name: 'Lasso Select' })).toBeVisible()
  }
  await expect(page.locator('.react-flow__node')).toHaveCount(nodeCount)
  await expect(node).toBeVisible()
  await expect(node).toHaveCSS('pointer-events', 'all')
  const afterToggle = await node.boundingBox()
  expect(afterToggle?.x).toBeCloseTo(beforeToggle!.x, 1)
  expect(afterToggle?.y).toBeCloseTo(beforeToggle!.y, 1)
  expect(afterToggle?.width).toBeCloseTo(beforeToggle!.width, 1)
  expect(afterToggle?.height).toBeCloseTo(beforeToggle!.height, 1)
  await expectResizeChrome('file_canvas')
})
