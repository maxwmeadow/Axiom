import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  isDismissible,
  laneState,
  nextExpiry,
  type Interruption,
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
 * strip — that rule is the whole reason this component exists.
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

  // Expiry is wall-clock, so the lane needs to re-read when a notice lapses.
  // One timer aimed at the next expiry beats an interval: an idle workbench
  // with no expiring entries schedules nothing at all.
  const [, setTick] = useState(0)
  useEffect(() => {
    const due = nextExpiry(items, Date.now())
    if (due === null) return
    const timer = setTimeout(() => setTick(value => value + 1), Math.max(due - Date.now(), 0))
    return () => clearTimeout(timer)
  }, [items])

  const { current, waiting } = laneState(items, Date.now())
  if (!current) return null

  const dismissible = isDismissible(current)

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
            onClick={() => void action.run()}
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
            onClick={() => dismiss(current.id)}
            aria-label={`Dismiss: ${current.title}`}
            title="Dismiss"
          >
            ×
          </button>
        )}
      </div>
    </aside>
  )
}
