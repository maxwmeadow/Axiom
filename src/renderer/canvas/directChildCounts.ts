export interface ParentDescriptor {
  parentId: string | null
}

/** Counts each direct child descriptor once, independent of its node type. */
export function countDirectChildren(descriptors: readonly ParentDescriptor[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const descriptor of descriptors) {
    if (descriptor.parentId) {
      counts.set(descriptor.parentId, (counts.get(descriptor.parentId) ?? 0) + 1)
    }
  }
  return counts
}
