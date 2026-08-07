import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import {
  raiseInvitation,
  raiseNotice,
  resolveInterruption,
} from '../store/interruptionStore'

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

  // Re-invite once per project. Dismissing is a judgement about this codebase,
  // not a global preference, so opening a different one asks again.
  const invitedFor = useRef<string | null>(null)
  useEffect(() => {
    invitedFor.current = null
  }, [workspaceId])

  useEffect(() => {
    if (isIndexing || unclassified === 0 || !workspaceId) {
      // The condition resolved — an agent classified the files, or indexing
      // restarted. Retire the invitation rather than leaving it stale.
      if (invitedFor.current !== null) {
        resolveInterruption(ID)
        invitedFor.current = null
      }
      return
    }
    // Raising again on every file change would resurrect a dismissed
    // invitation on the next keystroke an agent makes.
    if (invitedFor.current === workspaceId) return
    invitedFor.current = workspaceId

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
