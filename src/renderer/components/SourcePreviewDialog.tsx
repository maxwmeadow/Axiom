import React from 'react'
import { createPortal } from 'react-dom'
import type { DbSymbol } from '../../shared/types'
import { apiGetFileSource, type FileSource } from '../canvas/arcdApi'
import { highlightSource, type HighlightedSource, type SyntaxToken } from './sourceHighlighting'

interface SourcePreviewDialogProps {
  fileId: string
  workspaceId: string
  symbol: Pick<DbSymbol, 'name' | 'kind' | 'lineStart' | 'lineEnd'>
  onClose: () => void
}

function highlightedRange(symbol: SourcePreviewDialogProps['symbol']): { start: number; end: number } {
  const start = Math.max(1, symbol.lineStart)
  const kind = symbol.kind.toLowerCase()
  const spansDefinition = kind === 'function' || kind === 'method' || kind === 'class' ||
    kind === 'interface' || kind === 'type'
  return { start, end: spansDefinition ? Math.max(start, symbol.lineEnd) : start }
}

function displayError(error: unknown): string {
  if (!(error instanceof Error)) return 'Unable to load this source file.'
  try {
    const payload = JSON.parse(error.message) as { error?: string }
    return payload.error || error.message
  } catch {
    return error.message
  }
}

function sourceLines(content: string): string[] {
  if (!content) return []
  const lines = content.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function tokenStyle(token: SyntaxToken): React.CSSProperties {
  const fontStyle = token.fontStyle ?? 0
  const decorations = [
    fontStyle & 4 ? 'underline' : '',
    fontStyle & 8 ? 'line-through' : '',
  ].filter(Boolean).join(' ')
  return {
    color: token.color,
    backgroundColor: token.bgColor,
    fontStyle: fontStyle & 1 ? 'italic' : undefined,
    fontWeight: fontStyle & 2 ? 700 : undefined,
    textDecoration: decorations || undefined,
  }
}

export function SourcePreviewDialog({ fileId, workspaceId, symbol, onClose }: SourcePreviewDialogProps) {
  const [source, setSource] = React.useState<FileSource | null>(null)
  const [highlightedSource, setHighlightedSource] = React.useState<HighlightedSource | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const highlightedLineRef = React.useRef<HTMLDivElement | null>(null)
  const range = React.useMemo(() => highlightedRange(symbol), [symbol])

  React.useEffect(() => {
    const controller = new AbortController()
    setSource(null)
    setError(null)
    void apiGetFileSource(fileId, workspaceId, controller.signal)
      .then(setSource)
      .catch(fetchError => {
        if (!(fetchError instanceof DOMException && fetchError.name === 'AbortError')) {
          setError(displayError(fetchError))
        }
      })
    return () => controller.abort()
  }, [fileId, workspaceId])

  React.useEffect(() => {
    if (!source) {
      setHighlightedSource(null)
      return
    }
    let current = true
    setHighlightedSource(null)
    void highlightSource(source.content, source.language, source.relPath)
      .then(result => {
        if (current) setHighlightedSource(result)
      })
      .catch(highlightError => {
        // Source viewing must remain available even when a third-party or
        // custom language grammar cannot be loaded.
        console.warn('[source-preview] syntax highlighting unavailable', highlightError)
      })
    return () => { current = false }
  }, [source])

  React.useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  React.useEffect(() => {
    if (!source) return
    requestAnimationFrame(() => highlightedLineRef.current?.scrollIntoView({ block: 'center' }))
  }, [source, range.start])

  const lines = React.useMemo(() => source ? sourceLines(source.content) : [], [source])
  const title = source?.relPath ?? fileId

  return createPortal(
    <div
      className="source-preview-backdrop nodrag nopan nowheel"
      role="presentation"
      onPointerDown={event => {
        event.stopPropagation()
        if (event.target === event.currentTarget) onClose()
      }}
      onWheel={event => event.stopPropagation()}
    >
      <section className="source-preview-dialog" role="dialog" aria-modal="true" aria-label={`${symbol.name} in ${title}`}>
        <header className="source-preview-header">
          <div className="source-preview-heading">
            <div className="source-preview-path" title={title}>{title}</div>
            <div className="source-preview-location">
              {symbol.kind} {symbol.name} · {range.start === range.end ? `line ${range.start}` : `lines ${range.start}–${range.end}`}
            </div>
          </div>
          <button autoFocus className="source-preview-close" onClick={onClose} aria-label="Close source preview">×</button>
        </header>
        <div className="source-preview-code" aria-busy={!source && !error} style={{ backgroundColor: highlightedSource?.background }}>
          {!source && !error && <div className="source-preview-message">Loading source…</div>}
          {error && <div className="source-preview-message source-preview-error">{error}</div>}
          {source && lines.map((line, index) => {
            const lineNumber = index + 1
            const highlighted = lineNumber >= range.start && lineNumber <= range.end
            const tokens = highlightedSource?.tokens[index]
            return <div
              key={lineNumber}
              ref={lineNumber === range.start ? highlightedLineRef : undefined}
              className={`source-preview-line${highlighted ? ' source-preview-line-highlighted' : ''}`}
            >
              <span className="source-preview-line-number">{lineNumber}</span>
              <span className="source-preview-line-content" style={{ color: highlightedSource?.foreground }}>
                {tokens?.length
                  ? tokens.map((token, tokenIndex) => <span key={tokenIndex} style={tokenStyle(token)}>{token.content}</span>)
                  : line || ' '}
              </span>
            </div>
          })}
        </div>
      </section>
    </div>,
    document.body,
  )
}
