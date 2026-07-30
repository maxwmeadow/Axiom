import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useReactFlow } from '@xyflow/react'
import { useGraphStore } from '../store/graphStore'
import type { DbFile } from '../../shared/types'

interface SearchBarProps {
  onClose: () => void
}

function HighlightedMatch({ query, text }: { query: string; text: string }) {
  const index = text.toLowerCase().indexOf(query.trim().toLowerCase())
  if (index < 0 || !query.trim()) return <>{text}</>

  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.trim().length)}</mark>
      {text.slice(index + query.trim().length)}
    </>
  )
}

export function SearchBar({ onClose }: SearchBarProps) {
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeResultRef = useRef<HTMLButtonElement>(null)
  const { fitView } = useReactFlow()
  const files = useGraphStore(s => s.files)
  const systems = useGraphStore(s => s.systems)
  const setSelectedNode = useGraphStore(s => s.setSelectedNode)
  const toggleSystemExpanded = useGraphStore(s => s.toggleSystemExpanded)
  const expandedSystemIds = useGraphStore(s => s.expandedSystemIds)

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return []
    return files
      .filter(file => file.relPath.toLowerCase().includes(normalized))
      .slice(0, 30)
  }, [files, query])

  const systemNames = useMemo(
    () => new Map(systems.map(system => [system.id, system.name])),
    [systems],
  )

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setActiveIdx(0)
  }, [query])

  useEffect(() => {
    activeResultRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  const navigate = useCallback((file: DbFile) => {
    if (file.systemId && !expandedSystemIds.has(file.systemId)) {
      toggleSystemExpanded(file.systemId)
    }
    setSelectedNode(file.id)
    setTimeout(() => {
      fitView({ nodes: [{ id: file.id }], duration: 850, padding: 0.5 })
    }, 50)
    onClose()
  }, [setSelectedNode, toggleSystemExpanded, expandedSystemIds, fitView, onClose])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (results.length > 0) setActiveIdx(index => Math.min(index + 1, results.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (results.length > 0) setActiveIdx(index => Math.max(index - 1, 0))
    } else if (event.key === 'Enter' && results[activeIdx]) {
      event.preventDefault()
      navigate(results[activeIdx])
    } else if (event.key === 'Escape') {
      onClose()
    }
  }

  return createPortal(
    <div
      className="axiom-search-backdrop nodrag nopan nowheel"
      role="presentation"
      onPointerDown={event => {
        event.stopPropagation()
        if (event.target === event.currentTarget) onClose()
      }}
      onWheel={event => event.stopPropagation()}
    >
      <section className="axiom-search-window" role="dialog" aria-modal="true" aria-label="Search files">
        <header className="axiom-search-header">
          <div>
            <h2>Find in project</h2>
            <p>Indexed source files</p>
          </div>
          <button type="button" className="axiom-search-close" onClick={onClose} aria-label="Close search">×</button>
        </header>

        <div className="axiom-search-query">
          <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/>
            <path d="M21 21l-4.35-4.35"/>
          </svg>
          <input
            ref={inputRef}
            aria-activedescendant={results[activeIdx] ? `axiom-search-result-${results[activeIdx].id}` : undefined}
            aria-controls="axiom-search-results"
            aria-label="Search project files"
            autoComplete="off"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a file name or path…"
          />
          <kbd>Esc</kbd>
        </div>

        <div className="axiom-search-body">
          {results.length > 0 && (
            <>
              <div className="axiom-search-results-header">
                <span>Files</span>
                <output>{results.length} {results.length === 1 ? 'match' : 'matches'}</output>
              </div>
              <div className="axiom-search-results" id="axiom-search-results" role="listbox" aria-label="File results">
                {results.map((file, index) => {
                  const filename = file.relPath.split('/').pop() ?? file.relPath
                  const systemName = file.systemId ? systemNames.get(file.systemId) : null
                  const active = index === activeIdx
                  return (
                    <button
                      ref={active ? activeResultRef : undefined}
                      id={`axiom-search-result-${file.id}`}
                      key={file.id}
                      type="button"
                      className="axiom-search-result"
                      aria-selected={active}
                      role="option"
                      onClick={() => navigate(file)}
                      onMouseEnter={() => setActiveIdx(index)}
                    >
                      <span className="axiom-search-result__icon" aria-hidden="true" />
                      <span className="axiom-search-result__copy">
                        <strong><HighlightedMatch query={query} text={filename} /></strong>
                        <span><HighlightedMatch query={query} text={file.relPath} /></span>
                      </span>
                      {systemName && <span className="axiom-search-result__system">{systemName}</span>}
                      <span className="axiom-search-result__language">{file.language}</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {query && results.length === 0 && (
            <div className="axiom-search-empty">
              <strong>No matching files</strong>
              <span>No indexed path contains “{query}”.</span>
            </div>
          )}

          {!query && (
            <div className="axiom-search-empty axiom-search-empty--idle">
              <strong>Search the project index</strong>
              <span>Start with a filename, folder, extension, or path fragment.</span>
            </div>
          )}
        </div>

        <footer className="axiom-search-footer" aria-label="Search keyboard shortcuts">
          <span><kbd>↑</kbd><kbd>↓</kbd> select</span>
          <span><kbd>Enter</kbd> open on canvas</span>
          <span><kbd>Esc</kbd> close</span>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
