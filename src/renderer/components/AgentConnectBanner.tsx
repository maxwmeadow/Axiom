import React, { useState } from 'react'
import { useGraphStore } from '../store/graphStore'
import { useShallow } from 'zustand/react/shallow'

/**
 * AgentConnectBanner — shown after raw indexing completes.
 * Prompts user to connect an AI agent via MCP to semantically classify the project.
 */
export function AgentConnectBanner() {
  const [dismissed, setDismissed] = useState(false)
  const { isIndexing, files } = useGraphStore(useShallow(s => ({ isIndexing: s.isIndexing, files: s.files })))

  // Show only after indexing completes and there are unclassified files
  const unclassified = files.filter(f => !f.systemId).length
  if (isIndexing || dismissed || unclassified === 0) return null

  const mcpEndpoint = 'http://127.0.0.1:7743/mcp'

  return (
    <div style={{
      position: 'fixed',
      bottom: 36,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 500,
      background: 'var(--bg-surface)',
      border: '1px solid var(--accent)',
      borderRadius: 0,
      padding: '14px 20px',
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      boxShadow: '6px 6px 0 rgba(0,0,0,0.35)',
      animation: 'fadeIn 0.3s ease-out',
      maxWidth: 560,
    }}>
      <div style={{
        width: 10, height: 10, borderRadius: '50%',
        background: 'var(--accent)',
        flexShrink: 0,
        animation: 'pulse 2s ease-in-out infinite',
      }} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>
          {unclassified} files unclassified — connect an agent to map architecture
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          Point your AI agent at the MCP endpoint to create systems and assign files.
        </div>
      </div>

      <CopyButton text={mcpEndpoint} />

      <button
        onClick={() => setDismissed(true)}
        title="Dismiss"
        style={{ color: 'var(--text-dim)', fontSize: 16, padding: '2px 6px', flexShrink: 0, opacity: 0.6 }}
        onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
        onMouseLeave={e => (e.currentTarget.style.opacity = '0.6')}
      >
        ×
      </button>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handle = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      onClick={handle}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 12px',
        background: 'var(--bg-raised)',
        border: `1px solid ${copied ? 'var(--ok)' : 'var(--border)'}`,
        borderRadius: 0,
        fontSize: 11, fontWeight: 600,
        color: copied ? 'var(--ok)' : 'var(--text-secondary)',
        flexShrink: 0,
        transition: 'all 0.2s ease',
        fontFamily: 'monospace',
        whiteSpace: 'nowrap',
      }}
    >
      {copied ? '✓ Copied' : text}
    </button>
  )
}
