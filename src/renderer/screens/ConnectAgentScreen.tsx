import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectConfig } from '../../shared/types'
import type { AgentConnection } from '../../../electron/preload'

/**
 * The first thing you see on a codebase whose architecture nobody has authored.
 *
 * It replaced a notification above the canvas whose one action copied a string
 * and raised a notice that stacked behind the notice already showing — so the
 * most important action in the product produced no visible response at all.
 *
 * The steps advance as the connection actually happens rather than sitting
 * there as a static list. Before an agent is listening, telling someone which
 * command to run is noise: they cannot run it yet, and it competes for
 * attention with the one thing they can do. So each step is dimmed until it is
 * theirs, and the command to hand the agent appears at the moment there is an
 * agent to hand it to.
 *
 * Gated on whether the architecture has been authored, deliberately not on any
 * "have you seen this" flag. Those live in local storage, outlive every reset
 * of the workspace data, and were hiding the setup a user needed because some
 * earlier journey had once been completed on that machine.
 */

const POLL_MS = 2000
const COMMAND = '/axiom:name-architecture'

type Phase = 'waiting' | 'connected' | 'proposed'

// Connection progress lives outside React, keyed by project.
//
// App re-renders on every graph change while a project indexes, and any of
// those re-renders can remount this screen. Holding the phase in component
// state meant a connection that had already been detected was thrown away and
// the screen fell back to "waiting for an agent" while an agent was demonstrably
// connected. Progress is a fact about the workspace, not about this component's
// current instance, so it outlives the instance.
const progress = new Map<string, Phase>()

interface Props {
  project: ProjectConfig
  fileCount: number
  indexing: boolean
  onContinue: () => void
  onBack: () => void
}

