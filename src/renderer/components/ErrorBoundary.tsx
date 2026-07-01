import React from 'react'

interface State {
  error: Error | null
  componentStack: string | null
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null, componentStack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Render error caught:', error)
    console.error('[ErrorBoundary] Component stack:', info.componentStack)
    this.setState({ componentStack: info.componentStack ?? null })
  }

  render() {
    const { error, componentStack } = this.state
    if (!error) return this.props.children

    return (
      <div style={{
        position: 'fixed', inset: 0,
        background: '#0f0a0a',
        color: '#fca5a5',
        padding: 32,
        fontFamily: 'monospace',
        fontSize: 13,
        overflowY: 'auto',
        zIndex: 99999,
      }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#f87171', marginBottom: 16 }}>
          Render Error
        </div>

        <div style={{ marginBottom: 24 }}>
          <div style={{ color: '#fbbf24', fontWeight: 600, marginBottom: 6 }}>Error:</div>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#fca5a5', margin: 0 }}>
            {error.message}
          </pre>
        </div>

        {error.stack && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ color: '#fbbf24', fontWeight: 600, marginBottom: 6 }}>Stack:</div>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#94a3b8', margin: 0, fontSize: 11 }}>
              {error.stack}
            </pre>
          </div>
        )}

        {componentStack && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ color: '#fbbf24', fontWeight: 600, marginBottom: 6 }}>Component tree:</div>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#94a3b8', margin: 0, fontSize: 11 }}>
              {componentStack}
            </pre>
          </div>
        )}

        <button
          onClick={() => this.setState({ error: null, componentStack: null })}
          style={{
            background: '#7f1d1d', border: '1px solid #f87171', borderRadius: 6,
            color: '#fca5a5', padding: '8px 16px', fontSize: 13, cursor: 'pointer',
          }}
        >
          Dismiss
        </button>
      </div>
    )
  }
}
