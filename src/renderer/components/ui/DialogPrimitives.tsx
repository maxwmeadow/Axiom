import { useId } from 'react'
import type { CSSProperties, FormEventHandler, PropsWithChildren, WheelEventHandler } from 'react'

type DialogFrameProps = PropsWithChildren<{
  title: string
  width: number
  backdropClassName?: string
  onWheel?: WheelEventHandler<HTMLDivElement>
}>

export function DialogFrame({ children, title, width, backdropClassName, onWheel }: DialogFrameProps) {
  const titleId = useId()

  return (
    <div className={['axiom-dialog-backdrop', backdropClassName].filter(Boolean).join(' ')} onWheel={onWheel}>
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="axiom-dialog-surface animate-fade-in"
        role="dialog"
        style={{ '--axiom-dialog-width': `${width}px` } as CSSProperties}
      >
        <header className="axiom-dialog-header">
          <h2 className="axiom-dialog-title" id={titleId}>{title}</h2>
        </header>
        <div className="axiom-dialog-content">{children}</div>
      </section>
    </div>
  )
}

export function DialogError({ children }: PropsWithChildren) {
  return <div className="axiom-dialog-error" role="alert">{children}</div>
}

type DialogFormProps = PropsWithChildren<{
  gap?: 14 | 16
  onSubmit: FormEventHandler<HTMLFormElement>
}>

export function DialogForm({ children, gap = 16, onSubmit }: DialogFormProps) {
  return <form className={`axiom-dialog-form axiom-dialog-form--gap-${gap}`} onSubmit={onSubmit}>{children}</form>
}

type DialogFieldProps = PropsWithChildren<{
  label: string
  optional?: string
}>

export function DialogField({ children, label, optional }: DialogFieldProps) {
  return (
    <label className="axiom-dialog-field">
      <span className="axiom-dialog-field__label">
        {label}
        {optional && <span className="axiom-dialog-field__optional">{optional}</span>}
      </span>
      {children}
    </label>
  )
}

export function DialogNote({ children }: PropsWithChildren) {
  return <p className="axiom-dialog-note">{children}</p>
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
