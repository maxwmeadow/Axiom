import React from 'react'
import { useGraphStore } from '../store/graphStore'
import { useShallow } from 'zustand/react/shallow'
import type { DbFile, DbSystem, DbDependency } from '../../shared/types'
import { plannedMetadata, useSheetStore } from '../store/sheetStore'
import type { PlannedNode, PlannedNodeMetadata } from '../store/sheetStore'
import { useRegistryStore } from '../store/registryStore'
import { filenameForLanguage, LanguagePicker } from '../canvas/languages'
import { UmlMetadataPanel } from '../canvas/nodes/UmlMetadataPanel'

export function DetailPanel() {
  const { inspectedNodeId, files, systems, infraNodes, dependencies, setSelectedNode, setInspectedNode } = useGraphStore(
    useShallow(s => ({
      inspectedNodeId: s.inspectedNodeId,
      files: s.files,
      systems: s.systems,
      infraNodes: s.infraNodes,
      dependencies: s.dependencies,
      setSelectedNode: s.setSelectedNode,
      setInspectedNode: s.setInspectedNode,
    }))
  )
  const plannedNodes = useSheetStore(s => s.planned)

  if (!inspectedNodeId) return null

  const file = files.find(f => f.id === inspectedNodeId)
  const system = !file ? systems.find(s => s.id === inspectedNodeId) : undefined
  const infra = !file && !system ? infraNodes.find(n => n.id === inspectedNodeId) : undefined
  const planned = inspectedNodeId.startsWith('planned:')
    ? plannedNodes.find(node => node.id === inspectedNodeId.slice('planned:'.length))
    : undefined

  if (!file && !system && !infra && !planned) return null

  return (
    <div style={{
      position: 'fixed', right: 0, top: 48, bottom: 0,
      width: 280,
      background: 'var(--bg-surface)',
      borderLeft: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      animation: 'fadeIn 0.15s ease-out',
      zIndex: 10,
    }}>
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.05em' }}>
          {planned ? `PLANNED ${planned.kind.replace('_', ' ').toUpperCase()}` : file ? 'FILE' : system ? 'SYSTEM' : 'INFRA'}
        </span>
        <button
          onClick={() => setInspectedNode(null)}
          style={{ color: 'var(--text-dim)', fontSize: 16, padding: '2px 6px' }}
        >×</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {planned && <PlannedDetail node={planned} />}
        {file && !planned && <FileDetail file={file} systems={systems} dependencies={dependencies} setSelectedNode={id => {
          setSelectedNode(id)
          setInspectedNode(id)
        }} />}
        {system && <SystemDetail system={system} files={files} systems={systems} />}
        {infra && (
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>
              {infra.name}
            </div>
            <Stat label="Type" value={infra.infraType} />
          </div>
        )}
      </div>
    </div>
  )
}

function InspectorText({ label, value, multiline, onCommit }: { label: string; value: string; multiline?: boolean; onCommit: (value: string) => void }) {
  const [draft, setDraft] = React.useState(value)
  React.useEffect(() => setDraft(value), [value])
  const common = {
    value: draft,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(event.target.value),
    onBlur: () => { if (draft !== value) onCommit(draft) },
    className: 'glass-input',
    style: { width: '100%', fontSize: 11, padding: '7px 8px', resize: 'vertical' as const },
  }
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
    <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', letterSpacing: '0.08em' }}>{label}</span>
    {multiline ? <textarea {...common} rows={3} /> : <input {...common} />}
  </label>
}

interface KeyValueRow {
  id: number
  key: string
  value: string
}

