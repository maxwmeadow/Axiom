import React from 'react'
import type { InfraService } from '../../shared/types'
import { brandIcon, CATEGORY_GLYPHS, officialServiceIcon } from '../canvas/nodes/infraIcons'
import { plannedMetadata, type PlannedNode, useSheetStore } from '../store/sheetStore'
import { useRegistryStore } from '../store/registryStore'
import { DialogButton, DialogError } from './ui/DialogPrimitives'

type GroupMode = 'type' | 'provider'
type QuickFilter = 'all' | 'hosting' | 'database' | 'storage' | 'messaging' | 'data' | 'integrations' | 'security' | 'observability'

type InfraPickerDialogProps =
  | {
      mode: 'assign'
      node: PlannedNode
      onClose: () => void
    }
  | {
      mode: 'create'
      onCreate: (service: InfraService, name: string) => Promise<void>
      onClose: () => void
    }

const TYPE_NAMES: Record<string, string> = {
  platform: 'Hosting & compute',
  database: 'Databases',
  storage: 'Storage',
  queue: 'Queues & messaging',
  cache: 'Caches',
  search: 'Search',
  api: 'External APIs',
  auth: 'Authentication',
  llm: 'AI & language models',
  cdn: 'CDN & delivery',
  observability: 'Observability',
  email: 'Email',
}

const QUICK_FILTERS: Array<{ id: QuickFilter; label: string; categories: string[] }> = [
  { id: 'all', label: 'All', categories: [] },
  { id: 'hosting', label: 'Hosting', categories: ['platform', 'cdn'] },
  { id: 'database', label: 'Database', categories: ['database'] },
  { id: 'storage', label: 'Storage', categories: ['storage'] },
  { id: 'messaging', label: 'Messaging', categories: ['queue', 'email'] },
  { id: 'data', label: 'Cache & search', categories: ['cache', 'search'] },
  { id: 'integrations', label: 'API & AI', categories: ['api', 'llm'] },
  { id: 'security', label: 'Auth', categories: ['auth'] },
  { id: 'observability', label: 'Observability', categories: ['observability'] },
]

function ServiceIcon({ service, size = 26 }: { service: InfraService; size?: number }) {
  const official = officialServiceIcon(service.id)
  if (official) return <img className="axiom-infra-picker__service-icon" src={official} width={size} height={size} alt="" />

  const icon = brandIcon(service.brand.icon)
  if (icon) {
    return (
      <svg className="axiom-infra-picker__service-icon" viewBox="0 0 24 24" width={size} height={size} aria-label={icon.title}>
        <path d={icon.path} fill={service.brand.darkColor ?? service.brand.color} />
      </svg>
    )
  }

  return (
    <svg className="axiom-infra-picker__service-icon" viewBox="0 0 24 24" width={size} height={size} aria-label={service.category}>
      <path
        d={CATEGORY_GLYPHS[service.category] ?? CATEGORY_GLYPHS.api}
        fill={service.brand.darkColor ?? service.brand.color ?? 'var(--text-secondary)'}
      />
    </svg>
  )
}

/**
 * The one infrastructure catalog used by every selection flow. Assign mode
 * updates an existing planned node immediately; create mode adds the naming
 * step and delegates persistence to its caller.
 */
