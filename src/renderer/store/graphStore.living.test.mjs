import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LIVING_FILE_DELETE_MS,
  LIVING_FLOW_ARRIVAL_FRACTION,
  LIVING_FLOW_LEAD_IN_MS,
  LIVING_FLOW_STAGGER_MS,
  LIVING_FLOW_TRAVEL_MS,
  useGraphStore,
} from './graphStore.ts'

function resetLivingState() {
  globalThis.__axiomLivingFlowLog = []
  useGraphStore.setState({
    files: [{ id: 'file-b' }],
    dependencies: [],
    floorLayouts: [],
    nodeFx: {},
    relationshipFx: [],
    pendingFileDeletions: {},
    selectedNodeId: null,
    inspectedNodeId: null,
  })
}

test('relationship activity cannot cancel a committed file deletion', () => {
  resetLivingState()
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = () => 0
  try {
    useGraphStore.getState().applyDbPatch({
      type: 'file:deleted',
      payload: { id: 'file-b', relPath: 'file-b.ts' },
    })
    const deletionKey = useGraphStore.getState().pendingFileDeletions['file-b']
    assert.ok(deletionKey)
    assert.equal(useGraphStore.getState().nodeFx['file-b'].kind, 'exit')

    useGraphStore.getState().applyDbPatch({
      type: 'relationship:changed',
      payload: {
        src: 'file-a',
        dst: 'file-b',
        relationship: 'CALLS',
        change: 'removed',
        animate: true,
      },
    })

    assert.equal(useGraphStore.getState().nodeFx['file-b'].kind, 'exit')
    assert.equal(useGraphStore.getState().pendingFileDeletions['file-b'], deletionKey)
    useGraphStore.getState().finalizeFileDeletion('file-b', deletionKey)
    assert.equal(useGraphStore.getState().files.some(file => file.id === 'file-b'), false)
    assert.equal(useGraphStore.getState().pendingFileDeletions['file-b'], undefined)
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})

test('a dying file outlives every fuse flow it sends out', () => {
  resetLivingState()
  const originalSetTimeout = globalThis.setTimeout
  const scheduled = []
  globalThis.setTimeout = (fn, ms) => { scheduled.push(ms); return 0 }
  try {
    useGraphStore.getState().applyDbPatch({
      type: 'file:deleted',
      payload: { id: 'file-b', relPath: 'file-b.ts', traceId: 'L1' },
    })
    // archd broadcasts the severed relationships before the tombstone, so the
    // node must stay mounted until the last staggered fuse has landed.
    const removalDelay = Math.max(...scheduled)
    assert.equal(removalDelay, LIVING_FILE_DELETE_MS)
    assert.ok(
      removalDelay > LIVING_FLOW_TRAVEL_MS + LIVING_FLOW_STAGGER_MS * 2,
      'the file cannot vanish while its own severance flows are still in flight',
    )
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})

test('a newly created file materializes instead of popping in', () => {
  resetLivingState()
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = () => 0
  try {
    useGraphStore.getState().applyDbPatch({
      type: 'file:updated',
      payload: {
        file: { id: 'file-new', relPath: 'services/new_thing.py' },
        change: 'created',
        animate: true,
        traceId: 'L2',
      },
    })
    const state = useGraphStore.getState()
    assert.ok(state.files.some(file => file.id === 'file-new'))
    // 'enter' is what drives the green materialize, the creation ring, and the
    // CREATED pop-out card. An existing file would resolve to 'edit'.
    assert.equal(state.nodeFx['file-new'].kind, 'enter')
    assert.equal(state.nodeFx['file-new'].traceId, 'L2')
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})

test('living flow delay is immutable after earlier events expire', () => {
  resetLivingState()
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = () => 0
  try {
    const addFlow = (src, dst) => useGraphStore.getState().applyDbPatch({
      type: 'relationship:changed',
      payload: {
        src,
        dst,
        relationship: 'CALLS',
        change: 'updated',
        animate: true,
      },
    })
    addFlow('file-a', 'file-b')
    addFlow('file-c', 'file-b')
    const [first, second] = useGraphStore.getState().relationshipFx
    assert.equal(first.delayMs, LIVING_FLOW_LEAD_IN_MS)
    assert.equal(second.delayMs, LIVING_FLOW_LEAD_IN_MS + LIVING_FLOW_STAGGER_MS)

    useGraphStore.getState().clearRelationshipFx(first.key)
    assert.equal(useGraphStore.getState().relationshipFx[0].key, second.key)
    assert.equal(
      useGraphStore.getState().relationshipFx[0].delayMs,
      LIVING_FLOW_LEAD_IN_MS + LIVING_FLOW_STAGGER_MS,
    )
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})

test('one backend burst coalesces coincident symbol flows between the same files', () => {
  resetLivingState()
  const originalSetTimeout = globalThis.setTimeout
  const originalNow = Date.now
  globalThis.setTimeout = () => 0
  Date.now = () => 1000
  try {
    const addFlow = (callerSymbol, calleeSymbol) => useGraphStore.getState().applyDbPatch({
      type: 'relationship:changed',
      payload: {
        src: 'file-a',
        dst: 'file-b',
        relationship: 'CALLS',
        change: 'updated',
        callerSymbol,
        calleeSymbol,
        animate: true,
      },
    })
    addFlow('first', 'read')
    addFlow('second', 'write')

    assert.equal(useGraphStore.getState().relationshipFx.length, 1)
    assert.equal(useGraphStore.getState().relationshipFx[0].eventCount, 2)

    Date.now = () => 1200
    addFlow('third', 'flush')
    assert.equal(useGraphStore.getState().relationshipFx.length, 2)
  } finally {
    Date.now = originalNow
    globalThis.setTimeout = originalSetTimeout
  }
})

test('one save trace produces one visual route across relationship kinds', () => {
  resetLivingState()
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = () => 0
  try {
    const addFlow = (relationship, change) => useGraphStore.getState().applyDbPatch({
      type: 'relationship:changed',
      payload: {
        src: 'file-a',
        dst: 'file-b',
        originId: 'file-a',
        relationship,
        change,
        animate: true,
        traceId: 'save-42',
      },
    })

    addFlow('IMPORTS', 'added')
    addFlow('CALLS', 'updated')

    const events = useGraphStore.getState().relationshipFx
    assert.equal(events.length, 1)
    assert.equal(events[0].relationship, 'CALLS')
    assert.equal(events[0].change, 'updated')
    assert.equal(events[0].eventCount, 2)
    assert.equal(events[0].delayMs, LIVING_FLOW_LEAD_IN_MS)

    const diagnostics = globalThis.__axiomLivingFlowLog
      .filter(entry => entry.traceId === 'save-42')
    assert.deepEqual(
      diagnostics.map(entry => entry.stage),
      [
        'renderer-intake',
        'renderer-scheduled',
        'renderer-intake',
        'renderer-coalesced',
      ],
    )
    assert.equal(
      diagnostics.filter(entry => entry.stage === 'renderer-scheduled').length,
      1,
    )
    assert.equal(diagnostics.at(-1).eventCount, 2)
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})

test('staggering is scoped to one save trace instead of older active flows', () => {
  resetLivingState()
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = () => 0
  try {
    const addFlow = (src, dst, traceId) => useGraphStore.getState().applyDbPatch({
      type: 'relationship:changed',
      payload: {
        src,
        dst,
        relationship: 'CALLS',
        change: 'updated',
        animate: true,
        traceId,
      },
    })

    addFlow('file-a', 'file-b', 'save-1')
    addFlow('file-c', 'file-b', 'save-1')
    addFlow('file-d', 'file-b', 'save-2')

    const [first, second, nextSave] = useGraphStore.getState().relationshipFx
    assert.equal(first.delayMs, LIVING_FLOW_LEAD_IN_MS)
    assert.equal(second.delayMs, LIVING_FLOW_LEAD_IN_MS + LIVING_FLOW_STAGGER_MS)
    assert.equal(nextSave.delayMs, LIVING_FLOW_LEAD_IN_MS)
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})

test('a callee edit flows outward and impacts the other file instead of replaying itself', () => {
  resetLivingState()
  const originalSetTimeout = globalThis.setTimeout
  const timers = []
  globalThis.setTimeout = (callback, delay) => {
    timers.push({ callback, delay })
    return timers.length
  }
  try {
    useGraphStore.getState().applyDbPatch({
      type: 'relationship:changed',
      payload: {
        src: 'caller-file',
        dst: 'edited-callee',
        originId: 'edited-callee',
        relationship: 'CALLS',
        change: 'updated',
        animate: true,
        traceId: 'test-origin',
      },
    })

    const arrival = timers.find(timer =>
      timer.delay === LIVING_FLOW_LEAD_IN_MS +
        LIVING_FLOW_TRAVEL_MS * LIVING_FLOW_ARRIVAL_FRACTION
    )
    assert.ok(arrival, 'arrival timer should include the edit lead-in')
    arrival.callback()
    assert.equal(useGraphStore.getState().nodeFx['caller-file'].kind, 'flow-update')
    assert.equal(useGraphStore.getState().nodeFx['edited-callee'], undefined)
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})
