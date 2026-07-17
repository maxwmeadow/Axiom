import { createBundledHighlighter, createSingletonShorthands } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import { darkModernTheme } from './darkModernTheme'

const createAxiomHighlighter = createBundledHighlighter({
  langs: {
    typescript: () => import('@shikijs/langs/typescript'),
    tsx: () => import('@shikijs/langs/tsx'),
    javascript: () => import('@shikijs/langs/javascript'),
    jsx: () => import('@shikijs/langs/jsx'),
    python: () => import('@shikijs/langs/python'),
    go: () => import('@shikijs/langs/go'),
    rust: () => import('@shikijs/langs/rust'),
    csharp: () => import('@shikijs/langs/csharp'),
    c: () => import('@shikijs/langs/c'),
    cpp: () => import('@shikijs/langs/cpp'),
    ruby: () => import('@shikijs/langs/ruby'),
    java: () => import('@shikijs/langs/java'),
  },
  themes: {
    'dark-modern': darkModernTheme,
  },
  engine: () => createOnigurumaEngine(import('shiki/wasm')),
})

export const { codeToTokens } = createSingletonShorthands(createAxiomHighlighter)