export function InfraPickerDialog(props: InfraPickerDialogProps) {
  const [query, setQuery] = React.useState('')
  const [groupMode, setGroupMode] = React.useState<GroupMode>('type')
  const [quickFilter, setQuickFilter] = React.useState<QuickFilter>('all')
  const [selected, setSelected] = React.useState<InfraService | null>(null)
  const [name, setName] = React.useState('')
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const { services, loaded, fetchRegistry } = useRegistryStore()
  const updatePlanned = useSheetStore(s => s.updatePlanned)
  const containedParentId = props.mode === 'assign' ? `planned:${props.node.id}` : null
  const hasContainedNodes = useSheetStore(s => containedParentId !== null && [
    ...s.planned.map(child => child.parentSystemId),
    ...s.elements.map(child => child.parentSystemId),
  ].includes(containedParentId))

  React.useEffect(() => {
    if (!loaded) void fetchRegistry()
  }, [loaded, fetchRegistry])

  React.useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !creating) props.onClose()
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [creating, props.onClose])

  const normalized = query.trim().toLowerCase()
  const filterCategories = QUICK_FILTERS.find(filter => filter.id === quickFilter)?.categories ?? []
  const matches = services.filter(service =>
    (filterCategories.length === 0 || filterCategories.includes(service.category)) &&
    (!normalized || [service.name, service.provider, service.category, service.subtype, service.id]
      .some(value => value?.toLowerCase().includes(normalized))))
  const groups = new Map<string, InfraService[]>()
  for (const service of matches) {
    const key = groupMode === 'type' ? service.category : service.provider
    groups.set(key, [...(groups.get(key) ?? []), service])
  }
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => {
    const left = groupMode === 'type' ? TYPE_NAMES[a] ?? a : a
    const right = groupMode === 'type' ? TYPE_NAMES[b] ?? b : b
    return left.localeCompare(right)
  })

  const choose = (service: InfraService) => {
    if (hasContainedNodes && !service.capabilities?.includes('container')) return

    if (props.mode === 'create') {
      setSelected(service)
      setError(null)
      return
    }

    const metadata = plannedMetadata(props.node)
    const currentService = services.find(candidate => candidate.id === metadata.service)
    // Service-generated titles follow service changes. Once the user gives the
    // node an intentional name, infrastructure selection no longer owns it.
    const currentNameIsGenerated = /^NewInfra$/i.test(props.node.name) || currentService?.name === props.node.name
    void updatePlanned(props.node.workspaceId, {
      ...props.node,
      name: currentNameIsGenerated ? service.name : props.node.name,
      color: service.brand.darkColor ?? service.brand.color,
      metadata: {
        ...metadata,
        service: service.id,
        category: service.category,
        provider: service.provider,
        subtype: service.subtype ?? '',
        capabilities: service.capabilities ?? [],
        config: {},
      },
    }).then(props.onClose)
  }

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    if (props.mode !== 'create') return
    if (!selected) {
      setError('Pick a service')
      return
    }

    setCreating(true)
    setError(null)
    try {
      await props.onCreate(selected, name.trim() || selected.name)
      props.onClose()
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Failed to create infrastructure node')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div
      className="axiom-infra-picker nodrag nopan nowheel"
      role="dialog"
      aria-modal="true"
      aria-label="Choose infrastructure"
      onPointerDown={event => event.stopPropagation()}
      onWheel={event => event.stopPropagation()}
    >
      <div className="axiom-infra-picker__window">
        <header className="axiom-infra-picker__header">
          <div className="axiom-infra-picker__heading">
            <h2>Choose infrastructure</h2>
            <p>
              {props.mode === 'create'
                ? 'Add a service, platform, or infrastructure resource'
                : 'Assign behavior, metadata, and visual identity'}
            </p>
          </div>
          <input
            autoFocus
            aria-label="Search infrastructure catalog"
            className="axiom-infra-picker__search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search services, providers, or infrastructure types…"
          />
          <button
            type="button"
            className="axiom-infra-picker__close"
            aria-label="Close infrastructure picker"
            onClick={props.onClose}
            disabled={creating}
          >
            ×
          </button>
        </header>

        <div className="axiom-infra-picker__filters">
          <div className="axiom-infra-picker__filter-row">
            <span className="axiom-infra-picker__filter-label">Show</span>
            {QUICK_FILTERS.map(filter => (
              <button
                key={filter.id}
                type="button"
                className="axiom-infra-picker__filter-button"
                aria-pressed={quickFilter === filter.id}
                onClick={() => setQuickFilter(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>

          <div className="axiom-infra-picker__filter-row">
            <span className="axiom-infra-picker__filter-label">Group results</span>
            {(['type', 'provider'] as GroupMode[]).map(mode => (
              <button
                key={mode}
                type="button"
                className="axiom-infra-picker__filter-button"
                aria-pressed={groupMode === mode}
                onClick={() => setGroupMode(mode)}
              >
                {mode === 'type' ? 'Infrastructure type' : 'Provider'}
              </button>
            ))}
            <output className="axiom-infra-picker__result-count">{matches.length} services</output>
          </div>
        </div>

        <div className="axiom-infra-picker__catalog">
          {!loaded && <div className="axiom-infra-picker__empty">Loading infrastructure registry…</div>}
          {loaded && matches.length === 0 && <div className="axiom-infra-picker__empty">No infrastructure matches “{query}”.</div>}
          {sortedGroups.map(([group, items]) => (
            <section className="axiom-infra-picker__group" key={group}>
              <h3 className="axiom-infra-picker__group-title">
                {groupMode === 'type' ? TYPE_NAMES[group] ?? group : group}
              </h3>
              <div className="axiom-infra-picker__service-grid">
                {[...items].sort((a, b) => a.name.localeCompare(b.name)).map(service => {
                  const incompatible = hasContainedNodes && !service.capabilities?.includes('container')
                  const isSelected = props.mode === 'create' && selected?.id === service.id
                  return (
                    <button
                      key={service.id}
                      type="button"
                      className="axiom-infra-picker__service"
                      aria-pressed={isSelected}
                      data-incompatible={incompatible || undefined}
                      disabled={incompatible}
                      onClick={() => choose(service)}
                      title={incompatible ? 'This node contains hosted elements and must remain container-capable' : undefined}
                      style={{ '--axiom-infra-service-accent': service.brand.darkColor ?? service.brand.color } as React.CSSProperties}
                    >
                      <ServiceIcon service={service} />
                      <span className="axiom-infra-picker__service-copy">
                        <strong>{service.name}</strong>
                        <span>
                          {service.provider} · {TYPE_NAMES[service.category] ?? service.category}{service.subtype ? ` / ${service.subtype}` : ''}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
        </div>

        {props.mode === 'create' && (
          <form
            className="axiom-infra-picker__footer"
            onSubmit={handleCreate}
          >
            <label className="axiom-infra-picker__name-field">
              <span>
                Name <small>optional — defaults to the service name</small>
              </span>
              <input
                className="axiom-infra-picker__name-input"
                value={name}
                onChange={event => setName(event.target.value)}
                placeholder={selected ? `e.g. "Primary ${selected.name}"` : 'Select a service first'}
                disabled={creating}
              />
            </label>
            <div className="axiom-infra-picker__footer-actions">
              {error && <DialogError>{error}</DialogError>}
              <div className="axiom-infra-picker__buttons">
                <DialogButton type="button" onClick={props.onClose} disabled={creating} variant="secondary">
                  Cancel
                </DialogButton>
                <DialogButton type="submit" disabled={creating || !selected} disabledOpacity={0.6} variant="primary">
                  {creating ? 'Adding…' : 'Add to Canvas'}
                </DialogButton>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
