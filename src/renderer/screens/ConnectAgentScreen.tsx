import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectConfig } from '../../shared/types'
import type { AgentConnection } from '../../../electron/preload'

/**
 * The first thing you see on a codebase Axiom has not been told about.
 *
 * It replaces a notification in the interruption lane whose one action copied
 * a string to the clipboard and raised a notice that stacked *behind* the
 * notice already showing — so the single most important action in the product
 * produced no visible response at all.
 *
 * A screen, not a dialog, and not a strip above the canvas. On a codebase
 * nobody has mapped, connecting an agent is not a detour from looking at the
 * map: it is the whole of the work, and everything the map can say is
 * downstream of it. Showing a machine-guessed architecture first and offering
 * this in a corner taught people to distrust the map before anyone had a
 * chance to make it true.
 *
 * It is gated on whether the architecture has been authored, and deliberately
 * not on any "have you seen the onboarding" flag. Those flags live in local
 * storage, survive every reset of the workspace data, and had the effect of
 * hiding the setup a user needed because a different user journey had once
 * been completed on that machine.
 */

const POLL_MS = 2000

interface Props {
  project: ProjectConfig
  fileCount: number
  indexing: boolean
  onContinue: () => void
  onBack: () => void
}

export function ConnectAgentScreen({ project, fileCount, indexing, onContinue, onBack }: Props) {
  const [connection, setConnection] = useState<AgentConnection | null>(null)
  const [copied, setCopied] = useState(false)
  const [connected, setConnected] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void window.axiom.getAgentConnection().then(setConnection)
    return () => { if (copiedTimer.current) clearTimeout(copiedTimer.current) }
  }, [])

  // Every MCP call an agent makes is recorded against this workspace, so the
  // arrival of any action is proof that something out there is talking to us.
  // It cannot claim connected without a real call having happened.
  useEffect(() => {
    if (connected) return
    let live = true
    const poll = async () => {
      try {
        const res = await fetch(
          `http://127.0.0.1:7743/api/agent/actions?workspace=${encodeURIComponent(project.id)}&limit=1`,
        )
        if (!res.ok || !live) return
        const body = await res.json() as { actions?: unknown[] } | unknown[]
        const actions = Array.isArray(body) ? body : body.actions ?? []
        if (actions.length > 0 && live) setConnected(true)
      } catch {
        // A daemon hiccup is not a disconnection; keep waiting quietly.
      }
    }
    void poll()
    const timer = setInterval(poll, POLL_MS)
    return () => { live = false; clearInterval(timer) }
  }, [project.id, connected])

  const copy = useCallback(async () => {
    if (!connection?.available) return
    try {
      await navigator.clipboard.writeText(connection.config)
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2400)
    } catch {
      setCopied(false)
    }
  }, [connection])

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
          {indexing
            ? 'Reading your files…'
            : `${fileCount} ${fileCount === 1 ? 'file' : 'files'} indexed and ready.`}
        </p>

        <ol className="axiom-connect__steps">
          <li>
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
                <button
                  type="button"
                  className="axiom-connect__copy"
                  onClick={copy}
                  disabled={!connection?.available}
                >
                  {copied ? 'Copied ✓' : 'Copy configuration'}
                </button>
              </>
            )}
          </li>

          <li>
            <h2>Restart your agent</h2>
            <p>Agents read their MCP configuration at startup, so a session that is already running
              will not see Axiom until it restarts.</p>
          </li>

          <li>
            <h2>Ask it to map this project</h2>
            <p>Run <code>/axiom:name-architecture</code>, or just tell it: <em>map this codebase’s
              architecture in Axiom</em>. Nothing reaches your map until you approve it.</p>
          </li>
        </ol>

        <div className="axiom-connect__status" data-status={connected ? 'connected' : 'waiting'} aria-live="polite">
          <span className="axiom-connect__lamp" aria-hidden="true" />
          {connected
            ? <strong>An agent is connected. Ask it to map this project.</strong>
            : <span>Waiting for an agent to connect…</span>}
        </div>

        <button type="button" className="axiom-connect__skip" onClick={onContinue}>
          Skip — just show me the files
        </button>
      </div>
    </div>
  )
}
