import React from 'react'
import { useGraphStore } from '../store/graphStore'
import { useShallow } from 'zustand/react/shallow'
import type { DbFile, DbSystem, DbDependency } from '../../shared/types'

export function DetailPanel() {
  const { selectedNodeId, files, systems, infraNodes, dependencies, setSelectedNode } = useGraphStore(
    useShallow(s => ({
      selectedNodeId: s.selectedNodeId,
      files: s.files,
      systems: s.systems,
      infraNodes: s.infraNodes,
      dependencies: s.dependencies,
      setSelectedNode: s.setSelectedNode,
    }))
  )

  if (!selectedNodeId) return null

  const file = files.find(f => f.id === selectedNodeId)
  const system = !file ? systems.find(s => s.id === selectedNodeId) : undefined
  const infra = !file && !system ? infraNodes.find(n => n.id === selectedNodeId) : undefined

  if (!file && !system && !infra) return null

  return (
    <div style={{
      position: 'fixed', right: 0, top: 48, bottom: 0,
      width: 280,
      background: 'var(--bg-surface)',
      borderLeft: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      animation: 'fadeIn 0.15s ease-out',
      zIndex: 10,
    }}>
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.05em' }}>
          {file ? 'FILE' : system ? 'SYSTEM' : 'INFRA'}
        </span>
        <button
          onClick={() => setSelectedNode(null)}
          style={{ color: 'var(--text-dim)', fontSize: 16, padding: '2px 6px' }}
        >×</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {file && <FileDetail file={file} systems={systems} dependencies={dependencies} setSelectedNode={setSelectedNode} />}
        {system && <SystemDetail system={system} files={files} systems={systems} />}
        {infra && (
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>
              {infra.name}
            </div>
            <Stat label="Type" value={infra.infraType} />
          </div>
        )}
      </div>
    </div>
  )
}

function FileDetail({ file, systems, dependencies, setSelectedNode }: {
  file: DbFile
  systems: DbSystem[]
  dependencies: DbDependency[]
  setSelectedNode: (id: string | null) => void
}) {
  const filename = file.relPath.split('/').pop() ?? file.relPath
  const parentSystem = systems.find(s => s.id === file.systemId)
  const churn = file.churnScore ?? 0

  const outDeps = dependencies.filter(d => d.src === file.id && d.srcType === 'file')
  const inDeps = dependencies.filter(d => d.dst === file.id && d.dstType === 'file')

  const openFile = () => {
    if (window.axiom) window.axiom.showInFolder(file.path)
  }

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', wordBreak: 'break-word', fontFamily: 'monospace' }}>
          {filename}
        </div>
        <button
          onClick={openFile}
          style={{ marginTop: 4, fontSize: 10, color: 'var(--text-dim)', textAlign: 'left', wordBreak: 'break-all' }}
          title="Show in folder"
        >
          {file.relPath}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        <Stat label="Language" value={file.language} />
        {file.lineCount > 0 && <Stat label="Lines" value={String(file.lineCount)} />}
        {churn > 0 && <Stat label="Churn" value={`${Math.round(churn * 100)}%`} warn={churn > 0.7} />}
        {parentSystem && <Stat label="System" value={parentSystem.name} />}
      </div>

      {outDeps.length > 0 && (
        <DependencySection title={`Imports (${outDeps.length})`} dependencies={outDeps} direction="out" onClick={setSelectedNode} />
      )}
      {inDeps.length > 0 && (
        <DependencySection title={`Imported by (${inDeps.length})`} dependencies={inDeps} direction="in" onClick={setSelectedNode} />
      )}
    </>
  )
}

function SystemDetail({ system, files, systems }: {
  system: DbSystem
  files: DbFile[]
  systems: DbSystem[]
}) {
  const childFiles = files.filter(f => f.systemId === system.id)
  const childSystems = systems.filter(s => s.parentId === system.id)
  const parent = systems.find(s => s.id === system.parentId)

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
          {system.name}
        </div>
        {system.description && (
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {system.description}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        <Stat label="Files" value={String(childFiles.length)} />
        {childSystems.length > 0 && <Stat label="Subsystems" value={String(childSystems.length)} />}
        <Stat label="Source" value={system.source} />
        {parent && <Stat label="Parent" value={parent.name} />}
      </div>

      {system.agentNotes && (
        <Section title="Agent Notes">
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {system.agentNotes}
          </div>
        </Section>
      )}
    </>
  )
}

function DependencySection({ title, dependencies, direction, onClick }: {
  title: string
  dependencies: DbDependency[]
  direction: 'in' | 'out'
  onClick: (id: string) => void
}) {
  const shown = dependencies.slice(0, 10)
  return (
    <Section title={title}>
      {shown.map(d => (
        <div
          key={d.id}
          onClick={() => onClick(direction === 'out' ? d.dst : d.src)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 6px', borderRadius: 4, cursor: 'pointer', marginBottom: 2,
          }}
          onMouseEnter={ev => (ev.currentTarget.style.background = 'var(--bg-raised)')}
          onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}
        >
          <span style={{ fontSize: 9, color: 'var(--color-file, #3b82f6)', fontWeight: 600 }}>
            {direction === 'out' ? '→' : '←'} {d.dependencyType}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {direction === 'out' ? d.dst : d.src}
          </span>
        </div>
      ))}
      {dependencies.length > 10 && (
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
          +{dependencies.length - 10} more
        </div>
      )}
    </Section>
  )
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ background: 'var(--bg-raised)', borderRadius: 6, padding: '6px 10px' }}>
      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: warn ? 'var(--warn)' : 'var(--text-primary)' }}>
        {value}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', marginBottom: 8, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
        {title}
      </div>
      {children}
    </div>
  )
}
