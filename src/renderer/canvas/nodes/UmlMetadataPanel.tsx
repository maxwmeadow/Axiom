import React from 'react'
import type {
  PlannedNodeKind,
  PlannedNodeMetadata,
  UmlAttribute,
  UmlMethod,
  UmlParameter,
  UmlVisibility,
} from '../../store/sheetStore'

interface Props {
  kind: PlannedNodeKind
  metadata: PlannedNodeMetadata
  editable?: boolean
  onChange?: (metadata: PlannedNodeMetadata) => void
  compact?: boolean
}

const visibilityGlyph: Record<UmlVisibility, string> = {
  public: '+', private: '-', protected: '#', package: '~',
}

function parseParameters(value: string): UmlParameter[] {
  return value.split(',').map(part => part.trim()).filter(Boolean).map(part => {
    const [name, ...type] = part.split(':')
    return { name: name.trim(), dataType: type.join(':').trim() }
  })
}

function EditText({ value, placeholder, editable, onCommit, style }: {
  value: string
  placeholder?: string
  editable: boolean
  onCommit: (value: string) => void
  style?: React.CSSProperties
}) {
  const [draft, setDraft] = React.useState(value)
  const [editing, setEditing] = React.useState(false)
  React.useEffect(() => setDraft(value), [value])
  React.useEffect(() => { if (!editable) setEditing(false) }, [editable])
  const commit = () => {
    const next = draft.trim()
    if (next !== value) onCommit(next)
    setEditing(false)
  }
  if (!editable || !editing) return (
    <span
      title={editable ? 'Double-click to edit' : undefined}
      onDoubleClick={editable ? event => {
        event.preventDefault()
        event.stopPropagation()
        setEditing(true)
      } : undefined}
      style={{ userSelect: 'none', cursor: editable ? 'text' : undefined, minWidth: 0, ...style }}
    >{value || placeholder}</span>
  )
  return (
    <input
      className="nodrag nopan nowheel"
      value={draft}
      placeholder={placeholder}
      onChange={event => setDraft(event.target.value)}
      onBlur={commit}
      autoFocus
      onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') { setDraft(value); setEditing(false) }
      }}
      style={{
        minWidth: 0, width: '100%', border: 0, borderBottom: '1px solid transparent',
        background: 'transparent', color: 'var(--text-primary)', outline: 'none',
        font: 'inherit', padding: 0, ...style,
        userSelect: 'text',
      }}
      onFocus={event => { event.currentTarget.style.borderBottomColor = 'var(--accent)' }}
    />
  )
}

function Section({ title, children, onAdd, editable }: {
  title: string
  children: React.ReactNode
  onAdd?: () => void
  editable: boolean
}) {
  return (
    <section style={{ borderTop: '1px solid var(--border-dim)', paddingTop: 3 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 2 }}>
        <span style={{ fontSize: 7, color: 'var(--text-dim)', letterSpacing: '0.08em', fontWeight: 700 }}>{title}</span>
        {editable && onAdd && (
          <button className="nodrag nopan" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onAdd() }}
            title={`Add ${title.toLowerCase()}`} style={{
              marginLeft: 'auto', border: 0, background: 'transparent', color: 'var(--accent)',
              fontSize: 11, lineHeight: 1, cursor: 'pointer', padding: '0 2px',
            }}>+</button>
        )}
      </div>
      {children}
    </section>
  )
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return <button className="nodrag nopan" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onClick() }}
    title="Remove" style={{ border: 0, background: 'transparent', color: 'var(--text-dim)', padding: 0, cursor: 'pointer', fontSize: 9 }}>×</button>
}

function VisibilityControl({ value, editable, onChange }: {
  value: UmlVisibility
  editable: boolean
  onChange: (value: UmlVisibility) => void
}) {
  if (!editable) return <span title={value}>{visibilityGlyph[value] ?? '+'}</span>
  return (
    <select className="nodrag nopan nowheel" value={value} title="UML visibility"
      onPointerDown={event => event.stopPropagation()}
      onChange={event => onChange(event.target.value as UmlVisibility)}
      style={{ width: 18, border: 0, background: 'transparent', color: 'var(--text-secondary)', font: 'inherit', padding: 0 }}>
      <option value="public">+</option><option value="private">-</option>
      <option value="protected">#</option><option value="package">~</option>
    </select>
  )
}

