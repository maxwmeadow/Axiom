import React from 'react'

interface EditableNodeTitleProps {
  value: string
  onRename?: (name: string) => void
  style?: React.CSSProperties
  title?: string
}

export function EditableNodeTitle({ value, onRename, style, title }: EditableNodeTitleProps) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(value)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  React.useEffect(() => {
    if (!editing || !inputRef.current) return
    const input = inputRef.current
    input.focus()
    const end = input.value.length
    input.setSelectionRange(end, end)
  }, [editing])

  const commit = () => {
    const next = draft.trim()
    setEditing(false)
    if (next && next !== value) onRename?.(next)
    else setDraft(value)
  }

  if (editing && onRename) {
    return (
      <input
        ref={inputRef}
        className="nodrag nopan"
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onBlur={commit}
        onPointerDown={event => event.stopPropagation()}
        onPointerUp={event => event.stopPropagation()}
        onMouseDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}
        onDoubleClick={event => event.stopPropagation()}
        onKeyDown={event => {
          event.stopPropagation()
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape') {
            setDraft(value)
            setEditing(false)
          }
        }}
        style={{
          ...style,
          width: '100%', minWidth: 0, padding: 0, margin: 0,
          border: 'none', borderBottom: '1px solid var(--accent)', outline: 'none',
          background: 'var(--bg-raised)',
          userSelect: 'text',
        }}
      />
    )
  }

  return (
    <span
      data-node-editable={onRename ? 'true' : undefined}
      title={title}
      onDoubleClick={event => {
        if (!onRename) return
        event.stopPropagation()
        setDraft(value)
        setEditing(true)
      }}
      style={{
        ...style,
        pointerEvents: onRename ? 'auto' : style?.pointerEvents,
        cursor: onRename ? 'text' : style?.cursor,
        userSelect: 'none',
      }}
    >
      {value}
    </span>
  )
}
