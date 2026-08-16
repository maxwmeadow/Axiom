import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import { raiseInvitation, resolveInterruption } from '../store/interruptionStore.ts'

/**
 * "Indexing finished and found nothing."
 *
 * The blankest dead end in the app: a project whose source boundaries exclude
 * everything indexes cleanly, reports success, and lands you on an empty Floor
 * with no nodes, no stencil palette (the Floor hides it), and nothing at all to
 * click. Nothing is broken, so nothing says anything - which is exactly why it
 * used to be unrecoverable without deleting the project and starting over.
 *
 * The recovery is the boundary picker, so the invitation carries a way back to
 * it rather than only naming the problem.
 */

const ID = 'empty-index'

/** Indexing settles asynchronously; only claim emptiness once it has held. */
const SETTLE_MS = 3000

interface EmptyIndexNoticeProps {
  onReconfigure: () => void
  /**
   * Whether this project actually excludes anything. An empty graph has
   * several causes and only one of them is misconfiguration.
   */
  hasExclusions: boolean
  /**
   * A project the user just created is *supposed* to be empty - that is the
   * whole point of the New Project flow, which opens a fresh folder so files
   * can materialize into it later. Telling them it is broken is nonsense.
   */
  suppress: boolean
}

export function EmptyIndexNotice({
  onReconfigure, hasExclusions, suppress,
}: EmptyIndexNoticeProps) {
  const { empty, isIndexing, connected, workspaceId } = useGraphStore(useShallow(state => ({
    empty: state.files.length === 0 &&
      state.systems.length === 0 &&
      state.infraNodes.length === 0,
    isIndexing: state.isIndexing,
    connected: state.connectionStatus === 'connected',
    workspaceId: state.currentProject?.id ?? '',
  })))

  useEffect(() => {
    if (suppress || !workspaceId || isIndexing || !connected || !empty) {
      // Anything at all showed up, or work is still in flight. Retire the
      // claim rather than leaving a contradicted message on screen.
      resolveInterruption(ID)
      return
    }
    const timer = setTimeout(() => {
      // State the observation, and name a cause only when one is actually
      // established. An empty graph can equally mean the repository holds no
      // language Axiom can parse, or that indexing failed - asserting
      // "everything is excluded" when nothing is excluded is just wrong.
      raiseInvitation(
        ID,
        'Indexing finished without finding any source files',
        hasExclusions
          ? 'Some folders are excluded from this project. Check whether the ones holding your code are among them.'
          : 'Nothing here is excluded, so this may be a repository with no language Axiom can parse yet.',
        [{
          label: 'Choose folders',
          primary: true,
          run: () => {
            resolveInterruption(ID)
            onReconfigure()
          },
        }],
      )
    }, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [empty, isIndexing, connected, workspaceId, onReconfigure, hasExclusions, suppress])

  return null
}
