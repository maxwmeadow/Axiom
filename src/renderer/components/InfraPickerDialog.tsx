import React from 'react'
import type { InfraService } from '../../shared/types'
import { brandIcon, CATEGORY_GLYPHS, officialServiceIcon } from '../canvas/nodes/infraIcons'
import { plannedMetadata, type PlannedNode, useSheetStore } from '../store/sheetStore'
import { useRegistryStore } from '../store/registryStore'

type GroupMode = 'type' | 'provider'
type QuickFilter = 'all' | 'hosting' | 'database' | 'storage' | 'messaging' | 'data' | 'integrations' | 'security' | 'observability'

const TYPE_NAMES: Record<string, string> = {
  platform: 'Hosting & compute', database: 'Databases', storage: 'Storage', queue: 'Queues & messaging',
  cache: 'Caches', search: 'Search', api: 'External APIs', auth: 'Authentication', llm: 'AI & language models',
  cdn: 'CDN & delivery', observability: 'Observability', email: 'Email',
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
  if (official) return <img src={official} width={size} height={size} alt="" style={{ flexShrink: 0 }} />
  const icon = brandIcon(service.brand.icon)
  if (icon) return <svg viewBox="0 0 24 24" width={size} height={size} aria-label={icon.title} style={{ flexShrink: 0 }}>
    <path d={icon.path} fill={service.brand.darkColor ?? service.brand.color} />
  </svg>
  return <svg viewBox="0 0 24 24" width={size} height={size} aria-label={service.category} style={{ flexShrink: 0 }}>
    <path d={CATEGORY_GLYPHS[service.category] ?? CATEGORY_GLYPHS.api} fill={service.brand.darkColor ?? service.brand.color ?? 'var(--text-secondary)'} />
  </svg>
}

export function InfraPickerDialog({ node, onClose }: { node: PlannedNode; onClose: () => void }) {
  const [query, setQuery] = React.useState('')
  const [groupMode, setGroupMode] = React.useState<GroupMode>('type')
  const [quickFilter, setQuickFilter] = React.useState<QuickFilter>('all')
  const { services, loaded, fetchRegistry } = useRegistryStore()
  const updatePlanned = useSheetStore(s => s.updatePlanned)
  const hasContainedNodes = useSheetStore(s => [
    ...s.planned.map(child => child.parentSystemId),
    ...s.elements.map(child => child.parentSystemId),
  ].includes(`planned:${node.id}`))
  React.useEffect(() => { if (!loaded) void fetchRegistry() }, [loaded, fetchRegistry])
  React.useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])

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
    const metadata = plannedMetadata(node)
    const currentService = services.find(candidate => candidate.id === metadata.service)
    // Service-generated titles follow service changes. Once the user gives the
    // node an intentional name, infrastructure selection no longer owns it.
    const currentNameIsGenerated = /^NewInfra$/i.test(node.name) || currentService?.name === node.name
    void updatePlanned(node.workspaceId, {
      ...node,
      name: currentNameIsGenerated ? service.name : node.name,
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
    }).then(onClose)
  }

  return <div className="nodrag nopan" role="dialog" aria-modal="true" aria-label="Choose infrastructure"
    onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} style={{
      position: 'absolute', inset: 0, zIndex: 5000, background: 'rgba(6, 8, 12, 0.88)',
      backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28,
    }}>
    <div style={{
      width: 'min(940px, 92%)', height: 'min(720px, 88%)', minHeight: 420,
      background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-card)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 14, alignItems: 'center' }}>
        <div style={{ minWidth: 190 }}>
          <div style={{ color: 'var(--text-primary)', fontSize: 17, fontWeight: 700 }}>Choose infrastructure</div>
          <div style={{ color: 'var(--text-dim)', fontSize: 10, marginTop: 3 }}>Assign behavior, metadata, and visual identity</div>
        </div>
        <input autoFocus className="glass-input" value={query} onChange={event => setQuery(event.target.value)}
          placeholder="Search services, providers, or infrastructure types…" style={{ flex: 1, padding: '9px 11px', fontSize: 12 }} />
        <button onClick={onClose} style={{ color: 'var(--text-secondary)', fontSize: 20, padding: 5 }}>×</button>
      </div>
      <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--border-dim)', display: 'flex', flexDirection: 'column', gap: 9 }}>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ color: 'var(--text-dim)', fontSize: 8, fontWeight: 800, letterSpacing: '0.08em', marginRight: 3 }}>SHOW</span>
          {QUICK_FILTERS.map(filter => <button key={filter.id} onClick={() => setQuickFilter(filter.id)} style={{
            padding: '5px 8px', border: `1px solid ${quickFilter === filter.id ? 'var(--accent)' : 'var(--border)'}`,
            color: quickFilter === filter.id ? 'var(--accent)' : 'var(--text-secondary)',
            background: quickFilter === filter.id ? 'var(--bg-raised)' : 'transparent', fontSize: 9, fontWeight: 700,
          }}>{filter.label}</button>)}
        </div>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <span style={{ color: 'var(--text-dim)', fontSize: 8, fontWeight: 800, letterSpacing: '0.08em', marginRight: 3 }}>GROUP RESULTS</span>
          {(['type', 'provider'] as GroupMode[]).map(mode => <button key={mode} onClick={() => setGroupMode(mode)} style={{
            padding: '5px 8px', border: `1px solid ${groupMode === mode ? 'var(--accent)' : 'var(--border)'}`,
            color: groupMode === mode ? 'var(--accent)' : 'var(--text-secondary)', background: groupMode === mode ? 'var(--bg-raised)' : 'transparent',
            fontSize: 9, fontWeight: 700,
          }}>{mode === 'type' ? 'Infrastructure type' : 'Provider'}</button>)}
          <span style={{ marginLeft: 'auto', color: 'var(--text-dim)', fontSize: 10 }}>{matches.length} services</span>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 24px' }}>
        {!loaded && <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>Loading infrastructure registry…</div>}
        {loaded && matches.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>No infrastructure matches “{query}”.</div>}
        {sortedGroups.map(([group, items]) => <section key={group} style={{ marginBottom: 22 }}>
          <div style={{ color: 'var(--text-secondary)', fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>
            {groupMode === 'type' ? TYPE_NAMES[group] ?? group : group}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 8 }}>
            {items.sort((a, b) => a.name.localeCompare(b.name)).map(service => {
              const incompatible = hasContainedNodes && !service.capabilities?.includes('container')
              return <button key={service.id} disabled={incompatible} onClick={() => choose(service)} title={incompatible ? 'This node contains hosted elements and must remain container-capable' : undefined} style={{
              minHeight: 68, display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', padding: '11px 12px',
              border: '1px solid var(--border)', background: 'var(--bg-raised)', color: 'var(--text-primary)', cursor: 'pointer',
              opacity: incompatible ? 0.35 : 1,
            }} onMouseEnter={event => { event.currentTarget.style.borderColor = service.brand.darkColor ?? service.brand.color }}
              onMouseLeave={event => { event.currentTarget.style.borderColor = 'var(--border)' }}>
              <ServiceIcon service={service} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 11, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{service.name}</span>
                <span style={{ display: 'block', marginTop: 3, fontSize: 9, color: 'var(--text-dim)', textTransform: 'capitalize' }}>
                  {service.provider} · {TYPE_NAMES[service.category] ?? service.category}{service.subtype ? ` / ${service.subtype}` : ''}
                </span>
              </span>
            </button>})}
          </div>
        </section>)}
      </div>
    </div>
  </div>
}
