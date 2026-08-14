import { useEffect, useState } from 'react'
import type { ProjectConfig } from '../../shared/types'
import { clearProjectLocalState } from '../projectLocalState'
import { AxiomMark, WorkbenchTitleBar } from '../components/ui/WorkbenchTitleBar'

interface HomeScreenProps {
  onOpenProject: (config: ProjectConfig) => void
  onOpenDialog: () => void
  onCreateProject: (config: ProjectConfig) => void
}

interface CommandDeckStatus {
  workspaceId: string
  indexed: boolean
  files: number
  systems: number
  unreviewedClaims: number
  unexplained: number
  unexpected: number
  activeWork: Array<{ id: string; agent?: string; goal: string; startedAt: number }>
  openPlans: number
  pendingProposals: number
  lastActivityAt: number
}

const WORKBENCH_CAPABILITIES = [
  { index: '01', title: 'Live source model', detail: 'The map follows the repository as agents rewrite it.' },
  { index: '02', title: 'Semantic zoom', detail: 'Move from systems to symbols without changing tools.' },
  { index: '03', title: 'Draw → dispatch → build', detail: 'Design what should exist; watch the agent fill it in.' },
] as const

// Mirror of the folder-name sanitiser in main.ts, for the live path preview.
function safeFolderName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
}

