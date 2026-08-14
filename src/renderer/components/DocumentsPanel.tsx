import { useEffect, useMemo, useState } from 'react'
import { isDocumentationFile } from '../../shared/fileKinds'
import type { DbFile } from '../../shared/types'
import { apiGetFileSource } from '../canvas/arcdApi'
import { useGraphStore } from '../store/graphStore'

interface DocumentsPanelProps {
  onClose: () => void
}

export function DocumentsPanel({ onClose }: DocumentsPanelProps) {
  const files = useGraphStore(state => state.files)
  const workspaceId = useGraphStore(state => state.currentProject?.id ?? '')
  const documents = useMemo(
    () => files.filter(isDocumentationFile).sort((left, right) => left.relPath.localeCompare(right.relPath)),
    [files],
  )
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(() => documents[0]?.id ?? null)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const visibleDocuments = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? documents.filter(file => file.relPath.toLowerCase().includes(needle)) : documents
  }, [documents, query])
  const selected = visibleDocuments.find(file => file.id === selectedId) ?? visibleDocuments[0] ?? null

  useEffect(() => {
    if (!selected || !workspaceId) {
      setContent('')
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void apiGetFileSource(selected.id, workspaceId, controller.signal)
      .then(source => setContent(source.content))
      .catch(reason => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Axiom could not read this document.')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [selected, workspaceId])

  return (
    <aside className="axiom-documents" aria-label="Project documents">
      <header className="axiom-documents__header">
        <div>
          <p>Project reference</p>
          <h2>Documents</h2>
          <span>{documents.length} readable {documents.length === 1 ? 'document' : 'documents'} kept off the canvas</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close documents">×</button>
      </header>

      <label className="axiom-documents__search">
        <span>Find a document</span>
        <input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="README, ADR, notes…"
        />
      </label>

      <div className="axiom-documents__workspace">
        <nav className="axiom-documents__list" aria-label="Documentation files">
          {visibleDocuments.length === 0 ? (
            <p>{documents.length === 0 ? 'No readable documentation was indexed.' : 'No documents match that search.'}</p>
          ) : visibleDocuments.map(file => (
            <DocumentButton
              key={file.id}
              file={file}
              active={file.id === selected?.id}
              onClick={() => setSelectedId(file.id)}
            />
          ))}
        </nav>

        <article className="axiom-documents__preview" aria-live="polite">
          {selected ? (
            <>
              <header>
                <strong>{selected.relPath.split('/').pop()}</strong>
                <span>{selected.relPath}</span>
              </header>
              {loading ? <p className="axiom-documents__message">Reading document…</p>
                : error ? <p className="axiom-documents__message axiom-documents__message--error">{error}</p>
                  : <pre>{content}</pre>}
            </>
          ) : <p className="axiom-documents__message">Choose a document to read it.</p>}
        </article>
      </div>
    </aside>
  )
}

function DocumentButton({ file, active, onClick }: { file: DbFile; active: boolean; onClick: () => void }) {
  const name = file.relPath.split('/').pop() ?? file.relPath
  const folder = file.relPath.includes('/') ? file.relPath.slice(0, file.relPath.lastIndexOf('/')) : 'Project root'
  return (
    <button type="button" className="axiom-documents__item" data-active={active || undefined} onClick={onClick}>
      <span aria-hidden="true">≡</span>
      <span>
        <strong>{name}</strong>
        <small>{folder}</small>
      </span>
      <em>{file.language === 'markdown' ? 'MD' : 'TEXT'}</em>
    </button>
  )
}
