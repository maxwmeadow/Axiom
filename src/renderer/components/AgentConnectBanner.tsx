import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import { describeAuthorship, readAuthorship } from '../canvas/architectureAuthorship.ts'
import {
  raiseInvitation,
  raiseNotice,
  resolveInterruption,
  useInterruptionStore,
} from '../store/interruptionStore.ts'

/**
 * "Your map is named by guesswork — let an agent name it properly."
 *
 * Renders nothing of its own; it raises an `invitation` in the interruption
 * lane, which ranks it below anything actually blocked or broken and gives it
 * the same dismissal behaviour as every other offer in the app.
 *
 * Two things about it were wrong and are worth recording so they are not
 * reintroduced.
 *
 * It asked whether files were UNCLASSIFIED, which is a question about coverage.
 * A workspace whose every file sat in an auto-generated pile answered "nothing
 * to see" while the canvas read Bar, Lane, Phase and Cochange. The condition is
 * now authorship (see `architectureAuthorship.ts`): a map made of guesses is
 * the state worth offering to fix, however complete it is.
 *
 * And its one action copied `http://127.0.0.1:7743/mcp`, which archd does not
 * serve and never has — the daemon registers no such route. Axiom speaks MCP
 * over stdio, so following the app's own instruction could not possibly work.
 * It now offers the real server entry for this install.
 */

const ID = 'agent-connect'

export function AgentConnectBanner() {
  const { systems, files, isIndexing, workspaceId } = useGraphStore(useShallow(state => ({
    systems: state.systems,
    files: state.files,
    isIndexing: state.isIndexing,
    workspaceId: state.currentProject?.id ?? '',
  })))

  const authorship = readAuthorship({ systems, files })
  const described = describeAuthorship(authorship)

  // What we last put on screen, so wording can be corrected without the
  // invitation being raised twice for the same facts. Dismissing is a judgement
  // about this codebase, not a global preference, so opening a different one
  // asks again.
  // Keyed on the whole sentence rather than the title. The title is constant
  // for a given condition, so keying on it froze the wording at whatever the
  // counts were when the invitation first appeared — which on a fresh project
  // is before indexing has finished. It read "0 systems were named
  // automatically" over a canvas showing fifteen.
  const invited = useRef<{ workspace: string; said: string } | null>(null)
  useEffect(() => {
    invited.current = null
  }, [workspaceId])

  // Whether the invitation is currently on screen. Re-raising blindly on every
  // graph change would resurrect a dismissed invitation on the agent's next
  // keystroke; never re-raising froze the wording at whatever it was when the
  // agent started. Refresh only while it is genuinely still showing.
  const showing = useInterruptionStore(
    state => state.items.some(item => item.id === ID),
  )

  useEffect(() => {
    if (isIndexing || !described || !workspaceId) {
      // The condition resolved — the map has been named, or indexing restarted.
      // Retire the invitation rather than leaving it stale.
      if (invited.current !== null) {
        resolveInterruption(ID)
        invited.current = null
      }
      return
    }

    const said = `${described.title}\n${described.detail}`
    const prior = invited.current
    if (prior?.workspace === workspaceId && (!showing || prior.said === said)) {
      return
    }
    invited.current = { workspace: workspaceId, said }

    raiseInvitation(
      ID,
      described.title,
      described.detail,
      [{
        label: 'Connect an agent',
        primary: true,
        run: async () => {
          const connection = await window.axiom.getAgentConnection()
          if (!connection.available) {
            // Never hand over a config that cannot work. Saying which file is
            // missing is the difference between a user debugging their agent
            // and a user reinstalling Axiom.
            raiseNotice(
              'agent-connect-config',
              'This Axiom install has no MCP server',
              `Expected it at ${connection.path}. Reinstall or rebuild before connecting an agent.`,
            )
            return
          }
          try {
            await navigator.clipboard.writeText(connection.config)
            raiseNotice(
              'agent-connect-config',
              'Server entry copied',
              'Paste it into your agent\'s MCP configuration, then ask it to review this architecture.',
            )
          } catch {
            // Clipboard access can be refused; the config is still useful shown.
            raiseNotice('agent-connect-config', 'Add this to your agent\'s MCP config', connection.config)
          }
        },
      }],
    )
  }, [described?.title, described?.detail, isIndexing, workspaceId, showing])

  return null
}
