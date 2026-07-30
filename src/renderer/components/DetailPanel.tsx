import React from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { DbDependency, DbFile, DbSystem } from '../../shared/types'
import { apiUpdateSystem } from '../canvas/arcdApi'
import { filenameForLanguage, LanguagePicker } from '../canvas/languages'
import { UmlMetadataPanel } from '../canvas/nodes/UmlMetadataPanel'
import { useGraphStore } from '../store/graphStore'
import { useRegistryStore } from '../store/registryStore'
import {
  plannedMetadata,
  useSheetStore,
  type PlannedNode,
  type PlannedNodeMetadata,
} from '../store/sheetStore'

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

  const file = files.find(candidate => candidate.id === inspectedNodeId)
  const system = !file ? systems.find(candidate => candidate.id === inspectedNodeId) : undefined
  const infra = !file && !system ? infraNodes.find(candidate => candidate.id === inspectedNodeId) : undefined
  const planned = inspectedNodeId.startsWith('planned:')
    ? plannedNodes.find(node => node.id === inspectedNodeId.slice('planned:'.length))
    : undefined

  if (!file && !system && !infra && !planned) return null

  const typeLabel = planned
    ? `Planned ${planned.kind.replace('_', ' ')}`
    : file
      ? 'File'
      : system
        ? 'System'
        : 'Infrastructure'

  return (
    <aside
      className="axiom-detail-panel"
      aria-label={`${typeLabel} properties`}
      data-inspected-node-id={inspectedNodeId}
    >
      <header className="axiom-detail-panel__titlebar">
        <span>Properties</span>
        <span className="axiom-detail-panel__type">{typeLabel}</span>
        <button
          type="button"
          className="axiom-detail-panel__close"
          aria-label="Close properties"
          onClick={() => setInspectedNode(null)}
        >
          ×
        </button>
      </header>

      <div className="axiom-detail-panel__body">
        {planned && <PlannedDetail node={planned} />}
        {file && !planned && (
          <FileDetail
            file={file}
            systems={systems}
            dependencies={dependencies}
            setSelectedNode={id => {
              setSelectedNode(id)
              setInspectedNode(id)
            }}
          />
        )}
        {system && <SystemDetail system={system} files={files} systems={systems} />}
        {infra && (
          <>
            <InspectorIdentity
              kicker="Selected infrastructure"
              name={infra.name}
              detail={[infra.provider, infra.category].filter(Boolean).join(' · ')}
            />
            <Section title="General">
              <div className="axiom-inspector-properties">
                <Stat label="Type" value={infra.infraType} />
                {infra.subtype && <Stat label="Subtype" value={infra.subtype} />}
                {infra.status && <Stat label="Status" value={infra.status} />}
              </div>
            </Section>
          </>
        )}
      </div>
    </aside>
  )
}

function InspectorIdentity({
  kicker,
  name,
  detail,
}: {
  kicker: string
  name: string
  detail?: React.ReactNode
}) {
  return (
    <div className="axiom-detail-panel__identity">
      <div className="axiom-detail-panel__kicker">{kicker}</div>
      <h2>{name}</h2>
      {detail && <div className="axiom-detail-panel__identity-detail">{detail}</div>}
    </div>
  )
}