function KeyValueEditor({ label, value, onChange }: {
  label: string
  value: Record<string, string>
  onChange: (value: Record<string, string>) => void
}) {
  const nextId = React.useRef(0)
  const toRows = React.useCallback((record: Record<string, string>): KeyValueRow[] =>
    Object.entries(record).map(([key, entryValue]) => ({ id: nextId.current++, key, value: entryValue })), [])
  const serialized = JSON.stringify(value)
  const lastCommitted = React.useRef(serialized)
  const [rows, setRows] = React.useState<KeyValueRow[]>(() => toRows(value))

  React.useEffect(() => {
    if (serialized === lastCommitted.current) return
    lastCommitted.current = serialized
    setRows(toRows(value))
  }, [serialized, toRows, value])

  const commit = (nextRows: KeyValueRow[]) => {
    const next: Record<string, string> = {}
    for (const row of nextRows) {
      const key = row.key.trim()
      if (key) next[key] = row.value
    }
    const nextSerialized = JSON.stringify(next)
    if (nextSerialized === serialized) return
    lastCommitted.current = nextSerialized
    onChange(next)
  }

  const updateRow = (id: number, field: 'key' | 'value', entryValue: string) => {
    setRows(current => current.map(row => row.id === id ? { ...row, [field]: entryValue } : row))
  }
  const removeRow = (id: number) => {
    const next = rows.filter(row => row.id !== id)
    setRows(next)
    commit(next)
  }
  const addRow = () => setRows(current => [...current, { id: nextId.current++, key: '', value: '' }])

  return <div style={{ marginBottom: 12 }}>
    <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', letterSpacing: '0.08em', marginBottom: 6 }}>{label}</div>
    {rows.length > 0 && <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 0.9fr) minmax(0, 1.1fr) 22px', gap: 5, alignItems: 'center' }}>
      <span style={{ fontSize: 8, color: 'var(--text-dim)', letterSpacing: '0.08em' }}>KEY</span>
      <span style={{ fontSize: 8, color: 'var(--text-dim)', letterSpacing: '0.08em' }}>VALUE</span>
      <span />
      {rows.map((row, index) => <React.Fragment key={row.id}>
        <input autoFocus={index === rows.length - 1 && !row.key} className="glass-input" value={row.key}
          placeholder="VARIABLE_NAME" onChange={event => updateRow(row.id, 'key', event.target.value)} onBlur={() => commit(rows)}
          style={{ width: '100%', minWidth: 0, padding: '6px 7px', fontSize: 10, fontFamily: 'var(--font-mono)' }} />
        <input className="glass-input" value={row.value} placeholder="value"
          onChange={event => updateRow(row.id, 'value', event.target.value)} onBlur={() => commit(rows)}
          style={{ width: '100%', minWidth: 0, padding: '6px 7px', fontSize: 10, fontFamily: 'var(--font-mono)' }} />
        <button type="button" title="Remove variable" onClick={() => removeRow(row.id)} style={{
          width: 22, height: 27, border: '1px solid var(--border)', color: 'var(--text-dim)', background: 'transparent', fontSize: 13,
        }}>×</button>
      </React.Fragment>)}
    </div>}
    <button type="button" onClick={addRow} title="Add environment variable" style={{
      width: '100%', marginTop: rows.length ? 6 : 0, minHeight: 27, border: '1px solid var(--border)',
      background: 'transparent', color: 'var(--accent)', fontSize: 16, lineHeight: 1,
    }}>+</button>
  </div>
}

