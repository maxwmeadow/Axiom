import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'

const MCP_ENDPOINT = 'http://127.0.0.1:7743/mcp'

type CopyState = 'idle' | 'copied' | 'failed'

export function AgentConnectBanner() {
  const [dismissed, setDismissed] = useState(false)
  const { files, isIndexing, workspaceId } = useGraphStore(useShallow(state => ({
    files: state.files,
    isIndexing: state.isIndexing,
    workspaceId: state.currentProject?.id ?? '',
  })))

  useEffect(() => {
    setDismissed(false)
  }, [workspaceId])

  const unclassified = files.filter(file => !file.systemId).length
  if (isIndexing || dismissed || unclassified === 0) return null

  return (
    <aside className="axiom-agent-connect" aria-label="Agent connection required">
      <span className="axiom-agent-connect__signal" aria-hidden="true" />
      <div className="axiom-agent-connect__copy">
        <strong>{unclassified} {unclassified === 1 ? 'file' : 'files'} awaiting architectural classification</strong>
        <span>Connect an AI agent through MCP to create systems and assign the remaining source files.</span>
      </div>
      <CopyEndpointButton endpoint={MCP_ENDPOINT} />
      <button
        type="button"
        className="axiom-agent-connect__dismiss"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss agent connection notice"
      >
        ×
      </button>
    </aside>
  )
}

function CopyEndpointButton({ endpoint }: { endpoint: string }) {
  const [state, setState] = useState<CopyState>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
  }, [])

  const copy = async () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
    try {
      await navigator.clipboard.writeText(endpoint)
      setState('copied')
    } catch {
      setState('failed')
    }
    resetTimer.current = setTimeout(() => setState('idle'), 2000)
  }

  const label = state === 'copied'
    ? 'Endpoint copied'
    : state === 'failed'
      ? 'Copy failed'
      : endpoint

  return (
    <button
      type="button"
      className="axiom-agent-connect__endpoint"
      data-copy-state={state}
      onClick={() => void copy()}
      aria-label={`Copy MCP endpoint ${endpoint}`}
    >
      {label}
    </button>
  )
}
