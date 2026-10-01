export function canvasReference(type: string, id: string, label: string): string {
  return `axiom://${type}/${encodeURIComponent(id)}?label=${encodeURIComponent(label)}`
}
export { workOrderHandoff } from '../../shared/workOrderHandoff.ts'
export function referenceTarget(reference: string): { id: string; label: string } {
  try {
    const url = new URL(reference)
    const id = decodeURIComponent(url.pathname.slice(1))
    return { id: url.host === 'planned' ? `planned:${id}` : id, label: url.searchParams.get('label') || id || reference }
  } catch { return { id: '', label: reference } }
}
export function messageReferences(selection: string): string[] {
  try { const refs = JSON.parse(selection); return Array.isArray(refs) ? refs.filter(ref => typeof ref === 'string') : [] } catch { return [] }
}
export function inboxStatus(message: { status: string; agent?: string; deliveredTo?: string | null; leaseExpiresAt?: number; review?: { decision: string } }, now = Date.now()): string {
  if (message.status === 'answered') return message.review?.decision === 'accepted' ? 'Accepted' : 'Ready for review'
  if (message.status === 'cancelled') return 'Cancelled'
  if (message.status === 'delivered' && (message.leaseExpiresAt ?? 0) > now) return `Picked up by ${message.agent || 'agent'}${message.deliveredTo ? ` · connector ${message.deliveredTo.slice(0, 8)}` : ''}`
  if (message.review?.decision === 'reopened') return 'Changes requested · waiting for agent'
  return message.leaseExpiresAt ? 'Available again · previous claim expired' : 'Waiting for an agent'
}
