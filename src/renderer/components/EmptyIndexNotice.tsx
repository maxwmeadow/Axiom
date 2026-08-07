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
 * click. Nothing is broken, so nothing says anything — which is exactly why it
 * used to be unrecoverable without deleting the project and starting over.
 *
 * The recovery is the boundary picker, so the invitation carries a way back to
 * it rather than only naming the problem.
 */

const ID = 'empty-index'

/** Indexing settles asynchronously; only claim emptiness once it has held. */
const SETTLE_MS = 3000

export function EmptyIndexNotice({ onReconfigure }: { onReconfigure: () => void }) {
  const { empty, isIndexing, connected, workspaceId } = useGraphStore(useShallow(state => ({
    empty: state.files.length === 0 &&
      state.systems.length === 0 &&
      state.infraNodes.length === 0,
    isIndexing: state.isIndexing,
    connected: state.connectionStatus === 'connected',
    workspaceId: state.currentProject?.id ?? '',
  })))

  useEffect(() => {
    if (!workspaceId || isIndexing || !connected || !empty) {
      // Anything at all showed up, or work is still in flight. Retire the
      // claim rather than leaving a contradicted message on screen.
      resolveInterruption(ID)
      return
    }
    const timer = setTimeout(() => {
      raiseInvitation(
        ID,
        'Indexing finished without finding any source files',
        'Every folder in this project is currently excluded, so there is nothing to map.',
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
  }, [empty, isIndexing, connected, workspaceId, onReconfigure])

  return null
}