export function ConnectAgentScreen({ project, fileCount, indexing, onContinue, onBack }: Props) {
  const [connection, setConnection] = useState<AgentConnection | null>(null)
  const [copied, setCopied] = useState<'config' | 'command' | null>(null)
  const [phase, setPhaseState] = useState<Phase>(() => progress.get(project.id) ?? 'waiting')
  const setPhase = useCallback((next: Phase) => {
    // One-way: connected never falls back to waiting, and a proposal outranks
    // a bare connection.
    const rank: Record<Phase, number> = { waiting: 0, connected: 1, proposed: 2 }
    const current = progress.get(project.id) ?? 'waiting'
    if (rank[next] <= rank[current]) return
    progress.set(project.id, next)
    setPhaseState(next)
  }, [project.id])
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void window.axiom.getAgentConnection().then(setConnection)
    return () => { if (copiedTimer.current) clearTimeout(copiedTimer.current) }
  }, [])

  // Two signals, both real. Every MCP call an agent makes is recorded against
  // this workspace, so any action proves something is talking to us; and a
  // proposal appearing proves it did the work. Neither can be faked by the UI.
  useEffect(() => {
    if (phase === 'proposed') return
    // No in-flight cancellation. App re-renders while a project indexes and can
    // remount this screen faster than a request completes; cancelling on unmount
    // meant every poll was abandoned mid-flight and the screen sat on "waiting"
    // while an agent was demonstrably connected. The latch above makes a late
    // result harmless -- progress only ever moves forward.
    const poll = async () => {
      const workspace = encodeURIComponent(project.id)
      try {
        const res = await fetch(`http://127.0.0.1:7743/api/architecture-proposals?workspace=${workspace}`)
        if (res.ok) {
          const body = await res.json() as unknown
          const list = Array.isArray(body) ? body : (body as { proposals?: unknown[] })?.proposals ?? []
          if (list.length > 0) { setPhase('proposed'); return }
        }
      } catch { /* a daemon hiccup is not a disconnection */ }
      try {
        const res = await fetch(`http://127.0.0.1:7743/api/agent/actions?workspace=${workspace}&limit=1`)
        if (!res.ok) return
        const body = await res.json() as unknown
        const list = Array.isArray(body) ? body : (body as { actions?: unknown[] })?.actions ?? []
        if (list.length > 0) setPhase('connected')
      } catch { /* as above */ }
    }
    void poll()
    const timer = setInterval(poll, POLL_MS)
    return () => clearInterval(timer)
  }, [project.id, phase, setPhase])

  const copy = useCallback(async (text: string, which: 'config' | 'command') => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(which)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(null), 2400)
    } catch {
      setCopied(null)
    }
  }, [])

  const connected = phase !== 'waiting'
  const stepState = (step: 1 | 2 | 3) => {
    if (step === 3) return phase === 'proposed' ? 'done' : connected ? 'active' : 'upcoming'
    return connected ? 'done' : step === 1 ? 'active' : 'upcoming'
  }

  return (
    <div className="axiom-connect">
      <div className="axiom-connect__sheet">
        <button type="button" className="axiom-connect__back" onClick={onBack}>← Projects</button>

        <p className="axiom-connect__eyebrow">{project.name}</p>
        <h1 className="axiom-connect__title">Let an agent read this codebase</h1>
        <p className="axiom-connect__lede">
          Axiom can show you every file and what calls what. Only an agent that has read the project
          can tell you what its parts <em>are</em>. Connect one and it will propose the systems in
          this codebase — you confirm, rename or reject each one.
        </p>

        <p className="axiom-connect__indexed">
          {indexing ? 'Reading your files…' : `${fileCount} ${fileCount === 1 ? 'file' : 'files'} indexed`}
        </p>

        <ol className="axiom-connect__steps">
          <li className="axiom-connect__step" data-index="1" data-state={stepState(1)}>
            <h2>Add Axiom to your agent</h2>
            <p>Paste this into your agent’s MCP configuration — Claude Code, Codex, Cursor, or
              anything else that speaks MCP.</p>
            {connection && !connection.available ? (
              <p className="axiom-connect__broken">
                This Axiom install has no MCP server at <code>{connection.path}</code>. Reinstall or
                rebuild before connecting an agent.
              </p>
            ) : (
              <>
                <pre className="axiom-connect__config">{connection?.config ?? 'Locating your Axiom install…'}</pre>
                <div className="axiom-connect__actions">
                  <button
                    type="button"
                    className="axiom-connect__copy"
                    data-copied={copied === 'config'}
                    onClick={() => void copy(connection?.config ?? '', 'config')}
                    disabled={!connection?.available}
                  >
                    {copied === 'config' ? 'Copied ✓' : 'Copy configuration'}
                  </button>
                  {connected && <span className="axiom-connect__hint">Already connected — nothing to do here.</span>}
                </div>
              </>
            )}
          </li>

          <li className="axiom-connect__step" data-index="2" data-state={stepState(2)}>
            <h2>Restart your agent</h2>
            <p>Agents read their MCP configuration at startup, so a session that is already running
              will not see Axiom until it restarts.</p>
          </li>

          <li className="axiom-connect__step" data-index="3" data-state={stepState(3)}>
            <h2>Ask it to map this project</h2>
            {connected ? (
              <>
                <p>Your agent is listening. Give it this:</p>
                <div className="axiom-connect__command">
                  <strong>{COMMAND}</strong>
                  <button type="button" onClick={() => void copy(COMMAND, 'command')}>
                    {copied === 'command' ? 'Copied ✓' : 'Copy'}
                  </button>
                </div>
                <p>Or just tell it: <em>map this codebase’s architecture in Axiom</em>. It will read
                  the project and propose a tree of systems. Nothing reaches your map until you
                  approve it.</p>
              </>
            ) : (
              <p>Once your agent is connected, Axiom will give you the command to run here.</p>
            )}
          </li>
        </ol>

        <div className="axiom-connect__status" data-status={phase} aria-live="polite">
          <span className="axiom-connect__lamp" aria-hidden="true" />
          {phase === 'proposed' ? (
            <>
              <strong>An architecture is waiting for your review.</strong>
              <button type="button" className="axiom-connect__go" onClick={onContinue}>Review it</button>
            </>
          ) : phase === 'connected' ? (
            <strong>An agent is connected.</strong>
          ) : (
            <span>Waiting for an agent to connect…</span>
          )}
        </div>

        <button type="button" className="axiom-connect__skip" onClick={onContinue}>
          Skip — just show me the files
        </button>
      </div>
    </div>
  )
}
