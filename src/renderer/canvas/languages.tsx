import React from 'react'
import { brandIcon } from './nodes/infraIcons'

export interface LanguageDefinition {
  id: string
  label: string
  extensions: string[]
  preferredExtension: string
  short: string
  color: string
  textColor?: string
  icon: string
}

export const LANGUAGES: LanguageDefinition[] = [
  { id: 'typescript', label: 'TypeScript', extensions: ['.ts'], preferredExtension: '.ts', short: 'TS', color: '#3178c6', textColor: '#fff', icon: 'typescript' },
  { id: 'tsx', label: 'TypeScript React', extensions: ['.tsx'], preferredExtension: '.tsx', short: 'TSX', color: '#61dafb', textColor: '#fff', icon: 'react' },
  { id: 'javascript', label: 'JavaScript', extensions: ['.js', '.mjs', '.cjs'], preferredExtension: '.js', short: 'JS', color: '#f7df1e', textColor: '#303030', icon: 'javascript' },
  { id: 'jsx', label: 'JavaScript React', extensions: ['.jsx'], preferredExtension: '.jsx', short: 'JSX', color: '#61dafb', textColor: '#303030', icon: 'react' },
  { id: 'python', label: 'Python', extensions: ['.py'], preferredExtension: '.py', short: 'PY', color: '#3776ab', textColor: '#fff', icon: 'python' },
  { id: 'go', label: 'Go', extensions: ['.go'], preferredExtension: '.go', short: 'GO', color: '#00add8', textColor: '#fff', icon: 'go' },
  { id: 'rust', label: 'Rust', extensions: ['.rs'], preferredExtension: '.rs', short: 'RS', color: '#dea584', textColor: '#20150f', icon: 'rust' },
  { id: 'csharp', label: 'C# / .NET', extensions: ['.cs'], preferredExtension: '.cs', short: 'C#', color: '#512bd4', textColor: '#fff', icon: 'dotnet' },
  { id: 'cpp', label: 'C / C++', extensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp'], preferredExtension: '.cpp', short: 'C++', color: '#00599c', textColor: '#fff', icon: 'cplusplus' },
  { id: 'ruby', label: 'Ruby', extensions: ['.rb'], preferredExtension: '.rb', short: 'RB', color: '#cc342d', textColor: '#fff', icon: 'ruby' },
  { id: 'java', label: 'Java / OpenJDK', extensions: ['.java'], preferredExtension: '.java', short: 'JV', color: '#f89820', textColor: '#fff', icon: 'openjdk' },
  { id: 'markdown', label: 'Markdown', extensions: ['.md', '.mdx'], preferredExtension: '.md', short: 'MD', color: '#5f6f78', textColor: '#fff', icon: 'markdown' },
]

const byExtension = new Map(LANGUAGES.flatMap(language => language.extensions.map(ext => [ext, language] as const)))

export function languageDefinition(id: string): LanguageDefinition | undefined {
  return LANGUAGES.find(language => language.id === id.toLowerCase())
}

export function languageFromFilename(filename: string): LanguageDefinition | undefined {
  const lower = filename.toLowerCase()
  const extension = [...byExtension.keys()].sort((a, b) => b.length - a.length).find(ext => lower.endsWith(ext))
  return extension ? byExtension.get(extension) : undefined
}

export function filenameForLanguage(filename: string, languageId: string): string {
  const language = languageDefinition(languageId)
  if (!language) return filename
  const current = languageFromFilename(filename)
  if (current) {
    const ext = current.extensions.find(candidate => filename.toLowerCase().endsWith(candidate))!
    return filename.slice(0, -ext.length) + language.preferredExtension
  }
  return filename + language.preferredExtension
}

export function LanguageIcon({ language, size = 14 }: { language: string; size?: number }) {
  const definition = languageDefinition(language)
  if (!definition) {
    return <svg viewBox="0 0 24 24" width={size} height={size}><rect x="3" y="3" width="18" height="18" rx="1" fill="none" stroke="var(--text-secondary)" strokeWidth="2" /><path d="M9 17V7l7 5z" fill="none" stroke="var(--text-secondary)" strokeWidth="2" /></svg>
  }
  const icon = brandIcon(definition.icon)
  if (icon) return <svg viewBox="0 0 24 24" width={size} height={size} aria-label={icon.title}>
    <path d={icon.path} fill={definition.color} />
  </svg>
  return <svg viewBox="0 0 24 24" width={size} height={size}>
    <rect width="24" height="24" rx="2" fill={definition.color} />
    <text x="12" y="15.5" fill={definition.textColor ?? '#fff'} fontSize={definition.short.length > 2 ? 7 : 9} fontWeight="900" fontFamily="var(--font-mono)" textAnchor="middle">{definition.short}</text>
  </svg>
}

export function LanguagePicker({ value, onChange, iconSize = 14 }: { value: string; onChange?: (language: string) => void; iconSize?: number }) {
  const [open, setOpen] = React.useState(false)
  return <div className="nodrag nopan" style={{ position: 'relative', flexShrink: 0 }} onPointerDown={event => event.stopPropagation()}>
    <button type="button" disabled={!onChange} title={onChange ? 'Choose implementation language' : value || 'Unknown language'}
      onClick={event => { event.stopPropagation(); if (onChange) setOpen(current => !current) }}
      style={{ border: 0, background: 'transparent', padding: 0, display: 'flex', cursor: onChange ? 'pointer' : 'default' }}>
      <LanguageIcon language={value} size={iconSize} />
    </button>
    {open && <div className="nowheel" onWheel={event => event.stopPropagation()} style={{
      position: 'absolute', top: iconSize + 6, left: 0, zIndex: 100000, width: 170, maxHeight: 230, overflowY: 'auto',
      background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-card)', padding: 4,
    }}>
      {LANGUAGES.map(language => <button key={language.id} type="button" onClick={event => {
        event.stopPropagation(); onChange?.(language.id); setOpen(false)
      }} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '5px 6px', border: 0,
        background: language.id === value ? 'var(--bg-raised)' : 'transparent', color: 'var(--text-primary)',
        fontSize: 10, fontFamily: 'var(--font-mono)', cursor: 'pointer', textAlign: 'left',
      }}><LanguageIcon language={language.id} size={12} />{language.label}</button>)}
    </div>}
  </div>
}
