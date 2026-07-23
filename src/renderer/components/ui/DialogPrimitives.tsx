import type { CSSProperties, FormEventHandler, PropsWithChildren, WheelEventHandler } from 'react'

type DialogFrameProps = PropsWithChildren<{
  width: number
  backdropClassName?: string
  onWheel?: WheelEventHandler<HTMLDivElement>
}>

export function DialogFrame({ children, width, backdropClassName, onWheel }: DialogFrameProps) {
  return (
    <div className={['axiom-dialog-backdrop', backdropClassName].filter(Boolean).join(' ')} onWheel={onWheel}>
      <div
        className="axiom-dialog-surface glass-dialog animate-fade-in"
        style={{ '--axiom-dialog-width': `${width}px` } as CSSProperties}
      >
        {children}
      </div>
    </div>
  )
}

type DialogTitleProps = PropsWithChildren<{ compact?: boolean }>

export function DialogTitle({ children, compact = false }: DialogTitleProps) {
  return <h3 className={compact ? 'axiom-dialog-title axiom-dialog-title--compact' : 'axiom-dialog-title'}>{children}</h3>
}

export function DialogError({ children }: PropsWithChildren) {
  return <div className="axiom-dialog-error">{children}</div>
}

type DialogFormProps = PropsWithChildren<{
  gap?: 14 | 16
  onSubmit: FormEventHandler<HTMLFormElement>
}>

export function DialogForm({ children, gap = 16, onSubmit }: DialogFormProps) {
  return <form className={`axiom-dialog-form axiom-dialog-form--gap-${gap}`} onSubmit={onSubmit}>{children}</form>
}

type DialogActionsProps = PropsWithChildren<{ inset?: boolean }>

export function DialogActions({ children, inset = false }: DialogActionsProps) {
  return <div className={inset ? 'axiom-dialog-actions axiom-dialog-actions--inset' : 'axiom-dialog-actions'}>{children}</div>
}

type DialogButtonProps = PropsWithChildren<{
  type: 'button' | 'submit'
  variant: 'secondary' | 'primary' | 'agent'
  disabled?: boolean
  disabledOpacity?: number
  onClick?: () => void
}>

export function DialogButton({ children, type, variant, disabled = false, disabledOpacity, onClick }: DialogButtonProps) {
  return (
    <button
      type={type}
      className={`axiom-dialog-button axiom-dialog-button--${variant}`}
      disabled={disabled}
      onClick={onClick}
      style={disabledOpacity === undefined
        ? undefined
        : { '--axiom-dialog-disabled-opacity': disabledOpacity } as CSSProperties}
    >
      {children}
    </button>
  )
}
