export interface SyntaxToken {
  content: string
  color?: string
  bgColor?: string
  fontStyle?: number
}

export interface HighlightedSource {
  tokens: SyntaxToken[][]
  foreground?: string
  background?: string
}

export type AxiomHighlightLanguage = 'typescript' | 'tsx' | 'javascript' | 'jsx' | 'python' |
  'go' | 'rust' | 'csharp' | 'c' | 'cpp' | 'ruby' | 'java'

const LANGUAGE_ALIASES: Record<string, AxiomHighlightLanguage> = {
  typescript: 'typescript',
  ts: 'typescript',
  tsx: 'tsx',
  javascript: 'javascript',
  js: 'javascript',
  jsx: 'jsx',
  python: 'python',
  py: 'python',
  go: 'go',
  rust: 'rust',
  rs: 'rust',
  csharp: 'csharp',
  'c#': 'csharp',
  cs: 'csharp',
  cpp: 'cpp',
  'c++': 'cpp',
  c: 'c',
  ruby: 'ruby',
  rb: 'ruby',
  java: 'java',
}

const EXTENSION_LANGUAGES: Record<string, AxiomHighlightLanguage> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  py: 'python', go: 'go', rs: 'rust', cs: 'csharp', c: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp',
  h: 'cpp', hpp: 'cpp', hxx: 'cpp', rb: 'ruby', java: 'java',
}

function shikiLanguage(language: string, path: string): AxiomHighlightLanguage | null {
  const normalized = language.trim().toLowerCase()
  const mapped = LANGUAGE_ALIASES[normalized]
  if (mapped) return mapped
  const extension = path.toLowerCase().match(/\.([^.\\/]+)$/)?.[1] ?? ''
  return EXTENSION_LANGUAGES[extension] ?? null
}

/**
 * Shiki's singleton shorthand lazily imports and caches the requested TextMate
 * grammar and theme. Keeping this behind a dynamic import also leaves the
 * highlighter out of Axiom's initial renderer chunk.
 */
export async function highlightSource(content: string, language: string, path: string): Promise<HighlightedSource> {
  const lang = shikiLanguage(language, path)
  if (!lang) {
    return { tokens: content.split(/\r?\n/).map(line => [{ content: line }]) }
  }
  const { codeToTokens } = await import('./shikiBundle')
  const result = await codeToTokens(content, {
    lang,
    theme: 'dark-modern',
    tokenizeMaxLineLength: 20_000,
  })
  return {
    tokens: result.tokens,
    foreground: result.fg,
    background: result.bg,
  }
}