export function HomeScreen({ onOpenProject, onOpenDialog, onCreateProject }: HomeScreenProps) {
  const [recentProjects, setRecentProjects] = useState<ProjectConfig[]>([])
  const [deckStatus, setDeckStatus] = useState<Record<string, CommandDeckStatus>>({})
  const [removingProjectId, setRemovingProjectId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)

  // New Project flow
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newLocation, setNewLocation] = useState<string | null>(null)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    if (window.axiom) {
      void window.axiom.listRecentProjects()
        .then(async projects => {
          if (!active) return
          setRecentProjects(projects)
          const statuses = await Promise.all(projects.slice(0, 6).map(async project => {
            try {
              const response = await fetch(
                `http://127.0.0.1:7743/api/command-deck?workspace=${encodeURIComponent(project.id)}`,
              )
              if (!response.ok) return null
              return await response.json() as CommandDeckStatus
            } catch {
              return null
            }
          }))
          if (!active) return
          setDeckStatus(Object.fromEntries(
            statuses.filter((status): status is CommandDeckStatus => Boolean(status))
              .map(status => [status.workspaceId, status]),
          ))
        })
        .catch(() => { if (active) setRecentProjects([]) })
    }
    return () => { active = false }
  }, [])

  const removeProject = async (projectId: string) => {
    if (!window.axiom) return
    setRemovingProjectId(projectId)
    setRemoveError(null)
    try {
      await window.axiom.removeProject(projectId)
      // Deleting is deleting. The database goes with the project; so does every
      // local hint keyed to it, or reopening the same folder later inherits
      // "you already reviewed this" from a workspace that no longer exists.
      clearProjectLocalState(projectId)
      setRecentProjects(previous => previous.filter(project => project.id !== projectId))
    } catch (error) {
      setRemoveError(error instanceof Error
        ? error.message
        : 'Axiom could not delete this project. Nothing was removed from the project list.')
    } finally {
      setRemovingProjectId(null)
    }
  }

  const openDialog = () => {
    if (window.axiom) { onOpenDialog(); return }
    // Browser demo fallback
    onOpenProject({
      id: 'demo', name: 'Demo Project', rootPath: '/demo', ignoredPaths: [],
      languageOverrides: {}, layoutPreferences: { zoom: 0.5, panX: 0, panY: 0 }, openedAt: Date.now(),
    })
  }

  const startNew = () => {
    if (!window.axiom) {
      onCreateProject({
        id: 'demo-new', name: 'Untitled Model', rootPath: '/demo-new', ignoredPaths: [],
        languageOverrides: {}, layoutPreferences: { zoom: 1, panX: 0, panY: 0 }, openedAt: Date.now(),
      })
      return
    }
    setNewName(''); setNewLocation(null); setCreateError(null); setCreating(true)
  }

  const chooseLocation = async () => {
    if (!window.axiom) return
    const dir = await window.axiom.chooseDirectory()
    if (dir) { setNewLocation(dir); setCreateError(null) }
  }

  const confirmCreate = async () => {
    if (!window.axiom || !newLocation || !safeFolderName(newName)) return
    setCreateBusy(true); setCreateError(null)
    try {
      const config = await window.axiom.createProject(newLocation, newName)
      onCreateProject(config)
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Could not create the project.')
      setCreateBusy(false)
    }
  }

  const safeName = safeFolderName(newName)
  const canCreate = !!newLocation && !!safeName && !createBusy

  return (
    <main className="axiom-launcher">
      <WorkbenchTitleBar className="axiom-launcher__titlebar" context="Project Navigator" status="READY" />

      <div className="axiom-launcher__body">
        <section className="axiom-launcher__introduction" aria-labelledby="axiom-launcher-title">
          <div className="axiom-launcher__eyebrow">SOFTWARE ARCHITECTURE / WORKBENCH</div>
          <AxiomMark />
          <h1 id="axiom-launcher-title">Axiom</h1>
          <p className="axiom-launcher__statement">
            Map the system you have.<br />
            Build the system you intend.
          </p>
          <p className="axiom-launcher__description">
            A living architecture environment wired to your source. Start a fresh model or open an existing
            codebase — then watch the Floor stay true as you and your agents build.
          </p>

          <ol className="axiom-launcher__capabilities">
            {WORKBENCH_CAPABILITIES.map(capability => (
              <li key={capability.index}>
                <span>{capability.index}</span>
                <div>
                  <strong>{capability.title}</strong>
                  <p>{capability.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="axiom-launcher__workspace" aria-labelledby="axiom-workspace-title">
          <div className="axiom-launcher__workspace-heading">
            <span>START</span>
            <div>
              <h2 id="axiom-workspace-title">Command Deck</h2>
              <p>See what changed, what agents are doing, and what intent is still open — then enter the map.</p>
            </div>
          </div>

          <div className="axiom-launcher__forks">
            <button className="axiom-launcher__fork axiom-launcher__fork--new" onClick={startNew}>
              <span className="axiom-launcher__fork-glyph" aria-hidden="true">＋</span>
              <span className="axiom-launcher__fork-copy">
                <strong>New Project</strong>
                <small>Create an empty workspace and build it live with an agent.</small>
              </span>
              <span className="axiom-launcher__fork-arrow" aria-hidden="true">→</span>
            </button>

            <button className="axiom-launcher__fork axiom-launcher__fork--open" onClick={openDialog}>
              <span className="axiom-launcher__fork-glyph" aria-hidden="true">▤</span>
              <span className="axiom-launcher__fork-copy">
                <strong>Open Codebase</strong>
                <small>Index an existing repository into a living architecture map.</small>
              </span>
              <span className="axiom-launcher__fork-arrow" aria-hidden="true">→</span>
            </button>
          </div>

          {recentProjects.length > 0 && (
            <div className="axiom-launcher__recent">
              <div className="axiom-launcher__section-label">
                <span>RECENTLY OPENED</span>
                <small>{recentProjects.slice(0, 6).length} PROJECTS</small>
              </div>
              {removeError && (
                <div className="axiom-launcher__remove-error" role="alert">{removeError}</div>
              )}
              <ul>
                {recentProjects.slice(0, 6).map(project => (
                  <li key={project.id}>
                    <button
                      className="axiom-launcher__recent-open"
                      onClick={() => onOpenProject(project)}
                      aria-label={`Open ${project.name}`}
                    >
                      <span className="axiom-launcher__project-index" aria-hidden="true">◆</span>
                      <span className="axiom-launcher__project-copy">
                        <strong>{project.name}</strong>
                        <small title={project.rootPath}>{project.rootPath}</small>
                        <ProjectDeckSignals status={deckStatus[project.id]} />
                      </span>
                      <time dateTime={new Date(project.openedAt).toISOString()}>{timeAgo(project.openedAt)}</time>
                    </button>
                    <button
                      className="axiom-launcher__recent-remove"
                      onClick={() => void removeProject(project.id)}
                      disabled={removingProjectId !== null}
                      aria-label={`Remove ${project.name} from recent projects`}
                      title="Remove from recents and delete the cached index"
                    >
                      {removingProjectId === project.id ? '…' : '×'}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <footer className="axiom-launcher__local-note">
            <span aria-hidden="true" />
            <p><strong>LOCAL WORKSPACE</strong> Project indexes and layout state remain on this machine.</p>
          </footer>
        </section>
      </div>

      {creating && (
        <div className="axiom-create__scrim" onClick={() => !createBusy && setCreating(false)}>
          <div
            className="axiom-create"
            role="dialog"
            aria-modal="true"
            aria-labelledby="axiom-create-title"
            onClick={event => event.stopPropagation()}
          >
            <div className="axiom-create__head">
              <span className="axiom-create__kicker">NEW PROJECT</span>
              <h3 id="axiom-create-title">Create a model from scratch</h3>
              <button className="axiom-create__close" onClick={() => setCreating(false)} aria-label="Cancel" disabled={createBusy}>×</button>
            </div>

            <label className="axiom-create__field">
              <span>PROJECT NAME</span>
              <input
                autoFocus
                value={newName}
                onChange={event => { setNewName(event.target.value); setCreateError(null) }}
                onKeyDown={event => { if (event.key === 'Enter' && canCreate) void confirmCreate() }}
                placeholder="e.g. pose-engine"
                spellCheck={false}
              />
            </label>

            <label className="axiom-create__field">
              <span>LOCATION</span>
              <button type="button" className="axiom-create__location" onClick={() => void chooseLocation()}>
                {newLocation
                  ? <code title={newLocation}>{newLocation}</code>
                  : <em>Choose a parent folder…</em>}
                <span aria-hidden="true">⌕</span>
              </button>
            </label>

            {newLocation && safeName && (
              <p className="axiom-create__preview">
                Creates <code>{newLocation}{newLocation.includes('\\') ? '\\' : '/'}{safeName}</code>
              </p>
            )}

            {createError && <div className="axiom-create__error" role="alert">{createError}</div>}

            <div className="axiom-create__actions">
              <button className="axiom-create__cancel" onClick={() => setCreating(false)} disabled={createBusy}>Cancel</button>
              <button className="axiom-create__go" onClick={() => void confirmCreate()} disabled={!canCreate}>
                {createBusy ? 'Creating…' : 'Create & Open'} <span aria-hidden="true">→</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

function ProjectDeckSignals({ status }: { status?: CommandDeckStatus }) {
  if (!status) {
    return <span className="axiom-launcher__deck-signals axiom-launcher__deck-signals--loading">READING MAP…</span>
  }
  if (!status.indexed) {
    return <span className="axiom-launcher__deck-signals">NOT INDEXED</span>
  }
  const signals: Array<{ label: string; tone?: string }> = []
  if (status.activeWork.length > 0) {
    signals.push({
      label: `${status.activeWork.length} AGENT${status.activeWork.length === 1 ? '' : 'S'} ACTIVE`,
      tone: 'live',
    })
  }
  if (status.unreviewedClaims > 0) {
    signals.push({ label: `${status.unreviewedClaims} TO REVIEW`, tone: 'review' })
  }
  if (status.unexplained > 0) {
    signals.push({ label: `${status.unexplained} UNEXPLAINED`, tone: 'attention' })
  }
  if (status.unexpected > 0) {
    signals.push({ label: `${status.unexpected} DRIFT`, tone: 'attention' })
  }
  if (status.openPlans > 0) {
    signals.push({ label: `${status.openPlans} OPEN PLAN${status.openPlans === 1 ? '' : 'S'}` })
  }
  if (status.pendingProposals > 0) {
    signals.push({ label: `${status.pendingProposals} PROPOSAL${status.pendingProposals === 1 ? '' : 'S'}` })
  }
  if (signals.length === 0) {
    signals.push({ label: `${status.systems} SYSTEMS · MAP CLEAN`, tone: 'clean' })
  }
  return (
    <span className="axiom-launcher__deck-signals">
      {signals.slice(0, 3).map(signal => (
        <span
          key={signal.label}
          className={signal.tone
            ? `axiom-launcher__deck-signal axiom-launcher__deck-signal--${signal.tone}`
            : 'axiom-launcher__deck-signal'}
        >
          {signal.label}
        </span>
      ))}
    </span>
  )
}

export function timeAgo(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}
