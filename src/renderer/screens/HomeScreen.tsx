import React, { useEffect, useState } from 'react'
import type { ProjectConfig } from '../../shared/types'

interface HomeScreenProps {
  onOpenProject: (config: ProjectConfig) => void
  onOpenDialog: () => void
}

export function HomeScreen({ onOpenProject, onOpenDialog }: HomeScreenProps) {
  const [recentProjects, setRecentProjects] = useState<ProjectConfig[]>([])

  useEffect(() => {
    if (window.axiom) {
      window.axiom.listRecentProjects().then(setRecentProjects)
    } else {
      setRecentProjects([])
    }
  }, [])

  const removeProject = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation()
    if (window.axiom) {
      await window.axiom.removeProject(projectId)
      setRecentProjects(prev => prev.filter(p => p.id !== projectId))
    }
  }

  const openDialog = async () => {
    if (window.axiom) {
      onOpenDialog()
    } else {
      // Demo mode in browser: open a fake project
      const demoConfig: ProjectConfig = {
        id: 'demo',
        name: 'Demo Project',
        rootPath: '/demo',
        ignoredPaths: [],
        languageOverrides: {},
        layoutPreferences: { zoom: 0.5, panX: 0, panY: 0 },
        openedAt: Date.now(),
      }
      onOpenProject(demoConfig)
    }
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', gap: 32,
      background: 'var(--bg-base)',
    }}>
      {/* Logo + title */}
      <div style={{ textAlign: 'center' }}>
        <AxiomHeroLogo />
        <h1 style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-0.04em', marginBottom: 8, background: 'linear-gradient(135deg, #e2e8f0 0%, #94a3b8 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          Axiom
        </h1>
        <p style={{ fontSize: 15, color: 'var(--text-secondary)', maxWidth: 400, lineHeight: 1.6 }}>
          Live architectural intelligence for the AI development era.
          Your codebase as a living, interactive canvas.
        </p>
      </div>

      {/* Open project button */}
      <button
        onClick={openDialog}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 24px',
          background: 'var(--accent)',
          borderRadius: 0,
          fontSize: 14, fontWeight: 600,
          color: '#fff',
          boxShadow: '0 0 20px var(--accent-glow)',
          transition: 'transform 0.1s, box-shadow 0.1s',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.transform = 'translateY(-1px)'
          e.currentTarget.style.boxShadow = '0 4px 24px var(--accent-glow)'
        }}
        onMouseLeave={e => {
          e.currentTarget.style.transform = ''
          e.currentTarget.style.boxShadow = '0 0 20px var(--accent-glow)'
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        Open Project
      </button>

      {/* Recent projects */}
      {recentProjects.length > 0 && (
        <div style={{ width: 420 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', marginBottom: 8, letterSpacing: '0.08em' }}>
            RECENT
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {recentProjects.slice(0, 6).map(p => (
              <button
                key={p.id}
                onClick={() => onOpenProject(p)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '10px 14px',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 0,
                  textAlign: 'left',
                  transition: 'border-color 0.15s, background 0.15s',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.borderColor = 'var(--accent)'
                  e.currentTarget.style.background = 'var(--bg-raised)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.borderColor = 'var(--border)'
                  e.currentTarget.style.background = 'var(--bg-surface)'
                }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{p.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>{p.rootPath}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{timeAgo(p.openedAt)}</span>
                  <button
                    onClick={(e) => removeProject(e, p.id)}
                    title="Remove from recents (deletes cached index)"
                    style={{
                      fontSize: 14, color: 'var(--text-dim)', padding: '0 2px',
                      lineHeight: 1, opacity: 0.5,
                    }}
                    onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                    onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}
                  >×</button>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Features */}
      <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
        {[
          { icon: '⬡', title: 'Live Canvas', desc: 'Auto-syncs with every file save' },
          { icon: '⟷', title: 'Agent Native', desc: 'MCP server on port 7743' },
          { icon: '◎', title: 'Infinite Zoom', desc: 'INFRA → SERVICE → MODULE → FILE → SYMBOL' },
        ].map(f => (
          <div key={f.title} style={{
            width: 140, padding: 14, textAlign: 'center',
            background: 'var(--bg-surface)', borderRadius: 0, border: '1px solid var(--border)',
          }}>
            <div style={{ fontSize: 20, marginBottom: 6 }}>{f.icon}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{f.title}</div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5 }}>{f.desc}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function AxiomHeroLogo() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" style={{ margin: '0 auto 12px', display: 'block' }}>
      <polygon points="32,4 60,18 60,46 32,60 4,46 4,18" fill="rgba(91,138,154,0.08)" stroke="rgba(91,138,154,0.4)" strokeWidth="1.5"/>
      <polygon points="32,14 50,22 50,42 32,50 14,42 14,22" fill="rgba(91,138,154,0.05)" stroke="rgba(91,138,154,0.25)" strokeWidth="1"/>
      <circle cx="32" cy="32" r="8" fill="rgba(91,138,154,0.3)" stroke="var(--accent)" strokeWidth="1.5"/>
      <circle cx="32" cy="32" r="3" fill="var(--accent)"/>
      {/* Spokes */}
      {[[32,4],[60,18],[60,46],[32,60],[4,46],[4,18]].map(([x,y], i) => (
        <line key={i} x1={32} y1={32} x2={x} y2={y} stroke="var(--accent)" strokeWidth="0.75" opacity="0.3"/>
      ))}
    </svg>
  )
}
