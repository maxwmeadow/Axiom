export type ProjectFileKind = 'folder' | 'source' | 'document' | 'unsupported'

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx',
  '.py', '.go', '.rs', '.cs',
  '.cpp', '.cc', '.cxx', '.hpp', '.hxx',
  '.rb', '.java',
])

const DOCUMENT_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc'])

function extensionOf(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

export function classifyProjectFile(path: string, isDirectory = false): ProjectFileKind {
  if (isDirectory) return 'folder'
  const extension = extensionOf(path)
  if (SOURCE_EXTENSIONS.has(extension)) return 'source'
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document'
  return 'unsupported'
}

export function isDocumentationFile(file: { language?: string; relPath: string }): boolean {
  return file.language === 'markdown' || file.language === 'text' ||
    classifyProjectFile(file.relPath) === 'document'
}

export function isCanvasSourceFile(file: { language?: string; relPath: string }): boolean {
  return !isDocumentationFile(file) && classifyProjectFile(file.relPath) === 'source'
}
