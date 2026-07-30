import assert from 'node:assert/strict'
import test from 'node:test'
import {
  absoluteLivingNodeRect,
  chooseClosestLivingBoundaryAnchors,
  chooseLivingAnchorPair,
  livingAnchorPoint,
  livingPulseGeometry,
} from './livingEdgeGeometry.ts'

const rect = (x, y, width = 100, height = 80) => ({ x, y, width, height })

test('living anchors use opposing nearest horizontal faces in both directions', () => {
  assert.deepEqual(chooseLivingAnchorPair(rect(0, 0), rect(300, 0)), {
    sourceSide: 'right',
    targetSide: 'left',
    sourceHandle: 'source-right',
    targetHandle: 'target-left',
  })
  assert.deepEqual(chooseLivingAnchorPair(rect(300, 0), rect(0, 0)), {
    sourceSide: 'left',
    targetSide: 'right',
    sourceHandle: 'source-left',
    targetHandle: 'target-right',
  })
})

test('living anchors use opposing nearest vertical faces in both directions', () => {
  assert.deepEqual(chooseLivingAnchorPair(rect(0, 0), rect(0, 300)), {
    sourceSide: 'bottom',
    targetSide: 'top',
    sourceHandle: 'source-bottom',
    targetHandle: 'target-top',
  })
  assert.deepEqual(chooseLivingAnchorPair(rect(0, 300), rect(0, 0)), {
    sourceSide: 'top',
    targetSide: 'bottom',
    sourceHandle: 'source-top',
    targetHandle: 'target-bottom',
  })
})

test('living geometry resolves nested world positions without renderer measurements', () => {
  const nodes = [
    { id: 'root', position: { x: 300, y: 100 }, style: { width: 600, height: 500 } },
    { id: 'nested', parentId: 'root', position: { x: 40, y: 70 }, style: { width: 220, height: 110 } },
    {
      id: 'file',
      parentId: 'nested',
      position: { x: 12, y: 18 },
      measured: { width: 0, height: 0 },
      style: { width: 88, height: 44 },
    },
  ]

  assert.deepEqual(absoluteLivingNodeRect('file', nodes), {
    x: 352,
    y: 188,
    width: 88,
    height: 44,
  })
})

test('living anchor points land on the exact selected face', () => {
  const target = rect(20, 40, 100, 80)
  assert.deepEqual(livingAnchorPoint(target, 'top'), { x: 70, y: 40 })
  assert.deepEqual(livingAnchorPoint(target, 'right'), { x: 120, y: 80 })
  assert.deepEqual(livingAnchorPoint(target, 'bottom'), { x: 70, y: 120 })
  assert.deepEqual(livingAnchorPoint(target, 'left'), { x: 20, y: 80 })
})

test('living flows stop at the nearest overlapping span of offset nodes', () => {
  assert.deepEqual(
    chooseClosestLivingBoundaryAnchors(
      rect(0, 0, 100, 100),
      rect(220, 40, 100, 100),
    ),
    {
      sourceSide: 'right',
      targetSide: 'left',
      sourceHandle: 'source-right',
      targetHandle: 'target-left',
      source: { x: 100, y: 70 },
      target: { x: 220, y: 70 },
    },
  )
})

test('living flows use the nearest corners for diagonal nodes', () => {
  assert.deepEqual(
    chooseClosestLivingBoundaryAnchors(
      rect(0, 0, 100, 80),
      rect(220, 180, 100, 80),
    ),
    {
      sourceSide: 'right',
      targetSide: 'left',
      sourceHandle: 'source-right',
      targetHandle: 'target-left',
      source: { x: 100, y: 80 },
      target: { x: 220, y: 180 },
    },
  )
})

test('closest living anchors never land inside either node', () => {
  const source = rect(300, 100, 160, 120)
  const target = rect(20, 130, 100, 60)
  const anchors = chooseClosestLivingBoundaryAnchors(source, target)

  assert.equal(anchors.source.x, source.x)
  assert.equal(anchors.target.x, target.x + target.width)
  assert.equal(anchors.source.y, 160)
  assert.equal(anchors.target.y, 160)
})

test('living pulse length adapts to short and long screen routes', () => {
  const short = livingPulseGeometry({ x: 0, y: 0 }, { x: 80, y: 0 }, 1)
  const medium = livingPulseGeometry({ x: 0, y: 0 }, { x: 300, y: 0 }, 1)
  const long = livingPulseGeometry({ x: 0, y: 0 }, { x: 1000, y: 0 }, 1)
  const zoomedOut = livingPulseGeometry({ x: 0, y: 0 }, { x: 1000, y: 0 }, 0.2)

  assert.equal(short.headFraction, 0.42)
  assert.equal(medium.headFraction, 0.22)
  assert.equal(long.headFraction, 0.1)
  assert.equal(zoomedOut.headFraction, 0.22)
})

test('a travelling pulse never tiles a second dash onto the same route', () => {
  // The stroke is pathLength=1, so only [0, 1] is painted. The dash pattern
  // repeats every `head + tail`, placing a copy of the pulse at every
  // multiple of that period. Sweeping the real animation proves no copy other
  // than the travelling one is ever visible, at any route length or zoom.
  for (const [dx, zoom] of [[80, 1], [300, 1], [1000, 1], [1000, 0.2], [40, 2.5]]) {
    const pulse = livingPulseGeometry({ x: 0, y: 0 }, { x: dx, y: 0 }, zoom)
    const period = pulse.headFraction + pulse.tailFraction
    assert.ok(
      period > 1 + pulse.headFraction,
      `period ${period} must exceed the route plus one head`,
    )

    for (let step = 0; step <= 200; step += 1) {
      const offset = pulse.dashStart +
        (pulse.dashEnd - pulse.dashStart) * (step / 200)
      const onPath = []
      for (let tile = -2; tile <= 3; tile += 1) {
        const start = tile * period - offset
        if (start + pulse.headFraction > 0 && start < 1) onPath.push(start)
      }
      assert.ok(
        onPath.length <= 1,
        `offset ${offset} painted ${onPath.length} dashes at ${onPath}`,
      )
    }
  }

  // The travelling dash must still fully clear both ends of the route.
  const pulse = livingPulseGeometry({ x: 0, y: 0 }, { x: 300, y: 0 }, 1)
  const period = pulse.headFraction + pulse.tailFraction
  assert.ok(Math.abs((period - pulse.dashStart) + pulse.headFraction) < 1e-9)
  assert.ok(Math.abs((period - pulse.dashEnd) - 1) < 1e-9)
})