function PlannedDetail({ node }: { node: PlannedNode }) {
  const metadata = plannedMetadata(node)
  const updatePlanned = useSheetStore(s => s.updatePlanned)
  const { services, loaded, fetchRegistry } = useRegistryStore()
  const setInfraPickerNode = useGraphStore(s => s.setInfraPickerNode)
  const hasContainedNodes = useSheetStore(s => [
    ...s.planned.map(child => child.parentSystemId),
    ...s.elements.map(child => child.parentSystemId),
  ].includes(`planned:${node.id}`))
  React.useEffect(() => { if (!loaded) void fetchRegistry() }, [loaded, fetchRegistry])
  const update = (patch: Partial<PlannedNode>, metadataPatch?: Partial<PlannedNodeMetadata>) => {
    void updatePlanned(node.workspaceId, {
      ...node, ...patch,
      metadata: metadataPatch ? { ...metadata, ...metadataPatch, version: 1 } : node.metadata,
    })
  }
  const service = metadata.service ? services.find(item => item.id === metadata.service) : undefined
  const config = metadata.config ?? {}

  return <>
    <InspectorText label="NAME" value={node.name} onCommit={name => update({ name })} />
    {(node.kind === 'class' || node.kind === 'file') && <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', letterSpacing: '0.08em', marginBottom: 5 }}>LANGUAGE</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <LanguagePicker value={metadata.language ?? ''} onChange={language => {
          const name = node.kind === 'file' ? filenameForLanguage(node.name, language) : node.name
          update({ name, declaredPath: node.kind === 'file' ? name : '' }, { language })
        }} />
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{metadata.language || 'Choose language'}</span>
      </div>
    </div>}
    {node.kind === 'class' && <>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
        <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', letterSpacing: '0.08em' }}>CLASS KIND</span>
        <select className="glass-input" value={metadata.classKind ?? 'class'} onChange={event => update({}, { classKind: event.target.value as PlannedNodeMetadata['classKind'] })}>
          <option value="class">Class</option><option value="interface">Interface</option><option value="abstract">Abstract class</option>
        </select>
      </label>
      <InspectorText label="ROLE (OPTIONAL)" value={metadata.role ?? ''} onCommit={role => update({}, { role })} />
    </>}
    <InspectorText label="DESCRIPTION (OPTIONAL)" value={metadata.description ?? ''} multiline onCommit={description => update({}, { description })} />

    {(node.kind === 'class' || node.kind === 'service') && <Section title="Detailed structure">
      <div style={{ border: '1px solid var(--border-dim)', padding: 8 }}>
        <UmlMetadataPanel kind={node.kind} metadata={metadata} editable onChange={next => update({}, next)} />
      </div>
    </Section>}

    {node.kind === 'infra' && <>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
        <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', letterSpacing: '0.08em' }}>INFRASTRUCTURE</span>
        <div style={{ border: '1px solid var(--border)', background: 'var(--bg-raised)', padding: '9px 10px' }}>
          <div style={{ color: 'var(--text-primary)', fontSize: 11, fontWeight: 700 }}>{service?.name ?? 'Not assigned'}</div>
          {service && <div style={{ color: 'var(--text-dim)', fontSize: 9, marginTop: 3, textTransform: 'capitalize' }}>
            {service.provider} · {service.category}{service.subtype ? ` / ${service.subtype}` : ''}
          </div>}
        </div>
        <button type="button" onClick={() => setInfraPickerNode(node.id)} style={{
          border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', padding: '7px 9px', fontSize: 10,
        }}>{service ? 'Change infrastructure…' : 'Choose infrastructure…'}</button>
        {hasContainedNodes && <span style={{ fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.4 }}>
          This node contains hosted elements, so it can only be reassigned to other container-capable infrastructure.
        </span>}
      </label>
      {service?.configFields?.map(field => <InspectorText key={field} label={field.toUpperCase()} value={config[field] ?? ''}
        onCommit={value => update({}, { config: { ...config, [field]: value } })} />)}
      {(metadata.capabilities?.includes('environment') || metadata.category === 'platform') && <KeyValueEditor
        label="ENVIRONMENT VARIABLES" value={metadata.environmentVariables ?? {}}
        onChange={environmentVariables => update({}, { environmentVariables })} />}
      {(metadata.capabilities?.includes('schema') || metadata.category === 'database') && <InspectorText label="TABLES / COLLECTIONS (ONE PER LINE)"
        value={(metadata.tables ?? []).map(table => table.schema ? `${table.name}: ${table.schema}` : table.name).join('\n')} multiline
        onCommit={value => update({}, { tables: value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
          const [name, ...schema] = line.split(':'); return { name: name.trim(), schema: schema.join(':').trim() || undefined }
        }) })} />}
    </>}
  </>
}

