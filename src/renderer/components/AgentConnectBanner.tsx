import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import {
  raiseInvitation,
  raiseNotice,
  resolveInterruption,
  useInterruptionStore,
} from '../store/interruptionStore.ts'

/**
 * "Files are indexed but unclassified — connect an agent to give them
 * boundaries."
 *
 * Renders nothing of its own. This was a bottom-centre banner with its own
 * dismiss state; it is now an `invitation` in the interruption lane, which
 * ranks it below anything actually blocked or broken and gives it the same
 * dismissal behaviour as every other offer in the app.
 */

const ID = 'agent-connect'
const MCP_ENDPOINT = 'http://127.0.0.1:7743/mcp'

export function AgentConnectBanner() {
  const { unclassified, isIndexing, workspaceId } = useGraphStore(useShallow(state => ({
    unclassified: state.files.filter(file => !file.systemId).length,
    isIndexing: state.isIndexing,
    workspaceId: state.currentProject?.id ?? '',
  })))

  // What we last put on screen, so the count can be corrected without the
  // invitation being raised twice for the same facts. Dismissing is a judgement
  // about this codebase, not a global preference, so opening a different one
  // asks again.
  const invited = useRef<{ workspace: string; count: number } | null>(null)
  useEffect(() => {
    invited.current = null
  }, [workspaceId])

  // Whether the invitation is currently on screen. Re-raising blindly on every
  // file change would resurrect a dismissed invitation on the agent's next
  // keystroke; never re-raising froze the count at whatever it was when the
  // agent started, so it still read "48 files" with three left. Refresh only
  // while it is genuinely still showing.
  const showing = useInterruptionStore(
    state => state.items.some(item => item.id === ID),
  )

  useEffect(() => {
    if (isIndexing || unclassified === 0 || !workspaceId) {
      // The condition resolved — an agent classified the files, or indexing
      // restarted. Retire the invitation rather than leaving it stale.
      if (invited.current !== null) {
        resolveInterruption(ID)
        invited.current = null
      }
      return
    }
    // Re-raise only to correct a count the user can still see. Raising because
    // it merely became visible would fire twice for one set of facts; never
    // re-raising froze "48 files" while three remained; and re-raising after a
    // dismissal would resurrect it on the agent's next keystroke.
    const prior = invited.current
    if (prior?.workspace === workspaceId && (!showing || prior.count === unclassified)) {
      return
    }
    invited.current = { workspace: workspaceId, count: unclassified }

    raiseInvitation(
      ID,
      `${unclassified} ${unclassified === 1 ? 'file has' : 'files have'} no architectural home`,
      'Connect an agent over MCP to group them into systems.',
      [{
        label: 'Copy MCP endpoint',
        primary: true,
        run: async () => {
          try {
            await navigator.clipboard.writeText(MCP_ENDPOINT)
            raiseNotice('agent-connect-copied', 'MCP endpoint copied', MCP_ENDPOINT)
          } catch {
            // Clipboard access can be refused; the endpoint is still useful
            // if we simply show it.
            raiseNotice('agent-connect-copied', 'Copy the MCP endpoint', MCP_ENDPOINT)
          }
        },
      }],
    )
  }, [unclassified, isIndexing, workspaceId])

  return null
}
