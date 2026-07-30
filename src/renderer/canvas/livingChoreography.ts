import type { LivingRelationshipChange } from '../../shared/types.ts'
import type { NodeFx } from './sceneTypes.ts'

export function editNodeFxKind(
  exists: boolean,
  animate: boolean,
): NodeFx['kind'] | null {
  if (!exists) return 'enter'
  return animate ? 'edit' : null
}

export function relationshipVisual(
  event: Pick<LivingRelationshipChange, 'change'>,
): { color: string; targetKind: NodeFx['kind'] } {
  if (event.change === 'added') {
    return { color: '#2fa35d', targetKind: 'flow-add' }
  }
  if (event.change === 'removed') {
    return { color: '#b6534b', targetKind: 'flow-remove' }
  }
  return {
    color: '#3c8f92',
    targetKind: 'flow-update',
  }
}

/**
 * Relationship storage remains semantic (caller -> callee), while living
 * choreography is causal (edited file -> affected file). Legacy events and
 * rare graph-wide resolution changes whose origin is not an endpoint retain
 * their semantic direction.
 */
export function livingFlowEndpoints(
  event: Pick<LivingRelationshipChange, 'src' | 'dst' | 'originId'>,
): { source: string; target: string } {
  if (event.originId === event.dst) {
    return { source: event.dst, target: event.src }
  }
  return { source: event.src, target: event.dst }
}
