import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useGraphStore } from '../store/graphStore'
import type { DbFile } from '../../shared/types'

interface SearchBarProps {
  onClose: () => void
}

export function SearchBar({ onClose }: SearchBarProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<DbFile[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const { fitView } = useReactFlow()
  const setSelectedNode = useGraphStore(s => s.setSelectedNode)
  const toggleSystemExpanded = useGraphStore(s => s.toggleSystemExpanded)
  const expandedSystemIds = useGraphStore(s => s.expandedSystemIds)
  const systems = useGraphStore(s => s.systems)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    setResults(useGraphStore.getState().searchFiles(query))
    setActiveIdx(0)
  }, [query])

  const navigate = useCallback((file: DbFile) => {
    // Expand parent system so file node is visible
    if (file.systemId && !expandedSystemIds.has(file.systemId)) {
      toggleSystemExpanded(file.systemId)
    }
    setSelectedNode(file.id)
    setTimeout(() => {
      fitView({ nodes: [{ id: file.id }], duration: 500, padding: 0.5 })
    }, 50)
    onClose()
  }, [setSelectedNode, toggleSystemExpanded, expandedSystemIds, fitView, onClose])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, results.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)) }
    if (e.key === 'Enter' && results[activeIdx]) navigate(results[activeIdx])
    if (e.key === 'Escape') onClose()
  }

  const getSystemName = (systemId: string | null) => {
    if (!systemId) return null
    return systems.find(s => s.id === systemId)?.name ?? null
  }

  return (
    <div style={{
      position: 'fixed', top: '20%', left: '50%', transform: 'translateX(-50%)',
      width: 480, zIndex: 1000,
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 0,
      boxShadow: '6px 6px 0 rgba(0,0,0,0.35)',
      overflow: 'hidden',
      animation: 'fadeIn 0.12s ease-out',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 16px', borderBottom: '1px solid var(--border-dim)',
      }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2">
          <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
        </svg>
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search files…"
          style={{
            flex: 1, fontSize: 14, color: 'var(--text-primary)',
            background: 'none', border: 'none', outline: 'none',
          }}
        />
        <kbd style={{
          fontSize: 10, color: 'var(--text-dim)',
          background: 'var(--bg-raised)', borderRadius: 0,
          padding: '2px 6px', border: '1px solid var(--border)',
        }}>ESC</kbd>
      </div>

      {results.length > 0 && (
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          {results.map((file, i) => {
            const sysName = getSystemName(file.systemId)
            const filename = file.relPath.split('/').pop() ?? file.relPath
            return (
              <div
                key={file.id}
                onClick={() => navigate(file)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 16px', cursor: 'pointer',
                  background: i === activeIdx ? 'var(--bg-raised)' : 'transparent',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={() => setActiveIdx(i)}
              >
                <span style={{
                  width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                  background: 'var(--color-file, #3b82f6)',
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                    {filename}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {file.relPath}
                  </div>
                </div>
                {sysName && (
                  <span style={{
                    fontSize: 9, fontWeight: 600, color: 'var(--text-secondary)',
                    background: 'var(--bg-raised)', borderRadius: 0, padding: '1px 5px',
                    flexShrink: 0,
                  }}>{sysName}</span>
                )}
                <span style={{
                  fontSize: 9, fontWeight: 600, color: 'var(--text-dim)',
                  background: 'var(--bg-raised)', borderRadius: 0, padding: '1px 5px',
                  flexShrink: 0,
                }}>{file.language}</span>
              </div>
            )
          })}
        </div>
      )}

      {query && results.length === 0 && (
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 }}>
          No results for "{query}"
        </div>
      )}

      {!query && (
        <div style={{ padding: '12px 16px', fontSize: 11, color: 'var(--text-dim)' }}>
          <span>↑↓ to navigate · Enter to jump · Esc to close</span>
        </div>
      )}
    </div>
  )
}
