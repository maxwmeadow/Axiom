import { isCanvasSourceFile, isDocumentationFile } from '../../shared/fileKinds.ts'
import type { DbFile } from '../../shared/types.ts'

/**
 * Which files belong on the canvas, and which belong in a bin.
 *
 * Three populations, and the distinction between the last two is the whole
 * point. A *document* is not architecture and never was - Axiom holds it so you
 * can read it, not so you can place it. An *unclassified* file is architecture
 * that nobody has placed yet: it belongs on the map, and the bin is a holding
 * pen it should eventually leave.
 *
 * Collapsing those two into one "not on the canvas" set is what made
 * documentation invisible. A file that is merely unplaced looked identical to
 * one that was deliberately excluded, so there was nowhere honest to put either.
 *
 * The Floor and the proposal review disagree about what "has a home" means -
 * one reads `system_id`, the other reads proposal membership - so that question
 * is the caller's, passed in as a predicate. Everything else about the
 * partition is identical on both surfaces, which is why it lives here once.
 */

export interface BinPartition {
  /** Rendered on the canvas as normal. */
  placed: DbFile[]
  /** Source files with no home yet: the unclassified bin. */
  unclassified: DbFile[]
  /** Readable documentation: the documents bin. */
  documents: DbFile[]
}

export interface PartitionOptions {
  /**
   * Whether this file already belongs somewhere on the canvas. Live Floor:
   * `file => !!file.systemId`. Proposal review: membership in the proposal.
   */
  hasHome: (file: DbFile) => boolean
}

export function partitionCanvasFiles(
  files: readonly DbFile[],
  { hasHome }: PartitionOptions,
): BinPartition {
  const placed: DbFile[] = []
  const unclassified: DbFile[] = []
  const documents: DbFile[] = []

  for (const file of files) {
    // Documentation is checked first and unconditionally. A README that a
    // classifier once attached to a system is still a README; letting a stale
    // `system_id` promote it back onto the map is how docs leaked onto the
    // Floor before there was anywhere else for them to go.
    if (isDocumentationFile(file)) {
      documents.push(file)
      continue
    }
    // Anything that is neither documentation nor indexable source is not
    // something the canvas can draw or the user can classify. It is dropped
    // rather than binned, so a bin never fills with things you cannot act on.
    if (!isCanvasSourceFile(file)) continue
    if (hasHome(file)) placed.push(file)
    else unclassified.push(file)
  }

  return { placed, unclassified, documents }
}

/** Stable display order for a bin: folder first, then filename. */
export function sortForBin(files: readonly DbFile[]): DbFile[] {
  return [...files].sort((left, right) => left.relPath.localeCompare(right.relPath))
}
