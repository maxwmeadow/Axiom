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

const LINE_HEIGHT = 18.6
const OVERSCAN = 30
const VIRTUALIZE_THRESHOLD = 100

export function SourcePreviewDialog({ fileId, workspaceId, symbol, onClose }: SourcePreviewDialogProps) {
  const [source, setSource] = React.useState<FileSource | null>(null)
  const [highlightedSource, setHighlightedSource] = React.useState<HighlightedSource | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const highlightedLineRef = React.useRef<HTMLDivElement | null>(null)
  const range = React.useMemo(() => highlightedRange(symbol), [symbol])
  const [scrollTop, setScrollTop] = React.useState(0)
  const [viewportHeight, setViewportHeight] = React.useState(600)

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
    const container = containerRef.current
    if (!container) return
    const vHeight = container.clientHeight || 600
    setViewportHeight(vHeight)
    const target = Math.max(0, (range.start - 1) * LINE_HEIGHT - vHeight / 2)
    container.scrollTop = target
    setScrollTop(target)
    requestAnimationFrame(() => highlightedLineRef.current?.scrollIntoView({ block: 'center' }))
  }, [source, range.start])

  const onCodeScroll = (event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop)
    if (event.currentTarget.clientHeight && event.currentTarget.clientHeight !== viewportHeight) {
      setViewportHeight(event.currentTarget.clientHeight)
    }
  }

  const lines = React.useMemo(() => source ? sourceLines(source.content) : [], [source])
  const title = source?.relPath ?? fileId

  const isVirtualized = lines.length > VIRTUALIZE_THRESHOLD
  const startIndex = isVirtualized ? Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN) : 0
  const endIndex = isVirtualized ? Math.min(lines.length, Math.ceil((scrollTop + viewportHeight) / LINE_HEIGHT) + OVERSCAN) : lines.length
  const topSpacerHeight = isVirtualized ? startIndex * LINE_HEIGHT : 0
  const bottomSpacerHeight = isVirtualized ? (lines.length - endIndex) * LINE_HEIGHT : 0
  const visibleLines = isVirtualized ? lines.slice(startIndex, endIndex) : lines

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
        <div
          ref={containerRef}
          onScroll={isVirtualized ? onCodeScroll : undefined}
          className="source-preview-code"
          aria-busy={!source && !error}
          style={{ backgroundColor: highlightedSource?.background }}
        >
          {!source && !error && <div className="source-preview-message">Loading source…</div>}
          {error && <div className="source-preview-message source-preview-error">{error}</div>}
          {source && (
            <>
              {topSpacerHeight > 0 && <div style={{ height: topSpacerHeight, flexShrink: 0 }} aria-hidden="true" />}
              {visibleLines.map((line, offset) => {
                const index = startIndex + offset
                const lineNumber = index + 1
                const highlighted = lineNumber >= range.start && lineNumber <= range.end
                const tokens = highlightedSource?.tokens[index]
                return (
                  <div
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
                )
              })}
              {bottomSpacerHeight > 0 && <div style={{ height: bottomSpacerHeight, flexShrink: 0 }} aria-hidden="true" />}
            </>
          )}
        </div>
      </section>
    </div>,
    document.body,
  )
}
