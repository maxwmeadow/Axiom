type FocusTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>

/**
 * Refresh the durable Morning Delta whenever the user returns to Axiom.
 * The store owns request coalescing and review/ack sequencing; this adapter
 * only translates browser focus into the domain action.
 */
export function subscribeToDeltaRefresh(
  target: FocusTarget,
  refresh: () => void | Promise<void>,
): () => void {
  const onFocus = () => {
    void refresh()
  }

  target.addEventListener('focus', onFocus)
  return () => target.removeEventListener('focus', onFocus)
}
