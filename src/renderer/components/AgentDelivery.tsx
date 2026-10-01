import { useEffect, useRef, useState } from 'react'
import type { DeliveryHost, DeliveryRun } from '../../shared/agentDelivery'

export function useAgentDelivery(workspaceId: string, isOpen: boolean) {
  const [hosts, setHosts] = useState<DeliveryHost[]>([])
  const [hostId, setHostId] = useState('')
  const [runs, setRuns] = useState<DeliveryRun[]>([])
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const lock = useRef(false)
  const workspace = useRef(workspaceId)
  workspace.current = workspaceId
  useEffect(() => { setHostId(''); setRuns([]); setNotice('') }, [workspaceId])
  useEffect(() => {
    if (!isOpen) return
    let active = true
    void window.axiom.listDeliveryHosts().then(items => { if (active) setHosts(items) }, () => { if (active) setNotice('Agent destinations unavailable. You can still save and copy a handoff.') })
    const refresh = () => { void window.axiom.listDeliveryRuns(workspaceId).then(items => { if (active) setRuns(items) }, () => { if (active) setNotice('Agent run status unavailable. Check the host before sending again.') }) }
    refresh()
    const timer = setInterval(refresh, 3000)
    return () => { active = false; clearInterval(timer) }
  }, [workspaceId, isOpen])
  const deliver = async (messageId: string, destination = hostId) => {
    if (!destination || lock.current) return
    lock.current = true; setBusy(messageId)
    try {
      const result = await window.axiom.deliverWorkOrder({ workspaceId, messageId, hostId: destination })
      if (workspace.current !== workspaceId) return
      setNotice(result.detail)
      if (result.run) setRuns(items => [...items.filter(item => item.key !== result.run!.key), result.run!])
    } catch (error) {
      if (workspace.current === workspaceId) setNotice(`Work order saved; delivery did not start. ${error instanceof Error ? error.message : String(error)}`)
    } finally { lock.current = false; setBusy('') }
  }
  const stop = async (run: DeliveryRun) => {
    try {
      await window.axiom.stopDeliveryRun(workspaceId, run.key)
      if (workspace.current === workspaceId) setRuns(await window.axiom.listDeliveryRuns(workspaceId))
    } catch (error) { if (workspace.current === workspaceId) setNotice(String(error)) }
  }
  return { hosts, hostId, setHostId, runs, notice, busy, deliver, stop }
}

export function deliveryAction(host?: DeliveryHost): string {
  if (!host) return 'Send to inbox'
  return host.route === 'run' ? `Start ${host.label}` : host.route === 'open' ? `Copy + open ${host.label}` : `Copy for ${host.label}`
}

export function AgentDeliveryDestination({ hosts, hostId, onChange, disabled, rootPath }: {
  hosts: DeliveryHost[]; hostId: string; onChange: (value: string) => void; disabled: boolean; rootPath: string
}) {
  const host = hosts.find(item => item.id === hostId)
  return <div className="axiom-inbox__delivery">
    <label>Deliver to<select aria-label="Work-order destination" value={hostId} disabled={disabled} onChange={event => onChange(event.target.value)}>
      <option value="">Choose chat manually</option>
      {hosts.map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.label}{!item.available ? ' · CLI not found' : ''}</option>)}
    </select></label>
    <small>{host?.detail ?? 'Save the request, then copy its handoff into the agent chat you choose.'}</small>
    {host?.route === 'run' && <small title={rootPath}>Edits files in {rootPath}. Uses your host account; usage may be billed. Stop the run before starting another here.</small>}
  </div>
}

export function AgentDeliveryStatus({ run, hosts, onStop }: { run?: DeliveryRun; hosts: DeliveryHost[]; onStop: (run: DeliveryRun) => void }) {
  if (!run) return null
  return <div className="axiom-inbox__delivery-run" role="status">
    <span><strong>{hosts.find(host => host.id === run.hostId)?.label ?? run.hostId}</strong> · {run.detail}</span>
    {(run.state === 'running' || run.state === 'starting') && <button type="button" onClick={() => onStop(run)}>Stop run</button>}
    <button type="button" onClick={() => window.axiom.showInFolder(run.logPath)}>Show agent output</button>
  </div>
}