function FileDetail({ file, systems, dependencies, setSelectedNode }: {
  file: DbFile
  systems: DbSystem[]
  dependencies: DbDependency[]
  setSelectedNode: (id: string | null) => void
}) {
  const filename = file.relPath.split('/').pop() ?? file.relPath
  const parentSystem = systems.find(s => s.id === file.systemId)
  const churn = file.churnScore ?? 0

  const outDeps = dependencies.filter(d => d.src === file.id && d.srcType === 'file')
  const inDeps = dependencies.filter(d => d.dst === file.id && d.dstType === 'file')

  const openFile = () => {
    if (window.axiom) window.axiom.showInFolder(file.path)
  }

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', wordBreak: 'break-word', fontFamily: 'monospace' }}>
          {filename}
        </div>
        <button
          onClick={openFile}
          style={{ marginTop: 4, fontSize: 10, color: 'var(--text-dim)', textAlign: 'left', wordBreak: 'break-all' }}
          title="Show in folder"
        >
          {file.relPath}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        <Stat label="Language" value={file.language} />
        {file.lineCount > 0 && <Stat label="Lines" value={String(file.lineCount)} />}
        {churn > 0 && <Stat label="Churn" value={`${Math.round(churn * 100)}%`} warn={churn > 0.7} />}
        {parentSystem && <Stat label="System" value={parentSystem.name} />}
      </div>

      {outDeps.length > 0 && (
        <DependencySection title={`Imports (${outDeps.length})`} dependencies={outDeps} direction="out" onClick={setSelectedNode} />
      )}
      {inDeps.length > 0 && (
        <DependencySection title={`Imported by (${inDeps.length})`} dependencies={inDeps} direction="in" onClick={setSelectedNode} />
      )}
    </>
  )
}

function SystemDetail({ system, files, systems }: {
  system: DbSystem
  files: DbFile[]
  systems: DbSystem[]
}) {
  const childFiles = files.filter(f => f.systemId === system.id)
  const childSystems = systems.filter(s => s.parentId === system.id)
  const parent = systems.find(s => s.id === system.parentId)

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
          {system.name}
        </div>
        {system.description && (
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {system.description}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        <Stat label="Files" value={String(childFiles.length)} />
        {childSystems.length > 0 && <Stat label="Subsystems" value={String(childSystems.length)} />}
        <Stat label="Source" value={system.source} />
        {parent && <Stat label="Parent" value={parent.name} />}
      </div>

      {system.agentNotes && (
        <Section title="Agent Notes">
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {system.agentNotes}
          </div>
        </Section>
      )}
    </>
  )
}

function DependencySection({ title, dependencies, direction, onClick }: {
  title: string
  dependencies: DbDependency[]
  direction: 'in' | 'out'
  onClick: (id: string) => void
}) {
  const shown = dependencies.slice(0, 10)
  return (
    <Section title={title}>
      {shown.map(d => (
        <div
          key={d.id}
          onClick={() => onClick(direction === 'out' ? d.dst : d.src)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 6px', borderRadius: 0, cursor: 'pointer', marginBottom: 2,
          }}
          onMouseEnter={ev => (ev.currentTarget.style.background = 'var(--bg-raised)')}
          onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}
        >
          <span style={{ fontSize: 9, color: 'var(--color-file, #3b82f6)', fontWeight: 600 }}>
            {direction === 'out' ? '→' : '←'} {d.dependencyType}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {direction === 'out' ? d.dst : d.src}
          </span>
        </div>
      ))}
      {dependencies.length > 10 && (
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
          +{dependencies.length - 10} more
        </div>
      )}
    </Section>
  )
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ background: 'var(--bg-raised)', borderRadius: 0, padding: '6px 10px' }}>
      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: warn ? 'var(--warn)' : 'var(--text-primary)' }}>
        {value}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', marginBottom: 8, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
        {title}
      </div>
      {children}
    </div>
  )
}
