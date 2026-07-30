import type { AriaAttributes, PropsWithChildren } from 'react'

type ChromeButtonProps = PropsWithChildren<{
  onClick: () => void
  label: string
  visualLabel?: string
  shortcut?: string
  active?: boolean
  ariaControls?: string
  ariaExpanded?: boolean
  ariaHasPopup?: AriaAttributes['aria-haspopup']
}>

export function ChromeButton({
  onClick,
  label,
  visualLabel,
  shortcut,
  active = false,
  ariaControls,
  ariaExpanded,
  ariaHasPopup,
  children,
}: ChromeButtonProps) {
  return (
    <button
      type="button"
      className={active ? 'axiom-chrome-button axiom-chrome-button--active' : 'axiom-chrome-button'}
      onClick={onClick}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-controls={ariaControls}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHasPopup}
    >
      {children}
      <span className="axiom-chrome-button__label">{visualLabel ?? label}</span>
      {shortcut && <kbd className="axiom-chrome-button__shortcut">{shortcut}</kbd>}
    </button>
  )
}