export function UmlMetadataPanel({ kind, metadata, editable = false, onChange, compact = false }: Props) {
  const update = (patch: Partial<PlannedNodeMetadata>) => onChange?.({ ...metadata, ...patch, version: 1 })
  const textField = (key: keyof PlannedNodeMetadata, placeholder: string) => (
    <EditText value={String(metadata[key] ?? '')} placeholder={placeholder} editable={editable}
      onCommit={value => update({ [key]: value })} />
  )
  const listSection = (title: string, key: 'exports' | 'entities' | 'configuration', placeholder: string) => {
    const values = metadata[key] ?? []
    return (
      <Section title={title} editable={editable} onAdd={() => update({ [key]: [...values, ''] })}>
        {values.length === 0 && !editable && <div style={{ color: 'var(--text-dim)' }}>—</div>}
        {values.map((value, index) => (
          <div key={`${key}-${index}`} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 3 }}>
            <EditText value={value} placeholder={placeholder} editable={editable}
              onCommit={next => update({ [key]: values.map((item, i) => i === index ? next : item) })} />
            {editable && <RemoveButton onClick={() => update({ [key]: values.filter((_, i) => i !== index) })} />}
          </div>
        ))}
      </Section>
    )
  }
  const methodSection = (title: string, key: 'methods' | 'endpoints') => {
    const methods = metadata[key] ?? []
    const replace = (index: number, patch: Partial<UmlMethod>) => update({
      [key]: methods.map((method, i) => i === index ? { ...method, ...patch } : method),
    })
    return (
      <Section title={title} editable={editable} onAdd={() => update({
        [key]: [...methods, { visibility: 'public', name: '', parameters: [], returnType: '' }],
      })}>
        {methods.length === 0 && !editable && <div style={{ color: 'var(--text-dim)' }}>—</div>}
        {methods.map((method, index) => (
          <div key={`${key}-${index}`} style={{ display: 'grid', gridTemplateColumns: '10px minmax(40px,1fr) minmax(35px,.8fr) minmax(28px,.55fr) auto', gap: 2, alignItems: 'center' }}>
            <VisibilityControl value={method.visibility} editable={editable} onChange={visibility => replace(index, { visibility })} />
            <EditText value={method.name} placeholder={key === 'endpoints' ? 'operation' : 'method'} editable={editable} onCommit={name => replace(index, { name })} />
            <EditText value={method.parameters.map(p => `${p.name}${p.dataType ? `: ${p.dataType}` : ''}`).join(', ')} placeholder="params" editable={editable}
              onCommit={value => replace(index, { parameters: parseParameters(value) })} />
            <EditText value={method.returnType} placeholder="return" editable={editable} onCommit={returnType => replace(index, { returnType })} />
            {editable && <RemoveButton onClick={() => update({ [key]: methods.filter((_, i) => i !== index) })} />}
          </div>
        ))}
      </Section>
    )
  }

  const attributes = metadata.attributes ?? []
  const replaceAttribute = (index: number, patch: Partial<UmlAttribute>) => update({
    attributes: attributes.map((attribute, i) => i === index ? { ...attribute, ...patch } : attribute),
  })

  return (
    <div className="nowheel" style={{
      display: 'flex', flexDirection: 'column', gap: 3, minHeight: 0,
      overflowY: 'auto', fontSize: compact ? 7.5 : 8, fontFamily: 'var(--font-mono)',
      color: 'var(--text-secondary)', lineHeight: 1.35, userSelect: 'none',
    }}>
      {kind === 'class' && <>
        <Section title="ATTRIBUTES" editable={editable} onAdd={() => update({ attributes: [...attributes, { visibility: 'private', name: '', dataType: '' }] })}>
          {attributes.length === 0 && !editable && <div style={{ color: 'var(--text-dim)' }}>—</div>}
          {attributes.map((attribute, index) => (
            <div key={`attribute-${index}`} style={{ display: 'grid', gridTemplateColumns: '10px 1fr .8fr auto', gap: 2 }}>
              <VisibilityControl value={attribute.visibility} editable={editable} onChange={visibility => replaceAttribute(index, { visibility })} />
              <EditText value={attribute.name} placeholder="attribute" editable={editable} onCommit={name => replaceAttribute(index, { name })} />
              <EditText value={attribute.dataType} placeholder="type" editable={editable} onCommit={dataType => replaceAttribute(index, { dataType })} />
              {editable && <RemoveButton onClick={() => update({ attributes: attributes.filter((_, i) => i !== index) })} />}
            </div>
          ))}
        </Section>
        {methodSection('METHODS', 'methods')}
      </>}
      {kind === 'file' && listSection('EXPORTS', 'exports', 'exported symbol')}
      {kind === 'system' && null}
      {kind === 'service' && <>
        <div style={{ display: 'grid', gridTemplateColumns: '.6fr 1fr', gap: 4 }}>
          {textField('protocol', 'protocol')}{textField('address', 'address / topic')}
        </div>
        {textField('description', 'purpose')}
        {methodSection('OPERATIONS', 'endpoints')}
      </>}
      {kind === 'data_store' && <>
        {textField('technology', 'technology')}
        {textField('description', 'purpose')}
        {listSection('ENTITIES / TABLES', 'entities', 'entity or table')}
      </>}
      {kind === 'infra' && <>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
          {textField('category', 'category')}{textField('subtype', 'subtype')}
          {textField('provider', 'provider')}{textField('service', 'service')}
        </div>
        {textField('description', 'purpose')}
        {listSection('CONFIGURATION', 'configuration', 'key: value')}
      </>}
    </div>
  )
}