function InspectorText({
  label,
  value,
  multiline,
  onCommit,
}: {
  label: string
  value: string
  multiline?: boolean
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = React.useState(value)
  React.useEffect(() => setDraft(value), [value])
  const common = {
    value: draft,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(event.target.value),
    onBlur: () => {
      if (draft !== value) onCommit(draft)
    },
    className: 'axiom-inspector-input',
  }

  return (
    <label className="axiom-inspector-field">
      <span className="axiom-inspector-field__label">{label}</span>
      {multiline ? <textarea {...common} rows={3} /> : <input {...common} />}
    </label>
  )
}

interface KeyValueRow {
  id: number
  key: string
  value: string
}

function KeyValueEditor({
  label,
  value,
  onChange,
}: {
  label: string
  value: Record<string, string>
  onChange: (value: Record<string, string>) => void
}) {
  const nextId = React.useRef(0)
  const toRows = React.useCallback((record: Record<string, string>): KeyValueRow[] =>
    Object.entries(record).map(([key, entryValue]) => ({
      id: nextId.current++,
      key,
      value: entryValue,
    })), [])
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
  const addRow = () => {
    setRows(current => [...current, { id: nextId.current++, key: '', value: '' }])
  }

  return (
    <div className="axiom-inspector-field">
      <div className="axiom-inspector-field__label">{label}</div>
      {rows.length > 0 && (
        <div className="axiom-inspector-key-values">
          <span>Key</span>
          <span>Value</span>
          <span />
          {rows.map((row, index) => (
            <React.Fragment key={row.id}>
              <input
                autoFocus={index === rows.length - 1 && !row.key}
                className="axiom-inspector-input axiom-inspector-input--mono"
                value={row.key}
                placeholder="VARIABLE_NAME"
                onChange={event => updateRow(row.id, 'key', event.target.value)}
                onBlur={() => commit(rows)}
              />
              <input
                className="axiom-inspector-input axiom-inspector-input--mono"
                value={row.value}
                placeholder="value"
                onChange={event => updateRow(row.id, 'value', event.target.value)}
                onBlur={() => commit(rows)}
              />
              <button
                type="button"
                className="axiom-inspector-icon-button"
                aria-label={`Remove ${row.key || 'environment variable'}`}
                onClick={() => removeRow(row.id)}
              >
                ×
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
      <button
        type="button"
        className="axiom-inspector-add-button"
        onClick={addRow}
        title="Add environment variable"
      >
        <span aria-hidden="true">+</span> Add variable
      </button>
    </div>
  )
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

  React.useEffect(() => {
    if (!loaded) void fetchRegistry()
  }, [loaded, fetchRegistry])

  const update = (patch: Partial<PlannedNode>, metadataPatch?: Partial<PlannedNodeMetadata>) => {
    void updatePlanned(node.workspaceId, {
      ...node,
      ...patch,
      metadata: metadataPatch ? { ...metadata, ...metadataPatch, version: 1 } : node.metadata,
    })
  }
  const service = metadata.service ? services.find(item => item.id === metadata.service) : undefined
  const config = metadata.config ?? {}

  return (
    <>
      <InspectorIdentity
        kicker={`Planned ${node.kind.replace('_', ' ')}`}
        name={node.name}
        detail="Overlay-authored architecture element"
      />
      <div className="axiom-inspector-form">
        <InspectorText label="NAME" value={node.name} onCommit={name => update({ name })} />

        {(node.kind === 'class' || node.kind === 'file') && (
          <div className="axiom-inspector-field">
            <div className="axiom-inspector-field__label">LANGUAGE</div>
            <div className="axiom-inspector-language">
              <LanguagePicker
                value={metadata.language ?? ''}
                onChange={language => {
                  const name = node.kind === 'file' ? filenameForLanguage(node.name, language) : node.name
                  update({ name, declaredPath: node.kind === 'file' ? name : '' }, { language })
                }}
              />
              <span>{metadata.language || 'Choose language'}</span>
            </div>
          </div>
        )}

        {node.kind === 'class' && (
          <>
            <label className="axiom-inspector-field">
              <span className="axiom-inspector-field__label">CLASS KIND</span>
              <select
                className="axiom-inspector-input"
                value={metadata.classKind ?? 'class'}
                onChange={event => update({}, { classKind: event.target.value as PlannedNodeMetadata['classKind'] })}
              >
                <option value="class">Class</option>
                <option value="interface">Interface</option>
                <option value="abstract">Abstract class</option>
              </select>
            </label>
            <InspectorText label="ROLE (OPTIONAL)" value={metadata.role ?? ''} onCommit={role => update({}, { role })} />
          </>
        )}

        <InspectorText
          label="DESCRIPTION (OPTIONAL)"
          value={metadata.description ?? ''}
          multiline
          onCommit={description => update({}, { description })}
        />

        {(node.kind === 'class' || node.kind === 'service') && (
          <Section title="Detailed structure">
            <div className="axiom-inspector-uml-frame">
              <UmlMetadataPanel
                kind={node.kind}
                metadata={metadata}
                editable
                onChange={next => update({}, next)}
              />
            </div>
          </Section>
        )}

        {node.kind === 'infra' && (
          <>
            <div className="axiom-inspector-field">
              <div className="axiom-inspector-field__label">INFRASTRUCTURE</div>
              <div className="axiom-inspector-service">
                <strong>{service?.name ?? 'Not assigned'}</strong>
                {service && (
                  <span>
                    {service.provider} · {service.category}{service.subtype ? ` / ${service.subtype}` : ''}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="axiom-inspector-command"
                onClick={() => setInfraPickerNode(node.id)}
              >
                {service ? 'Change infrastructure…' : 'Choose infrastructure…'}
              </button>
              {hasContainedNodes && (
                <span className="axiom-inspector-help">
                  This node contains hosted elements, so it can only be reassigned to other container-capable infrastructure.
                </span>
              )}
            </div>

            {service?.configFields?.map(field => (
              <InspectorText
                key={field}
                label={field.toUpperCase()}
                value={config[field] ?? ''}
                onCommit={value => update({}, { config: { ...config, [field]: value } })}
              />
            ))}

            {(metadata.capabilities?.includes('environment') || metadata.category === 'platform') && (
              <KeyValueEditor
                label="ENVIRONMENT VARIABLES"
                value={metadata.environmentVariables ?? {}}
                onChange={environmentVariables => update({}, { environmentVariables })}
              />
            )}

            {(metadata.capabilities?.includes('schema') || metadata.category === 'database') && (
              <InspectorText
                label="TABLES / COLLECTIONS (ONE PER LINE)"
                value={(metadata.tables ?? []).map(table =>
                  table.schema ? `${table.name}: ${table.schema}` : table.name
                ).join('\n')}
                multiline
                onCommit={value => update({}, {
                  tables: value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
                    const [name, ...schema] = line.split(':')
                    return { name: name.trim(), schema: schema.join(':').trim() || undefined }
                  }),
                })}
              />
            )}
          </>
        )}
      </div>
    </>
  )
}

function FileDetail({
  file,
  systems,
  dependencies,
  setSelectedNode,
}: {
  file: DbFile
  systems: DbSystem[]
  dependencies: DbDependency[]
  setSelectedNode: (id: string | null) => void
}) {
  const filename = file.relPath.split('/').pop() ?? file.relPath
  const parentSystem = systems.find(system => system.id === file.systemId)
  const churn = file.churnScore ?? 0
  const outDeps = dependencies.filter(dependency => dependency.src === file.id && dependency.srcType === 'file')
  const inDeps = dependencies.filter(dependency => dependency.dst === file.id && dependency.dstType === 'file')

  const openFile = () => {
    if (window.axiom) window.axiom.showInFolder(file.path)
  }

  return (
    <>
      <InspectorIdentity
        kicker="Selected source file"
        name={filename}
        detail={(
          <button type="button" className="axiom-detail-panel__path" onClick={openFile} title="Show in folder">
            {file.relPath}
          </button>
        )}
      />

      <Section title="General">
        <div className="axiom-inspector-properties">
          <Stat label="Language" value={file.language} />
          {file.lineCount > 0 && <Stat label="Lines" value={String(file.lineCount)} />}
          {churn > 0 && <Stat label="Churn" value={`${Math.round(churn * 100)}%`} warn={churn > 0.7} />}
          {parentSystem && <Stat label="System" value={parentSystem.name} />}
        </div>
      </Section>

      {outDeps.length > 0 && (
        <DependencySection
          title={`Imports (${outDeps.length})`}
          dependencies={outDeps}
          direction="out"
          onClick={setSelectedNode}
        />
      )}
      {inDeps.length > 0 && (
        <DependencySection
          title={`Imported by (${inDeps.length})`}
          dependencies={inDeps}
          direction="in"
          onClick={setSelectedNode}
        />
      )}
    </>
  )
}

function SystemDetail({
  system,
  files,
  systems,
}: {
  system: DbSystem
  files: DbFile[]
  systems: DbSystem[]
}) {
  const childFiles = files.filter(file => file.systemId === system.id)
  const childSystems = systems.filter(candidate => candidate.parentId === system.id)
  const parent = systems.find(candidate => candidate.id === system.parentId)
  const [confirming, setConfirming] = React.useState(false)
  const [confirmationError, setConfirmationError] = React.useState<string | null>(null)

  const confirmArchitecture = async () => {
    if (confirming || system.source !== 'cluster') return
    setConfirming(true)
    setConfirmationError(null)
    try {
      await apiUpdateSystem({ ...system, source: 'user' })
    } catch (error) {
      setConfirmationError(error instanceof Error ? error.message : 'Unable to confirm system')
    } finally {
      setConfirming(false)
    }
  }

  return (
    <>
      <InspectorIdentity
        kicker="Selected system"
        name={system.name}
        detail={system.description}
      />

      <Section title="General">
        <div className="axiom-inspector-properties">
          <Stat label="Files" value={String(childFiles.length)} />
          {childSystems.length > 0 && <Stat label="Subsystems" value={String(childSystems.length)} />}
          <Stat label="Source" value={system.source} />
          {parent && <Stat label="Parent" value={parent.name} />}
        </div>
      </Section>

      {system.source === 'cluster' && (
        <Section title="Architectural proposal">
          <div className="axiom-inspector-note">
            Axiom inferred this boundary from authored names, parsed symbols, dependencies, and co-change signals.
            Confirm it to protect this system from future automatic reclustering.
          </div>
          <button
            type="button"
            className="axiom-inspector-command"
            disabled={confirming}
            onClick={() => void confirmArchitecture()}
          >
            {confirming ? 'Confirming…' : 'Confirm as architecture'}
          </button>
          {confirmationError && (
            <div className="axiom-inspector-property__value--warn">{confirmationError}</div>
          )}
        </Section>
      )}

      {system.agentNotes && (
        <Section title="Agent notes">
          <div className="axiom-inspector-note">{system.agentNotes}</div>
        </Section>
      )}
    </>
  )
}

function DependencySection({
  title,
  dependencies,
  direction,
  onClick,
}: {
  title: string
  dependencies: DbDependency[]
  direction: 'in' | 'out'
  onClick: (id: string) => void
}) {
  const shown = dependencies.slice(0, 10)
  return (
    <Section title={title}>
      <div className="axiom-inspector-dependencies">
        {shown.map(dependency => {
          const target = direction === 'out' ? dependency.dst : dependency.src
          return (
            <button
              type="button"
              key={dependency.id}
              className="axiom-inspector-dependency"
              onClick={() => onClick(target)}
              title={target}
            >
              <span>{direction === 'out' ? '→' : '←'} {dependency.dependencyType}</span>
              <strong>{target}</strong>
            </button>
          )
        })}
        {dependencies.length > 10 && (
          <div className="axiom-inspector-more">+{dependencies.length - 10} more</div>
        )}
      </div>
    </Section>
  )
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="axiom-inspector-property">
      <span>{label}</span>
      <strong className={warn ? 'axiom-inspector-property__value--warn' : undefined}>{value}</strong>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="axiom-inspector-section">
      <h3>{title}</h3>
      <div className="axiom-inspector-section__body">{children}</div>
    </section>
  )
}
