import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  isDismissible,
  laneState,
  type Interruption,
  type InterruptionAction,
} from '../../shared/interruptions.ts'
import { useInterruptionStore } from '../store/interruptionStore.ts'

/**
 * The single place anything interrupts you.
 *
 * One item on screen at a time, ranked by shared/interruptions.ts, with an
 * honest count of what is behind it. The count is what makes one-at-a-time
 * honest rather than concealing: you can always see there are three more and
 * step through them, but they never fight for the same pixels.
 *
 * Position is fixed and exclusive. No other surface may occupy the top-centre
 * strip - that rule is the whole reason this component exists.
 */

const KIND_LABEL: Record<Interruption['kind'], string> = {
  decision: 'NEEDS YOU',
  failure: 'FAILED',
  invitation: 'WAITING',
  notice: 'DONE',
}

export function InterruptionLane() {
  const { items, dismiss } = useInterruptionStore(useShallow(state => ({
    items: state.items,
    dismiss: state.dismiss,
  })))

  // Expiry is the store's job - each entry owns a timer that removes it, so
  // `items` changing is the only thing that can change what is rendered.
  const { current, waiting } = laneState(items, Date.now())

  // An action that talks to the daemon takes time, and a second click during
  // that window sends a second request: the first answer succeeds, the second
  // gets a 409, and the user is told the agent is still waiting when it is not.
  const [running, setRunning] = useState<string | null>(null)
  useEffect(() => {
    // A new question is a new decision to make, even if the last one is still
    // settling. Never leave the replacement stuck behind a stale guard.
    setRunning(null)
  }, [current?.id])

  if (!current) return null

  const dismissible = isDismissible(current)
  const busy = running === current.id

  const runAction = async (action: InterruptionAction) => {
    if (busy) return
    setRunning(current.id)
    try {
      await action.run()
    } finally {
      // The entry is normally gone by now; this only matters when the action
      // failed and left the question on screen to be answered again.
      setRunning(value => (value === current.id ? null : value))
    }
  }

  return (
    <aside
      className="axiom-lane"
      data-kind={current.kind}
      role={current.kind === 'decision' ? 'alertdialog' : 'status'}
      aria-live={current.kind === 'decision' ? 'assertive' : 'polite'}
      aria-label={`${KIND_LABEL[current.kind]}: ${current.title}`}
    >
      <span className="axiom-lane__kind">{KIND_LABEL[current.kind]}</span>

      <div className="axiom-lane__copy">
        <strong className="axiom-lane__title">{current.title}</strong>
        {current.body && <span className="axiom-lane__body">{current.body}</span>}
      </div>

      <div className="axiom-lane__actions">
        {current.actions?.map(action => (
          <button
            key={action.label}
            type="button"
            className={
              action.primary
                ? 'axiom-lane__button axiom-lane__button--primary'
                : 'axiom-lane__button'
            }
            disabled={busy}
            onClick={() => void runAction(action)}
          >
            {action.label}
          </button>
        ))}

        {waiting > 0 && (
          <span className="axiom-lane__waiting" title="Shown one at a time, most urgent first">
            +{waiting}
          </span>
        )}

        {dismissible && (
          <button
            type="button"
            className="axiom-lane__dismiss"
            onClick={() => {
              // Dismissal is the raiser's to define. Removing the entry without
              // telling them means a "not now" that is neither remembered nor
              // recoverable - and one that reappears on the next update.
              void current.onDismiss?.()
              dismiss(current.id)
            }}
            aria-label={current.dismissHint ?? `Dismiss: ${current.title}`}
            title={current.dismissHint ?? 'Dismiss'}
          >
            ×
          </button>
        )}
      </div>
    </aside>
  )
}
