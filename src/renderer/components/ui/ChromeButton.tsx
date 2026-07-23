import type { PropsWithChildren } from 'react'

type ChromeButtonProps = PropsWithChildren<{
  onClick: () => void
  label: string
  shortcut?: string
  active?: boolean
}>

export function ChromeButton({ onClick, label, shortcut, active = false, children }: ChromeButtonProps) {
  return (
    <button
      type="button"
      className={active ? 'axiom-chrome-button axiom-chrome-button--active' : 'axiom-chrome-button'}
      onClick={onClick}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
    >
      {children}
      {shortcut && <kbd className="axiom-chrome-button__shortcut">{shortcut}</kbd>}
    </button>
  )
}
