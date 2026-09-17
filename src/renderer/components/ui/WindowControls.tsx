import { useEffect, useState } from 'react'

export function WindowControls() {
  const platform = window.axiom?.platform
    || (typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
      ? 'darwin'
      : typeof navigator !== 'undefined' && navigator.userAgent.includes('Win')
        ? 'win32'
        : 'linux')

  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (platform !== 'linux') return
    void window.axiom?.isMaximized?.().then(max => {
      if (typeof max === 'boolean') setIsMaximized(max)
    })
    const unsubscribe = window.axiom?.onMaximizedChange?.(max => {
      setIsMaximized(max)
    })
    return () => {
      unsubscribe?.()
    }
  }, [platform])

  // macOS uses native traffic lights on top-left; Windows uses native titleBarOverlay on top-right.
  if (platform !== 'linux') return null

  return (
    <div className="axiom-window-controls" role="group" aria-label="Window controls">
      <button
        type="button"
        className="axiom-window-control axiom-window-control--minimize"
        title="Minimize"
        aria-label="Minimize"
        onClick={() => void window.axiom?.minimize?.()}
      >
        <svg width="10" height="1" viewBox="0 0 10 1" fill="none" aria-hidden="true">
          <rect width="10" height="1" fill="currentColor" />
        </svg>
      </button>

      <button
        type="button"
        className="axiom-window-control axiom-window-control--maximize"
        title={isMaximized ? 'Restore' : 'Maximize'}
        aria-label={isMaximized ? 'Restore' : 'Maximize'}
        onClick={() => void window.axiom?.maximize?.()}
      >
        {isMaximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2.5 2.5V0.5h7v7H7.5" stroke="currentColor" strokeWidth="1" />
            <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>

      <button
        type="button"
        className="axiom-window-control axiom-window-control--close"
        title="Close"
        aria-label="Close"
        onClick={() => void window.axiom?.close?.()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}

