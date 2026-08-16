import { useEffect, useMemo, useState } from 'react'
import { isDocumentationFile } from '../../shared/fileKinds'
import type { DbFile } from '../../shared/types'
import { apiGetFileSource } from '../canvas/arcdApi'
import { useGraphStore } from '../store/graphStore'
import { FloatingWindow } from './FloatingWindow'
import { MarkdownView } from './MarkdownView'

/**
 * The document reader: a window, not a slab.
 *
 * Reading is the whole job here, so the document gets the room. The file list
 * is a way in, not a permanent fixture - it collapses, and it stays collapsed,
 * because once you are reading something you are not choosing what to read.
 */

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx'])

function extensionOf(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

function fileName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path
}

function folderOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : 'Project root'
}

export function DocumentsPanel({ onClose }: { onClose: () => void }) {
  const files = useGraphStore(state => state.files)
  const workspaceId = useGraphStore(state => state.currentProject?.id ?? '')
  const documents = useMemo(
    () => files.filter(isDocumentationFile)
      .sort((left, right) => left.relPath.localeCompare(right.relPath)),
    [files],
  )

  const [query, setQuery] = useState('')
  const [browsing, setBrowsing] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? documents.filter(file => file.relPath.toLowerCase().includes(needle)) : documents
  }, [documents, query])

  // Nothing is open until something is chosen. Auto-selecting the first
  // document means the reader always opens on whatever sorts alphabetically
  // first, which is never what anyone wanted to read.
  const selected = documents.find(file => file.id === selectedId) ?? null

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
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [selected, workspaceId])

  const open = (file: DbFile) => {
    setSelectedId(file.id)
    // Choosing is finished; give the words the whole window.
    setBrowsing(false)
  }

  const isMarkdown = selected ? MARKDOWN_EXTENSIONS.has(extensionOf(selected.relPath)) : false

  return (
    <FloatingWindow
      className="axiom-docs"
      title="Documents"
      subtitle={`${documents.length} kept off the canvas`}
      onClose={onClose}
      initialWidthRatio={0.48}
      initialHeightRatio={0.72}
      minWidth={420}
      minHeight={320}
    >
      <div className="axiom-docs__layout" data-browsing={browsing || undefined}>
        {browsing && (
          <nav className="axiom-docs__list" aria-label="Documentation files">
            <label className="axiom-docs__search">
              <input
                type="search"
                value={query}
                autoFocus
                onChange={event => setQuery(event.target.value)}
                placeholder="Find a document…"
              />
            </label>
            {visible.length === 0 ? (
              <p className="axiom-docs__empty">
                {documents.length === 0
                  ? 'No readable documentation was indexed.'
                  : 'Nothing matches that search.'}
              </p>
            ) : visible.map(file => (
              <button
                key={file.id}
                type="button"
                className="axiom-docs__item"
                data-active={file.id === selectedId || undefined}
                onClick={() => open(file)}
              >
                <strong>{fileName(file.relPath)}</strong>
                <small>{folderOf(file.relPath)}</small>
              </button>
            ))}
          </nav>
        )}

        <section className="axiom-docs__reader" aria-live="polite">
          <div className="axiom-docs__readerbar">
            <button
              type="button"
              className="axiom-docs__browse"
              onClick={() => setBrowsing(value => !value)}
              aria-expanded={browsing}
            >
              {browsing ? '‹ Hide list' : '☰ All documents'}
            </button>
            {selected && <span className="axiom-docs__path">{selected.relPath}</span>}
          </div>

          <div className="axiom-docs__content">
            {!selected ? (
              <p className="axiom-docs__message">Choose a document to read it.</p>
            ) : loading ? (
              <p className="axiom-docs__message">Reading {fileName(selected.relPath)}…</p>
            ) : error ? (
              <p className="axiom-docs__message axiom-docs__message--error">{error}</p>
            ) : isMarkdown ? (
              <MarkdownView source={content} />
            ) : (
              // Plain text is already the document. Rendering it as prose would
              // reflow logs and transcripts whose line breaks carry meaning.
              <pre className="axiom-docs__plain">{content}</pre>
            )}
          </div>
        </section>
      </div>
    </FloatingWindow>
  )
}
