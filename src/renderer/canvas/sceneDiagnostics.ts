import type { Node } from '@xyflow/react'

/**
 * Scene-mutation tracing for the "nodes teleport for a frame during zoom" bug.
 *
 * The living-flow log answers "what did the backend send". This answers the
 * different question "who moved the scene, and when". Every controlled scene
 * update stamps a source label, and this diffs consecutive scenes so a frame
 * where geometry jumps can be attributed to the code path that caused it
 * instead of being reconstructed from a screenshot.
 */
export interface SceneNodeGeometry {
  id: string
  x: number
  y: number
  width: number
  height: number
  parentId: string | null
}

export interface SceneMove {
  id: string
  from: { x: number; y: number }
  to: { x: number; y: number }
  dx: number
  dy: number
}

export interface SceneResize {
  id: string
  from: { width: number; height: number }
  to: { width: number; height: number }
}

export interface SceneReparent {
  id: string
  from: string | null
  to: string | null
}

export interface SceneDelta {
  moved: SceneMove[]
  resized: SceneResize[]
  reparented: SceneReparent[]
  added: string[]
  removed: string[]
  largestMove: number
}

export interface SceneMutationRecord extends SceneDelta {
  at: number
  source: string
  zoom: number
  nodeCount: number
  dragging: string | null
}

type SceneDiagnosticGlobal = typeof globalThis & {
  __axiomSceneLog?: SceneMutationRecord[]
}

const MAX_RECORDS = 300
// Flow-unit movement above this, with no drag in flight, is a teleport rather
// than a layout nudge and is worth surfacing on the console immediately.
const TELEPORT_FLOW_UNITS = 40

export function sceneGeometry(nodes: readonly Node[]): SceneNodeGeometry[] {
  return nodes.map(node => ({
    id: node.id,
    x: node.position?.x ?? 0,
    y: node.position?.y ?? 0,
    width: Number(node.style?.width ?? node.measured?.width ?? 0),
    height: Number(node.style?.height ?? node.measured?.height ?? 0),
    parentId: node.parentId ?? null,
  }))
}

export function diffScene(
  previous: readonly SceneNodeGeometry[],
  next: readonly SceneNodeGeometry[],
): SceneDelta {
  const before = new Map(previous.map(node => [node.id, node]))
  const after = new Map(next.map(node => [node.id, node]))
  const moved: SceneMove[] = []
  const resized: SceneResize[] = []
  const reparented: SceneReparent[] = []
  let largestMove = 0

  for (const node of next) {
    const prior = before.get(node.id)
    if (!prior) continue
    const dx = node.x - prior.x
    const dy = node.y - prior.y
    if (dx !== 0 || dy !== 0) {
      moved.push({
        id: node.id,
        from: { x: prior.x, y: prior.y },
        to: { x: node.x, y: node.y },
        dx,
        dy,
      })
      largestMove = Math.max(largestMove, Math.abs(dx), Math.abs(dy))
    }
    if (node.width !== prior.width || node.height !== prior.height) {
      resized.push({
        id: node.id,
        from: { width: prior.width, height: prior.height },
        to: { width: node.width, height: node.height },
      })
    }
    if (node.parentId !== prior.parentId) {
      reparented.push({ id: node.id, from: prior.parentId, to: node.parentId })
    }
  }

  return {
    moved,
    resized,
    reparented,
    added: next.filter(node => !before.has(node.id)).map(node => node.id),
    removed: previous.filter(node => !after.has(node.id)).map(node => node.id),
    largestMove,
  }
}

export function sceneDeltaIsQuiet(delta: SceneDelta): boolean {
  return delta.moved.length === 0 &&
    delta.resized.length === 0 &&
    delta.reparented.length === 0 &&
    delta.added.length === 0 &&
    delta.removed.length === 0
}

export function recordSceneMutation(
  record: SceneMutationRecord,
): SceneMutationRecord {
  const owner = globalThis as SceneDiagnosticGlobal
  const log = owner.__axiomSceneLog ?? []
  log.push(record)
  if (log.length > MAX_RECORDS) log.splice(0, log.length - MAX_RECORDS)
  owner.__axiomSceneLog = log

  // A repack moves several nodes by design; recording it is useful, warning
  // about it is noise that would bury a real fault later.
  const expectedBulkMove = record.source.endsWith('-repack') ||
    record.source.startsWith('layout-')
  if (!record.dragging && !expectedBulkMove && record.largestMove >= TELEPORT_FLOW_UNITS) {
    console.warn(
      `[scene-move] source=${record.source} zoom=${record.zoom.toFixed(3)} ` +
      `largestMove=${record.largestMove.toFixed(1)} moved=${record.moved.length} ` +
      `resized=${record.resized.length} reparented=${record.reparented.length} ` +
      `added=${record.added.length} removed=${record.removed.length}`,
      record.moved.slice(0, 6),
    )
  }
  return record
}
