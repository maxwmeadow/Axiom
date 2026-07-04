import React, { useEffect, useState, useRef } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { AxiomCanvas } from '../canvas/AxiomCanvas'
import { useGraphStore } from '../store/graphStore'
import { useShallow } from 'zustand/react/shallow'
import type { ProjectConfig } from '../../shared/types'

interface ProjectReviewScreenProps {
  project: ProjectConfig
  onFinishReview: () => void
  onBack: () => void
}

export function ProjectReviewScreen({ project, onFinishReview, onBack }: ProjectReviewScreenProps) {
  const [mcpPath, setMcpPath] = useState<string>('')
  const [copiedText, setCopiedText] = useState<string | null>(null)
  
  const terminalEndRef = useRef<HTMLDivElement>(null)

  const { agentActivities, clearAgentActivities, files } = useGraphStore(
    useShallow((s) => ({
      agentActivities: s.agentActivities,
      clearAgentActivities: s.clearAgentActivities,
      files: s.files,
    }))
  )

  // Fetch MCP path details on mount
  useEffect(() => {
    if (window.axiom) {
      window.axiom.getAppInfo().then((info) => {
        setMcpPath(info.mcpPath || '')
      })
    }
  }, [])

  // Auto-scroll terminal log to bottom on new activities
  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [agentActivities])

  const unclassifiedCount = files.filter(f => !f.systemId).length
  const totalFiles = files.length
  const isAgentActive = agentActivities.length > 0

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopiedText(id)
    setTimeout(() => setCopiedText(null), 2000)
  }

  // Format timestamps nicely
  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return d.toTimeString().split(' ')[0]
  }

  const universalCommand = `npx tsx "${mcpPath || 'axiom-mcp.ts'}"`

  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh', background: '#0b0d12', color: '#f1f5f9', fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', overflow: 'hidden' }}>
      
      {/* Left Panel: Instructions, Agent Config, Log */}
      <div style={{
        width: 480,
        borderRight: '1px solid var(--border-dim)',
        display: 'flex',
        flexDirection: 'column',
        background: '#0f1118',
        boxSizing: 'border-box',
        overflow: 'hidden',
        position: 'relative',
        zIndex: 10,
      }}>
        {/* Header Block */}
        <div style={{ padding: '24px 24px 16px', borderBottom: '1px solid var(--border-dim)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <button
              onClick={onBack}
              style={{
                background: 'transparent', border: 'none', color: '#94a3b8',
                fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                opacity: 0.6, transition: 'opacity 0.2s'
              }}
              onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
              onMouseLeave={(e) => e.currentTarget.style.opacity = '0.6'}
            >
              ← Back
            </button>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: isAgentActive ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)',
              border: `1px solid ${isAgentActive ? 'rgba(16,185,129,0.3)' : 'rgba(245,158,11,0.3)'}`,
              padding: '4px 10px', borderRadius: 0, fontSize: 11, fontWeight: 600,
              color: isAgentActive ? '#10b981' : '#f59e0b',
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: isAgentActive ? '#10b981' : '#f59e0b',
                animation: 'pulse 2s ease-in-out infinite'
              }} />
              {isAgentActive ? 'Agent Connected' : 'Awaiting Agent Connection'}
            </div>
          </div>
          
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 6px 0', letterSpacing: '-0.02em', color: '#fff' }}>
            Review Architecture Baseline
          </h1>
          <p style={{ fontSize: 13, color: '#94a3b8', margin: 0, lineHeight: 1.5 }}>
            Automated baseline indexing is complete. Connect your agent via MCP to co-review system layouts, resolve groupings, and finalize connections.
          </p>
        </div>

        {/* Configuration Setup and Terminal Logs */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
          
          {/* Universal MCP setup box */}
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-dim)', borderRadius: 0, padding: 14 }}>
            <div style={{ fontSize: 12, color: '#e2e8f0', fontWeight: 600, marginBottom: 6 }}>Universal MCP Connection</div>
            <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.5, marginBottom: 12 }}>
              Point your AI editor (Claude Code, Cursor, Windsurf, etc.) to this MCP server configuration:
            </div>
            
            {/* Command box */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, marginBottom: 4, letterSpacing: '0.04em' }}>MCP COMMAND</div>
                <div style={{ display: 'flex', gap: 8, background: 'var(--bg-deep)', border: '1px solid var(--border-dim)', borderRadius: 0, padding: '8px 10px' }}>
                  <code style={{ fontSize: 11, color: '#cbd5e1', fontFamily: 'monospace', wordBreak: 'break-all', flex: 1, alignSelf: 'center' }}>
                    {universalCommand}
                  </code>
                  <button
                    onClick={() => handleCopy(universalCommand, 'cmd')}
                    style={{
                      background: 'var(--bg-raised)', border: '1px solid var(--border)',
                      borderRadius: 0, color: '#fff', fontSize: 10, padding: '4px 8px', cursor: 'pointer', whiteSpace: 'nowrap', alignSelf: 'flex-start'
                    }}
                  >
                    {copiedText === 'cmd' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              <div>
                <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, marginBottom: 4, letterSpacing: '0.04em' }}>ABSOLUTE PATH</div>
                <div style={{ display: 'flex', gap: 8, background: 'var(--bg-deep)', border: '1px solid var(--border-dim)', borderRadius: 0, padding: '8px 10px' }}>
                  <code style={{ fontSize: 11, color: '#cbd5e1', fontFamily: 'monospace', wordBreak: 'break-all', flex: 1, alignSelf: 'center' }}>
                    {mcpPath}
                  </code>
                  <button
                    onClick={() => handleCopy(mcpPath, 'path')}
                    style={{
                      background: 'var(--bg-raised)', border: '1px solid var(--border)',
                      borderRadius: 0, color: '#fff', fontSize: 10, padding: '4px 8px', cursor: 'pointer', whiteSpace: 'nowrap', alignSelf: 'flex-start'
                    }}
                  >
                    {copiedText === 'path' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              {/* Kickoff Instruction box */}
              <div style={{ marginTop: 6, borderTop: '1px solid var(--border-dim)', paddingTop: 12 }}>
                <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, marginBottom: 4, letterSpacing: '0.04em' }}>HOW TO KICKOFF</div>
                <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.5 }}>
                  Once your agent is connected, type <strong>"start a review"</strong> in your AI editor's chat window. The agent will run the <code>start_review</code> tool and fetch the audit guidelines automatically.
                </div>
              </div>
            </div>
          </div>

          {/* Live Agent Terminal Log */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 180 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.08em' }}>AGENT LIVE ACTIVITY LOG</div>
              {agentActivities.length > 0 && (
                <button
                  onClick={clearAgentActivities}
                  style={{ background: 'transparent', border: 'none', color: '#94a3b8', fontSize: 10, cursor: 'pointer' }}
                >
                  Clear Log
                </button>
              )}
            </div>

            <div style={{
              flex: 1,
              background: '#07090e',
              border: '1px solid var(--border-dim)',
              borderRadius: 0,
              padding: 12,
              fontFamily: 'monospace',
              fontSize: 11,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}>
              {agentActivities.length === 0 ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#475569', textAlign: 'center', padding: '0 20px' }}>
                  <div style={{ fontSize: 24, marginBottom: 8 }}>⚡</div>
                  <div>Awaiting agent commands... Ask your agent to review or modify systems.</div>
                </div>
              ) : (
                agentActivities.map((act, i) => {
                  const dotColor = act.level === 'success' ? '#10b981' : act.level === 'error' ? '#ef4444' : act.level === 'warn' ? '#f59e0b' : '#3b82f6'
                  return (
                    <div key={i} style={{ display: 'flex', gap: 8, lineHeight: 1.4 }}>
                      <span style={{ color: '#475569', flexShrink: 0 }}>[{formatTime(act.timestamp)}]</span>
                      <span style={{
                        display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                        background: dotColor, marginTop: 5, flexShrink: 0
                      }} />
                      <span style={{ color: act.level === 'error' ? '#fca5a5' : act.level === 'success' ? '#a7f3d0' : '#e2e8f0', wordBreak: 'break-all' }}>
                        {act.message}
                      </span>
                    </div>
                  )
                })
              )}
              <div ref={terminalEndRef} />
            </div>
          </div>
        </div>

        {/* Footer actions */}
        <div style={{ padding: 24, borderTop: '1px solid var(--border-dim)', display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg-base)' }}>
          <button
            onClick={onFinishReview}
            style={{
              width: '100%',
              padding: '12px 16px',
              background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
              border: 'none',
              borderRadius: 0,
              fontSize: 13,
              fontWeight: 600,
              color: '#fff',
              cursor: 'pointer',
              boxShadow: 'none',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)'
              e.currentTarget.style.boxShadow = '0 6px 18px rgba(37,99,235,0.45)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = ''
              e.currentTarget.style.boxShadow = '0 4px 14px rgba(37,99,235,0.3)'
            }}
          >
            Finish Review
          </button>
        </div>
      </div>

      {/* Right Panel: Interactive Canvas Preview */}
      <div style={{ flex: 1, position: 'relative', background: '#08090d' }}>
        <ReactFlowProvider>
          <AxiomCanvas readOnly={false} />
        </ReactFlowProvider>

        {/* Float overlay status */}
        <div style={{
          position: 'absolute',
          top: 20,
          right: 20,
          zIndex: 1000,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 0,
          padding: '12px 16px',
          maxWidth: 320,
          boxShadow: 'var(--shadow-card)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#10b981', animation: 'pulse 2s ease-in-out infinite' }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: '#fff', letterSpacing: '-0.01em' }}>Interactive Review</span>
          </div>
          <p style={{ fontSize: 11, color: '#94a3b8', margin: 0, lineHeight: 1.4 }}>
            Bidirectional mode active. You can rearrange systems and group files manually while your agent works alongside you.
          </p>
        </div>
      </div>
      
    </div>
  )
}
