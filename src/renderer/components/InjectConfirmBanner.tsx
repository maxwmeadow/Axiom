import { useEffect } from 'react'
import { useGraphStore } from '../store/graphStore'
import {
  raiseDecision,
  raiseFailure,
  resolveInterruption,
  useInterruptionStore,
} from '../store/interruptionStore'

/**
 * The warn-and-confirm gate for perturbations.
 *
 * When an agent calls inject_value the injection sits in pending_confirm until
 * the user approves it here. Denying or ignoring it (2 min timeout) means it
 * never reaches the target process.
 *
 * This renders nothing of its own. It used to be a hand-positioned banner at
 * top-centre — the same coordinates the collapsed delta strip claimed, so the
 * two covered each other. It now raises a `decision` into the interruption
 * lane, which is the only surface allowed in that space and ranks a blocked
 * agent above everything else automatically.
 */

const PREFIX = 'inject:'

export function InjectConfirmBanner() {
  const injections = useGraphStore(s => s.runtimeInjections)

  useEffect(() => {
    const pending = Object.values(injections)
      .filter(injection => injection.status === 'pending_confirm')
      .sort((a, b) => a.createdAt - b.createdAt)

    for (const injection of pending) {
      const id = PREFIX + injection.id

      const respond = async (approved: boolean) => {
        try {
          const res = await fetch('http://127.0.0.1:7743/api/runtime/inject/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workspaceId: injection.workspaceId,
              injectId: injection.id,
              approved,
            }),
          })
          if (!res.ok) throw new Error(await res.text())
          // The websocket patch clears pending_confirm, which retires this
          // decision on the next pass. Resolving here too keeps the lane
          // honest if that patch is slow.
          resolveInterruption(id)
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          raiseFailure(
            `inject-failed:${injection.id}`,
            'Could not answer the perturbation request',
            `${detail} — the agent is still waiting.`,
          )
          useGraphStore.getState().addAgentActivity({
            message: `Injection confirmation failed: ${detail}`,
            level: 'error',
          })
        }
      }

      raiseDecision(
        id,
        'An agent wants to override a value',
        `${injection.paramName} = ${JSON.stringify(injection.value)} on the next call to ` +
        `${injection.symbol} in ${injection.relPath}` +
        `${injection.once ? ' (one-shot).' : ' (persistent).'} ` +
        'The function runs with the injected value, so side effects may occur.',
        [
          { label: 'Deny', run: () => void respond(false) },
          { label: 'Allow', primary: true, run: () => void respond(true) },
        ],
      )
    }

    // An injection that timed out, or was answered from another window, must
    // not leave a stale question on screen.
    const live = new Set(pending.map(injection => PREFIX + injection.id))
    for (const item of useInterruptionStore.getState().items) {
      if (item.id.startsWith(PREFIX) && !live.has(item.id)) resolveInterruption(item.id)
    }
  }, [injections])

  return null
}
