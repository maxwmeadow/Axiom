import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import { useSheetStore, refreshInbox, cancelInboxMessage } from '../store/sheetStore'
import { canvasReference, referenceTarget, messageReferences, inboxStatus, workOrderHandoff } from './inboxModel'
import { SheetComparison } from './SheetComparison'
import { InboxIcon } from './InboxIcon'
import { InboxSheetPicker } from './InboxSheetPicker'
import { AgentMessageContent } from './AgentMessageContent'
import { AgentHandoff } from './AgentHandoff'
import { WorkOrderReview } from './WorkOrderReview'
import { AgentDeliveryDestination, AgentDeliveryStatus, deliveryAction, useAgentDelivery } from './AgentDelivery'
import '../styles/inbox.css'

export function SendToAgentDialog({ isOpen, onClose, onManageConnections }: { isOpen: boolean; onClose: () => void; onManageConnections?: () => void }) {
  const graph = useGraphStore(useShallow(s => ({ workspaceId: s.currentProject?.id ?? '', rootPath: s.currentProject?.rootPath ?? '', name: s.currentProject?.name, files: s.files, systems: s.systems, infra: s.infraNodes })))
  const sheet = useSheetStore(useShallow(s => ({ sheets: s.sheets, activeSheetId: s.activeSheetId, layers: s.layersById, selected: s.selectedCanvasIds, messages: s.messages, error: s.inboxError, next: s.inboxNextCursor, send: s.sendToAgent })))
  const draftKey = `axiom:inbox-draft:${graph.workspaceId}`
  const pendingKey = `${draftKey}:pending`
  const delivery = useAgentDelivery(graph.workspaceId, isOpen)
  const deliveryHost = delivery.hosts.find(host => host.id === delivery.hostId)
  const [note, setNote] = useState(() => { try { return localStorage.getItem(draftKey) ?? '' } catch { return '' } })
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [copied, setCopied] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [unseen, setUnseen] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [excluded, setExcluded] = useState<string[]>([])
  const textarea = useRef<HTMLTextAreaElement>(null)
  const history = useRef<HTMLDivElement>(null)
  const attachmentArea = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const olderAnchor = useRef<{ height: number; top: number } | null>(null)
  const [attachedSheetId, setAttachedSheetId] = useState<string | null>(() => { try { const saved = JSON.parse(localStorage.getItem(`${draftKey}:sheet`) ?? 'null'); return typeof saved === 'string' ? saved : null } catch { return null } })
  const attachmentChosen = useRef((() => { try { return localStorage.getItem(`${draftKey}:sheet`) !== null } catch { return false } })())
  const sendLock = useRef(false)
  const retry = useRef<{ id: string; note: string; selection: string[]; sheetId: string | null; hostId?: string }>(undefined)
  const restored = useRef(false)
  if (!restored.current) {
    restored.current = true
    try {
      const saved = JSON.parse(localStorage.getItem(pendingKey) ?? 'null')
      if (saved && typeof saved.id === 'string' && typeof saved.note === 'string' && Array.isArray(saved.selection)) retry.current = saved
    } catch { /* no pending send */ }
  }
  const { fitView, getNode } = useReactFlow()
  const locked = sending || !!retry.current
  const dismissPicker = () => { setPickerOpen(false); textarea.current?.focus() }
  const latest = () => { if (history.current) history.current.scrollTop = history.current.scrollHeight; nearBottom.current = true; setUnseen(false) }

  const attachSheet = (id: string | null) => {
    attachmentChosen.current = true
    setAttachedSheetId(id)
    try { localStorage.setItem(`${draftKey}:sheet`, JSON.stringify(id)) } catch { /* in-memory draft still works */ }
  }
  useEffect(() => {
    const attach = (event: Event) => {
      const id = (event as CustomEvent<{ sheetId?: string }>).detail?.sheetId
      if (id && !retry.current && !sendLock.current) attachSheet(id)
    }
    window.addEventListener('axiom:open-agent-dispatch', attach)
    return () => window.removeEventListener('axiom:open-agent-dispatch', attach)
  }, [draftKey])
  useEffect(() => {
    if (isOpen && !attachmentChosen.current && !attachedSheetId) {
      const active = useSheetStore.getState().activeSheetId
      if (active) attachSheet(active)
    }
    if (isOpen) { nearBottom.current = true; latest(); textarea.current?.focus() }
    else setPickerOpen(false)
  }, [isOpen])
  useEffect(() => { setExcluded([]) }, [sheet.selected.join('\0')])
  useEffect(() => { try { localStorage.setItem(draftKey, note) } catch { /* drafting still works */ } }, [draftKey, note])
  useEffect(() => {
    if (!isOpen) return
    void refreshInbox(graph.workspaceId)
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (pickerOpen) { setPickerOpen(false); textarea.current?.focus() }
      else onClose()
    }
    const outside = (event: PointerEvent) => {
      if (!attachmentArea.current?.contains(event.target as Node)) setPickerOpen(false)
    }
    window.addEventListener('keydown', escape)
    window.addEventListener('pointerdown', outside)
    return () => { window.removeEventListener('keydown', escape); window.removeEventListener('pointerdown', outside) }
  }, [isOpen, graph.workspaceId, onClose, pickerOpen])
  const messageVersion = sheet.messages.map(message => `${message.id}:${message.status}:${message.reply?.createdAt ?? ''}:${message.review?.id ?? ''}:${message.sessions?.map(session => `${session.id}:${session.endedAt}:${session.notes.length}`).join(',') ?? ''}`).join('|')
  useLayoutEffect(() => {
    const el = history.current
    if (!el) return
    if (olderAnchor.current) { el.scrollTop = olderAnchor.current.top + el.scrollHeight - olderAnchor.current.height; olderAnchor.current = null }
    else if (nearBottom.current) latest()
    else setUnseen(true)
  }, [isOpen, messageVersion])
  useLayoutEffect(() => {
    const el = textarea.current
    if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 180)}px` }
  }, [isOpen, note, sending])

  if (!isOpen) return null
  const effectiveSheetId = retry.current ? retry.current.sheetId : attachedSheetId
  const attachedSheet = sheet.sheets.find(item => item.id === effectiveSheetId)
  const planned = Object.values(sheet.layers).flatMap(layer => layer.planned)
  const selection = sheet.selected.flatMap(id => {
    const file = graph.files.find(item => item.id === id)
    if (file) return [canvasReference('file', file.id, file.relPath)]
    const system = graph.systems.find(item => item.id === id)
    if (system) return [canvasReference('system', system.id, system.name)]
    const infra = graph.infra.find(item => item.id === id)
    if (infra) return [canvasReference('infra', infra.id, infra.name)]
    const plan = planned.find(item => `planned:${item.id}` === id)
    return plan ? [canvasReference('planned', plan.id, plan.name)] : []
  }).filter(ref => !excluded.includes(ref))
  const effectiveSelection = retry.current?.selection ?? selection
  const focus = (ref: string) => {
    const target = referenceTarget(ref)
    if (!getNode(target.id)) { setError('This item is no longer visible. Open its original sheet or expand its system.'); return }
    useGraphStore.getState().setSelectedNode(target.id)
    useGraphStore.getState().setInspectedNode(target.id)
    void fitView({ nodes: [{ id: target.id }], duration: 300, maxZoom: 1.2, padding: 0.5 })
  }
  const chips = (refs: string[], editable = false) => refs.length > 0 && <div className="axiom-inbox__targets">{refs.map(ref => <button type="button" key={ref} disabled={editable && locked} onClick={() => editable ? setExcluded(current => [...current, ref]) : focus(ref)} title={editable ? `Remove ${referenceTarget(ref).label} from message` : 'Show on canvas'}>
    <InboxIcon name="canvas" size={12} /><span>{referenceTarget(ref).label}</span>{editable && !locked && <InboxIcon name="close" size={11} />}
  </button>)}</div>
  const copy = (text: string, id: string) => { void navigator.clipboard.writeText(text).then(() => setCopied(id), () => setError('Clipboard unavailable. Select the visible work order ID and tell your agent to call get_inbox with that messageId.')) }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (sendLock.current || !(retry.current?.note ?? note).trim() || effectiveSelection.length > 100) return
    if (!retry.current && attachedSheetId && !attachedSheet) { setError('This attached sheet is no longer available. Remove it before sending.'); return }
    sendLock.current = true; setSending(true); setError(null); setPickerOpen(false)
    if (!retry.current) retry.current = { id: crypto.randomUUID(), note: note.trim(), selection, sheetId: attachedSheetId, hostId: delivery.hostId }
    try { localStorage.setItem(pendingKey, JSON.stringify(retry.current)) } catch { /* in-memory retries still work */ }
    try {
      const pending = retry.current
      await sheet.send(graph.workspaceId, pending.note, pending.selection, pending.sheetId, pending.id)
      setNote(''); retry.current = undefined; nearBottom.current = true
      try { localStorage.removeItem(pendingKey) } catch { /* already acknowledged */ }
      if (pending.hostId) await delivery.deliver(pending.id, pending.hostId)
    } catch (err) {
      const status = (err as { status?: number }).status
      if (status && status >= 400 && status < 500) {
        retry.current = undefined
        try { localStorage.removeItem(pendingKey) } catch { /* retry remains editable */ }
      }
      setError(err instanceof Error ? err.message : 'Could not send. Your draft is saved; retry when connected.')
    }
    finally { sendLock.current = false; setSending(false); requestAnimationFrame(() => textarea.current?.focus()) }
  }
  return <aside className="axiom-inbox nodrag nowheel" aria-label="Agent inbox">
    <header className="axiom-inbox__header"><span className="axiom-inbox__brand"><InboxIcon name="agent" size={18} /></span><div className="axiom-inbox__heading"><h2>Agent inbox</h2><span title={graph.name}>{graph.name}</span></div>
      <button type="button" className="axiom-inbox__icon" onClick={onClose} aria-label="Close agent inbox"><InboxIcon name="close" /></button>
    </header>
    {(error || sheet.error) && <div role="alert" className="axiom-inbox__error"><span>{error || sheet.error}</span><button type="button" onClick={() => { setError(null); void refreshInbox(graph.workspaceId) }}>Refresh</button></div>}
    <div className="axiom-inbox__thread">
      <div ref={history} className={`axiom-inbox__history${sheet.messages.length ? ' axiom-inbox__history--messages' : ''}`} aria-label="Messages" onScroll={() => { const el = history.current!; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; if (nearBottom.current) setUnseen(false) }}>
        {sheet.next && <button className="axiom-inbox__earlier" type="button" disabled={loadingEarlier} onClick={() => {
          const el = history.current!; olderAnchor.current = { height: el.scrollHeight, top: el.scrollTop }; setLoadingEarlier(true)
          void refreshInbox(graph.workspaceId, sheet.next).finally(() => { olderAnchor.current = null; setLoadingEarlier(false) })
        }}>{loadingEarlier ? 'Loading…' : 'Load earlier messages'}</button>}
        {sheet.messages.length === 0 && <div className="axiom-inbox__empty"><h3>No work orders yet</h3><p>Write a request below. Add a sheet or select canvas items for context.</p></div>}
        {sheet.messages.map(message => <article key={`${graph.workspaceId}:${message.id}`} className="axiom-inbox__message">
          <div className="axiom-inbox__user"><span className="axiom-inbox__entry-label">YOU</span><p>{message.note}</p>{chips(messageReferences(message.selection))}
            {message.sheetId && <button type="button" className="axiom-inbox__message-sheet" disabled={locked} onClick={() => attachSheet(message.sheetId)} title="Attach the current sheet to a new message"><InboxIcon name="sheet" size={14} /><span>{message.sentSheetName || sheet.sheets.find(item => item.id === message.sheetId)?.name || 'Attached sheet'}{message.sentSheetRevision ? ` · sent r${message.sentSheetRevision}` : ''}</span><InboxIcon name="chevron" size={12} /></button>}
            <div className="axiom-inbox__work-order">WORK ORDER <code>{message.id}</code></div>
          </div>
          <div className="axiom-inbox__meta"><span className={`axiom-inbox__status axiom-inbox__status--${message.status}`}>{inboxStatus(message)}</span><time title={new Date(message.createdAt).toLocaleString()} dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
            {(message.status === 'queued' || message.status === 'delivered') && <button type="button" className="axiom-inbox__handoff-copy" onClick={() => copy(workOrderHandoff(graph.name ?? 'this project', graph.workspaceId, graph.rootPath, message.id), `handoff:${message.id}`)} title={`Copy handoff for work order ${message.id}`}><InboxIcon name={copied === `handoff:${message.id}` ? 'check' : 'copy'} size={12} />{copied === `handoff:${message.id}` ? 'Copied' : 'Copy handoff'}</button>}
            {(message.status === 'queued' || message.status === 'delivered') && deliveryHost && <button type="button" className="axiom-inbox__handoff-copy" disabled={!!delivery.busy || !deliveryHost.available || (message.leaseExpiresAt ?? 0) > Date.now() || (deliveryHost.route === 'run' && delivery.runs.some(run => run.messageId === message.id && run.revision === (message.review?.id ?? 'initial') && run.state !== 'launch-failed'))} onClick={() => { void delivery.deliver(message.id) }}>{delivery.busy === message.id ? 'Delivering…' : deliveryAction(deliveryHost)}</button>}
            {(message.status === 'queued' || message.status === 'delivered') && <button type="button" className="axiom-inbox__cancel" onClick={() => { void cancelInboxMessage(graph.workspaceId, message.id).catch(err => setError(String(err))) }}>Cancel request</button>}
          </div>
          <AgentDeliveryStatus run={delivery.runs.filter(run => run.messageId === message.id).sort((a, b) => b.startedAt - a.startedAt)[0]} hosts={delivery.hosts} onStop={run => { void delivery.stop(run) }} />
          {message.status !== 'answered' && message.sessions?.filter(session => !session.endedAt).slice(-1).map(session => <section key={session.id} className="axiom-inbox__progress" aria-label={`Work progress: ${session.goal}`}><strong>{session.agent || 'Agent'} · {session.goal}</strong>{session.notes.length > 0 && <p>{session.notes.at(-1)?.text}</p>}</section>)}
          {message.reply && <div className="axiom-inbox__reply"><div className="axiom-inbox__reply-heading"><InboxIcon name="agent" size={16} /><strong>{message.reply.agent}</strong></div><AgentMessageContent text={message.reply.body} /><button type="button" className="axiom-inbox__copy-reply" aria-label={copied === message.id ? 'Reply copied' : 'Copy reply'} onClick={() => copy(message.reply!.body, message.id)}><InboxIcon name={copied === message.id ? 'check' : 'copy'} size={13} />{copied === message.id ? 'Copied' : 'Copy'}</button></div>}
          {message.status === 'answered' && !message.reply && <p className="axiom-inbox__notice">This older reply is no longer available.</p>}
          {message.status === 'cancelled' && <p className="axiom-inbox__notice">Cancelled. Ask the agent to stop if work began.</p>}
          <WorkOrderReview message={message} workspaceId={graph.workspaceId} currentSheet={sheet.sheets.find(item => item.id === message.sheetId)} />
        </article>)}
      </div>
      {unseen && <button className="axiom-inbox__latest" type="button" onClick={latest}>Jump to latest ↓</button>}
    </div>
    <div className="axiom-inbox__bottom">
      <AgentHandoff workspaceId={graph.workspaceId} projectRoot={graph.rootPath} onManageConnections={onManageConnections} />
      {effectiveSheetId && attachedSheet && <SheetComparison key={effectiveSheetId} workspaceId={graph.workspaceId} sheetId={effectiveSheetId} />}
      <form className="axiom-inbox__compose" onSubmit={submit}>
        <AgentDeliveryDestination hosts={delivery.hosts} hostId={retry.current?.hostId ?? delivery.hostId} onChange={delivery.setHostId} disabled={locked || !!delivery.busy} rootPath={graph.rootPath} />
        {delivery.notice && <p className="axiom-inbox__notice" role="status">{delivery.notice}</p>}
        {(effectiveSheetId || effectiveSelection.length > 0) && <div className="axiom-inbox__attachments">
          {effectiveSheetId && <div className="axiom-inbox__attachment" title={attachedSheet ? `${attachedSheet.name} · revision ${attachedSheet.revision} · snapshot and structural comparison included` : 'This sheet is no longer available'}><span className="axiom-inbox__sheet-icon"><InboxIcon name="sheet" size={16} /></span><span><strong>{attachedSheet?.name ?? 'Sheet unavailable'}</strong><small>{attachedSheet?.resolvedAt ? 'Resolved sheet' : attachedSheet ? 'Sheet' : 'Remove attachment'}</small></span><button className="axiom-inbox__icon" type="button" disabled={locked} aria-label="Remove attached sheet" onClick={() => attachSheet(null)}><InboxIcon name="close" size={13} /></button></div>}
          {chips(effectiveSelection, true)}
        </div>}
        <textarea ref={textarea} id="axiom-inbox-note" aria-label="Instruction for your agent" value={retry.current?.note ?? note} disabled={locked} onChange={event => setNote(event.target.value)} maxLength={16000} rows={2} placeholder="Describe a change or ask a question…" onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
          if (event.key === '@' && (event.currentTarget.selectionStart === 0 || /\s/.test(note[event.currentTarget.selectionStart - 1]))) { event.preventDefault(); setPickerOpen(true) }
        }} />
        <div className="axiom-inbox__compose-tools"><div ref={attachmentArea} className="axiom-inbox__attach-anchor">
          <button type="button" className="axiom-inbox__icon" disabled={locked} aria-label="Attach context" aria-haspopup="dialog" aria-expanded={pickerOpen} title="Attach a sheet (@)" onClick={() => setPickerOpen(!pickerOpen)}><InboxIcon name="attach" size={19} /></button>
          {pickerOpen && <InboxSheetPicker sheets={sheet.sheets} attachedId={effectiveSheetId} onClose={dismissPicker} onSelect={id => { attachSheet(id); dismissPicker() }} />}
        </div><span>{retry.current && !sending ? 'Send unconfirmed · retry' : sending ? 'Sending…' : 'Enter to send · Shift+Enter for new line'}</span><button className="axiom-inbox__send" type="submit" aria-label={deliveryAction(deliveryHost)} title={retry.current ? 'Retry original message' : deliveryAction(deliveryHost)} disabled={sending || !!delivery.busy || !(retry.current?.note ?? note).trim() || effectiveSelection.length > 100}><InboxIcon name={retry.current && !sending ? 'retry' : 'send'} size={19} /></button></div>
      </form>
      {effectiveSelection.length > 100 && <small className="axiom-inbox__limit" role="alert">Attach up to 100 canvas items per message.</small>}
    </div>
  </aside>
}
