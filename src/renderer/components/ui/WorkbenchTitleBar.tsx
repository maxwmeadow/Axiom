import { useEffect, type ReactNode } from 'react'
import { WindowControls } from './WindowControls'

interface WorkbenchTitleBarProps {
  context: ReactNode
  status: string
  statusTone?: 'ready' | 'busy'
  className?: string
}

export function WorkbenchTitleBar({
  context,
  status,
  statusTone = 'ready',
  className = '',
}: WorkbenchTitleBarProps) {
  useEffect(() => {
    void window.axiom?.setTitleBarHeight?.(44)
  }, [])

  return (
    <header className={`axiom-workbench-titlebar ${className}`.trim()}>
      <div className="axiom-workbench-titlebar__product">
        <AxiomMark compact />
        <strong>Axiom Architecture Workbench</strong>
        <span>{context}</span>
      </div>
      <span
        className={
          statusTone === 'busy'
            ? 'axiom-workbench-titlebar__status axiom-workbench-titlebar__status--busy'
            : 'axiom-workbench-titlebar__status'
        }
      >
        {status}
      </span>
      <WindowControls />
    </header>
  )
}

export function AxiomMark({ compact = false }: { compact?: boolean }) {
  return (
    <svg
      className={compact ? 'axiom-brand-mark axiom-brand-mark--compact' : 'axiom-brand-mark'}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
    >
      <polygon className="axiom-brand-mark__shell" points="32,4 60,18 60,46 32,60 4,46 4,18" />
      <polygon className="axiom-brand-mark__core" points="32,14 50,22 50,42 32,50 14,42 14,22" />
      <path d="M32 4v10M60 18l-10 5M60 46l-10-5M32 60V50M4 46l10-5M4 18l10 5" />
      <circle cx="32" cy="32" r="7" />
      <circle className="axiom-brand-mark__point" cx="32" cy="32" r="2.5" />
    </svg>
  )
}
