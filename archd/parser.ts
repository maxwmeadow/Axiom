import path from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import Parser from 'web-tree-sitter'
import type { AsmNode, AsmDependency } from '../src/shared/types'

export interface ParseResult {
  nodes: AsmNode[]
  dependencies: AsmDependency[]
}

// Language detection by extension
export const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'csharp',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.c': 'c', '.h': 'c', '.hpp': 'cpp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.lua': 'lua',
}

export function hash(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)
}

export function nodeId(filePath: string, symbol?: string): string {
  return symbol ? `sym_${hash(filePath + ':' + symbol)}` : `file_${hash(filePath)}`
}

export function edgeId(src: string, dst: string, type: string): string {
  return `edge_${hash(src + dst + type)}`
}

// ─── Tree-Sitter WASM Loader & Caching ──────────────────────────────────────

const PARSERS_DIR = path.join(os.homedir(), '.axiom', 'parsers')
const TS_LANGUAGES = ['typescript', 'javascript', 'c_sharp', 'python', 'go', 'rust']

const WASM_URLS: Record<string, string> = {
  typescript: 'https://unpkg.com/tree-sitter-wasms@0.1.11/out/tree-sitter-typescript.wasm',
  javascript: 'https://unpkg.com/tree-sitter-wasms@0.1.11/out/tree-sitter-javascript.wasm',
  c_sharp: 'https://unpkg.com/tree-sitter-wasms@0.1.11/out/tree-sitter-c_sharp.wasm',
  python: 'https://unpkg.com/tree-sitter-wasms@0.1.11/out/tree-sitter-python.wasm',
  go: 'https://unpkg.com/tree-sitter-wasms@0.1.11/out/tree-sitter-go.wasm',
  rust: 'https://unpkg.com/tree-sitter-wasms@0.1.11/out/tree-sitter-rust.wasm',
}

const languages: Record<string, Parser.Language> = {}
let parserInitialized = false

export async function initParser(): Promise<void> {
  if (parserInitialized) return

  try {
    await Parser.init()
    fs.mkdirSync(PARSERS_DIR, { recursive: true })

    for (const lang of TS_LANGUAGES) {
      const wasmPath = path.join(PARSERS_DIR, `tree-sitter-${lang}.wasm`)

      if (!fs.existsSync(wasmPath)) {
        console.log(`[archd] Downloading tree-sitter WASM parser for ${lang}...`)
        const url = WASM_URLS[lang]
        const res = await fetch(url)
        if (!res.ok) {
          throw new Error(`Failed to download tree-sitter wasm for ${lang}: ${res.statusText}`)
        }
        const buffer = await res.arrayBuffer()
        fs.writeFileSync(wasmPath, Buffer.from(buffer))
      }

      languages[lang] = await Parser.Language.load(wasmPath)
    }

    parserInitialized = true
    console.log('[archd] Tree-sitter WASM parsers loaded successfully.')
  } catch (err) {
    console.error('[archd] Failed to initialize tree-sitter parser, falling back to regex: ', err)
  }
}

// ─── Legacy Regex Parsers (Fallback) ──────────────────────────────────────

const TS_EXPORT_RE = /^export\s+(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|class\s+(\w+)|const\s+(\w+)|let\s+(\w+)|var\s+(\w+)|type\s+(\w+)|interface\s+(\w+)|enum\s+(\w+))/gm
const TS_IMPORT_RE = /^import\s+(?:type\s+)?(?:\{[^}]+\}|[\w*]+(?:\s+as\s+\w+)?)\s+from\s+['"]([^'"]+)['"]/gm
const TS_REQUIRE_RE = /(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function parseTypeScriptRegex(filePath: string, content: string, rootPath: string): ParseResult {
  const fileNodeId = nodeId(filePath)
  const relPath = path.relative(rootPath, filePath)
  const lineCount = content.split('\n').length
  const lang = LANG_MAP[path.extname(filePath)] ?? 'typescript'

  const fileNode: AsmNode = {
    id: fileNodeId,
    type: 'file',
    layer: 'FILE',
    label: path.basename(filePath),
    filePath,
    language: lang,
    lineCount,
    childCount: 0,
    semanticDepth: 2,
    position: { x: 0, y: 0 },
    metadata: { relativePath: relPath },
  }

  const nodes: AsmNode[] = [fileNode]
  const dependencies: AsmDependency[] = []
  const localSymbols = new Set<string>()

  let match: RegExpExecArray | null
  TS_EXPORT_RE.lastIndex = 0
  while ((match = TS_EXPORT_RE.exec(content)) !== null) {
    const symbolName = match[1] || match[2] || match[3] || match[4] || match[5] || match[6] || match[7] || match[8]
    if (!symbolName) continue
    const symId = nodeId(filePath, symbolName)
    localSymbols.add(symbolName)
    nodes.push({
      id: symId,
      type: 'symbol',
      layer: 'SYMBOL',
      label: symbolName,
      filePath,
      language: lang,
      childCount: 0,
      parentId: fileNodeId,
      semanticDepth: 3,
      position: { x: 0, y: 0 },
      metadata: { kind: match[2] ? 'class' : match[1] ? 'function' : 'variable' },
    })
    dependencies.push({
      id: edgeId(fileNodeId, symId, 'CONTAINS'),
      src: fileNodeId,
      dst: symId,
      type: 'CONTAINS',
      weight: 1,
      active: true,
    })
  }

  const importedFileIds = new Set<string>()
  TS_IMPORT_RE.lastIndex = 0
  while ((match = TS_IMPORT_RE.exec(content)) !== null) {
    const importPath = match[1]
    if (importPath.startsWith('.')) {
      const resolved = resolveLocalImport(filePath, importPath)
      if (resolved) {
        const dstId = nodeId(resolved)
        if (!importedFileIds.has(dstId)) {
          importedFileIds.add(dstId)
          dependencies.push({
            id: edgeId(fileNodeId, dstId, 'IMPORTS'),
            src: fileNodeId,
            dst: dstId,
            type: 'IMPORTS',
            weight: 1,
            active: true,
          })
        }
      }
    }
  }

  TS_REQUIRE_RE.lastIndex = 0
  while ((match = TS_REQUIRE_RE.exec(content)) !== null) {
    const importPath = match[1]
    if (importPath.startsWith('.')) {
      const resolved = resolveLocalImport(filePath, importPath)
      if (resolved) {
        const dstId = nodeId(resolved)
        if (!importedFileIds.has(dstId)) {
          importedFileIds.add(dstId)
          dependencies.push({
            id: edgeId(fileNodeId, dstId, 'IMPORTS'),
            src: fileNodeId,
            dst: dstId,
            type: 'IMPORTS',
            weight: 1,
            active: true,
          })
        }
      }
    }
  }

  return { nodes, dependencies }
}

const CS_NAMESPACE_RE = /^namespace\s+([\w.]+)/m
const CS_CLASS_RE = /^\s*(?:public|private|protected|internal|abstract|sealed|static|partial)[\s\w]*(?:class|interface|struct|enum|record)\s+(\w+)/gm
const CS_METHOD_RE = /^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|new|extern|unsafe)\s+)+(?:[\w<>\[\]?.]+\s+)+(\w+)\s*\([^)]*\)\s*(?:where[^{;]+)?[{;]/gm

function parseCSharpRegex(filePath: string, content: string, rootPath: string): ParseResult {
  const fileNodeId = nodeId(filePath)
  const relPath = path.relative(rootPath, filePath)
  const lineCount = content.split('\n').length

  const nsMatch = content.match(CS_NAMESPACE_RE)
  const namespace = nsMatch ? nsMatch[1] : null

  const fileNode: AsmNode = {
    id: fileNodeId,
    type: 'file',
    layer: 'FILE',
    label: path.basename(filePath),
    filePath,
    language: 'csharp',
    lineCount,
    childCount: 0,
    semanticDepth: 2,
    position: { x: 0, y: 0 },
    metadata: {
      relativePath: relPath,
      ...(namespace ? { namespace } : {}),
    },
  }

  const nodes: AsmNode[] = [fileNode]
  const dependencies: AsmDependency[] = []
  const definedSymbols = new Set<string>()

  let match: RegExpExecArray | null
  CS_CLASS_RE.lastIndex = 0
  while ((match = CS_CLASS_RE.exec(content)) !== null) {
    const name = match[1]
    if (!name || definedSymbols.has(name)) continue
    definedSymbols.add(name)
    const symId = nodeId(filePath, name)
    const kind = match[0].includes('interface') ? 'interface'
      : match[0].includes('struct') ? 'struct'
      : match[0].includes('enum') ? 'enum'
      : 'class'
    nodes.push({
      id: symId,
      type: 'symbol',
      layer: 'SYMBOL',
      label: name,
      filePath,
      language: 'csharp',
      childCount: 0,
      parentId: fileNodeId,
      semanticDepth: 3,
      position: { x: 0, y: 0 },
      metadata: { kind },
    })
    dependencies.push({
      id: edgeId(fileNodeId, symId, 'CONTAINS'),
      src: fileNodeId,
      dst: symId,
      type: 'CONTAINS',
      weight: 1,
      active: true,
    })
  }

  CS_METHOD_RE.lastIndex = 0
  const methodsSeen = new Set<string>()
  while ((match = CS_METHOD_RE.exec(content)) !== null) {
    const name = match[1]
    if (!name || methodsSeen.has(name) || definedSymbols.has(name)) continue
    if (['if', 'for', 'while', 'foreach', 'switch', 'catch', 'using', 'lock', 'return', 'new'].includes(name)) continue
    methodsSeen.add(name)
    const symId = nodeId(filePath, name)
    nodes.push({
      id: symId,
      type: 'symbol',
      layer: 'SYMBOL',
      label: name,
      filePath,
      language: 'csharp',
      childCount: 0,
      parentId: fileNodeId,
      semanticDepth: 3,
      position: { x: 0, y: 0 },
      metadata: { kind: 'method' },
    })
    dependencies.push({
      id: edgeId(fileNodeId, symId, 'CONTAINS'),
      src: fileNodeId,
      dst: symId,
      type: 'CONTAINS',
      weight: 1,
      active: true,
    })
  }

  return { nodes, dependencies }
}

const PY_DEF_RE = /^(?:async\s+)?def\s+(\w+)\s*\(/gm
const PY_CLASS_RE = /^class\s+(\w+)\s*[:(]/gm

function parsePythonRegex(filePath: string, content: string, rootPath: string): ParseResult {
  const fileNodeId = nodeId(filePath)
  const relPath = path.relative(rootPath, filePath)
  const lineCount = content.split('\n').length

  const fileNode: AsmNode = {
    id: fileNodeId,
    type: 'file',
    layer: 'FILE',
    label: path.basename(filePath),
    filePath,
    language: 'python',
    lineCount,
    childCount: 0,
    semanticDepth: 2,
    position: { x: 0, y: 0 },
    metadata: { relativePath: relPath },
  }

  const nodes: AsmNode[] = [fileNode]
  const dependencies: AsmDependency[] = []

  let match: RegExpExecArray | null
  const seen = new Set<string>()

  PY_CLASS_RE.lastIndex = 0
  while ((match = PY_CLASS_RE.exec(content)) !== null) {
    if (seen.has(match[1])) continue
    seen.add(match[1])
    const symId = nodeId(filePath, match[1])
    nodes.push({
      id: symId, type: 'symbol', layer: 'SYMBOL', label: match[1], filePath,
      language: 'python', childCount: 0, parentId: fileNodeId, semanticDepth: 3,
      position: { x: 0, y: 0 }, metadata: { kind: 'class' },
    })
    dependencies.push({ id: edgeId(fileNodeId, symId, 'CONTAINS'), src: fileNodeId, dst: symId, type: 'CONTAINS', weight: 1, active: true })
  }

  PY_DEF_RE.lastIndex = 0
  while ((match = PY_DEF_RE.exec(content)) !== null) {
    if (seen.has(match[1])) continue
    seen.add(match[1])
    const symId = nodeId(filePath, match[1])
    nodes.push({
      id: symId, type: 'symbol', layer: 'SYMBOL', label: match[1], filePath,
      language: 'python', childCount: 0, parentId: fileNodeId, semanticDepth: 3,
      position: { x: 0, y: 0 }, metadata: { kind: 'function' },
    })
    dependencies.push({ id: edgeId(fileNodeId, symId, 'CONTAINS'), src: fileNodeId, dst: symId, type: 'CONTAINS', weight: 1, active: true })
  }

  return { nodes, dependencies }
}

const GO_FUNC_RE = /^func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?(\w+)\s*\(/gm
const GO_TYPE_RE = /^type\s+(\w+)\s+(?:struct|interface)/gm

function parseGoRegex(filePath: string, content: string, rootPath: string): ParseResult {
  const fileNodeId = nodeId(filePath)
  const relPath = path.relative(rootPath, filePath)
  const lineCount = content.split('\n').length

  const fileNode: AsmNode = {
    id: fileNodeId, type: 'file', layer: 'FILE',
    label: path.basename(filePath), filePath, language: 'go', lineCount,
    childCount: 0, semanticDepth: 2, position: { x: 0, y: 0 },
    metadata: { relativePath: relPath },
  }

  const nodes: AsmNode[] = [fileNode]
  const dependencies: AsmDependency[] = []
  const seen = new Set<string>()

  let match: RegExpExecArray | null
  GO_TYPE_RE.lastIndex = 0
  while ((match = GO_TYPE_RE.exec(content)) !== null) {
    if (seen.has(match[1])) continue
    seen.add(match[1])
    const symId = nodeId(filePath, match[1])
    nodes.push({ id: symId, type: 'symbol', layer: 'SYMBOL', label: match[1], filePath, language: 'go', childCount: 0, parentId: fileNodeId, semanticDepth: 3, position: { x: 0, y: 0 }, metadata: { kind: 'type' } })
    dependencies.push({ id: edgeId(fileNodeId, symId, 'CONTAINS'), src: fileNodeId, dst: symId, type: 'CONTAINS', weight: 1, active: true })
  }

  GO_FUNC_RE.lastIndex = 0
  while ((match = GO_FUNC_RE.exec(content)) !== null) {
    if (seen.has(match[1])) continue
    seen.add(match[1])
    const symId = nodeId(filePath, match[1])
    nodes.push({ id: symId, type: 'symbol', layer: 'SYMBOL', label: match[1], filePath, language: 'go', childCount: 0, parentId: fileNodeId, semanticDepth: 3, position: { x: 0, y: 0 }, metadata: { kind: 'function' } })
    dependencies.push({ id: edgeId(fileNodeId, symId, 'CONTAINS'), src: fileNodeId, dst: symId, type: 'CONTAINS', weight: 1, active: true })
  }

  return { nodes, dependencies }
}

const RS_FN_RE = /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*[(<]/gm
const RS_STRUCT_RE = /^(?:pub\s+)?(?:struct|enum|trait|impl)\s+(\w+)/gm

function parseRustRegex(filePath: string, content: string, rootPath: string): ParseResult {
  const fileNodeId = nodeId(filePath)
  const fileNode: AsmNode = {
    id: fileNodeId, type: 'file', layer: 'FILE',
    label: path.basename(filePath), filePath, language: 'rust',
    lineCount: content.split('\n').length, childCount: 0, semanticDepth: 2,
    position: { x: 0, y: 0 },
    metadata: { relativePath: path.relative(rootPath, filePath) },
  }
  const nodes: AsmNode[] = [fileNode]
  const dependencies: AsmDependency[] = []
  const seen = new Set<string>()

  let match: RegExpExecArray | null
  RS_STRUCT_RE.lastIndex = 0
  while ((match = RS_STRUCT_RE.exec(content)) !== null) {
    if (seen.has(match[1])) continue
    seen.add(match[1])
    const symId = nodeId(filePath, match[1])
    const kind = match[0].startsWith('pub struct') || match[0].startsWith('struct') ? 'struct' : match[0].includes('enum') ? 'enum' : match[0].includes('trait') ? 'trait' : 'impl'
    nodes.push({ id: symId, type: 'symbol', layer: 'SYMBOL', label: match[1], filePath, language: 'rust', childCount: 0, parentId: fileNodeId, semanticDepth: 3, position: { x: 0, y: 0 }, metadata: { kind } })
    dependencies.push({ id: edgeId(fileNodeId, symId, 'CONTAINS'), src: fileNodeId, dst: symId, type: 'CONTAINS', weight: 1, active: true })
  }

  RS_FN_RE.lastIndex = 0
  while ((match = RS_FN_RE.exec(content)) !== null) {
    if (seen.has(match[1])) continue
    seen.add(match[1])
    const symId = nodeId(filePath, match[1])
    nodes.push({ id: symId, type: 'symbol', layer: 'SYMBOL', label: match[1], filePath, language: 'rust', childCount: 0, parentId: fileNodeId, semanticDepth: 3, position: { x: 0, y: 0 }, metadata: { kind: 'function' } })
    dependencies.push({ id: edgeId(fileNodeId, symId, 'CONTAINS'), src: fileNodeId, dst: symId, type: 'CONTAINS', weight: 1, active: true })
  }
  return { nodes, dependencies }
}

const JAVA_CLASS_RE = /^\s*(?:public|private|protected|abstract|final|static)?\s*(?:class|interface|enum|record)\s+(\w+)/gm
const JAVA_METHOD_RE = /^\s*(?:public|private|protected|static|final|abstract|synchronized|native)[\s\w<>[\]?]+\s+(\w+)\s*\([^)]*\)\s*(?:throws[\w,\s]+)?[{;]/gm

function parseJava(filePath: string, content: string, rootPath: string): ParseResult {
  const fileNodeId = nodeId(filePath)
  const fileNode: AsmNode = {
    id: fileNodeId, type: 'file', layer: 'FILE',
    label: path.basename(filePath), filePath, language: 'java',
    lineCount: content.split('\n').length, childCount: 0, semanticDepth: 2,
    position: { x: 0, y: 0 },
    metadata: { relativePath: path.relative(rootPath, filePath) },
  }
  const nodes: AsmNode[] = [fileNode]
  const dependencies: AsmDependency[] = []
  const seen = new Set<string>()

  let match: RegExpExecArray | null
  JAVA_CLASS_RE.lastIndex = 0
  while ((match = JAVA_CLASS_RE.exec(content)) !== null) {
    if (seen.has(match[1])) continue
    seen.add(match[1])
    const symId = nodeId(filePath, match[1])
    const kind = match[0].includes('interface') ? 'interface' : match[0].includes('enum') ? 'enum' : 'class'
    nodes.push({ id: symId, type: 'symbol', layer: 'SYMBOL', label: match[1], filePath, language: 'java', childCount: 0, parentId: fileNodeId, semanticDepth: 3, position: { x: 0, y: 0 }, metadata: { kind } })
    dependencies.push({ id: edgeId(fileNodeId, symId, 'CONTAINS'), src: fileNodeId, dst: symId, type: 'CONTAINS', weight: 1, active: true })
  }

  JAVA_METHOD_RE.lastIndex = 0
  while ((match = JAVA_METHOD_RE.exec(content)) !== null) {
    const name = match[1]
    if (!name || seen.has(name)) continue
    if (['if', 'for', 'while', 'switch', 'catch'].includes(name)) continue
    seen.add(name)
    const symId = nodeId(filePath, name)
    nodes.push({ id: symId, type: 'symbol', layer: 'SYMBOL', label: name, filePath, language: 'java', childCount: 0, parentId: fileNodeId, semanticDepth: 3, position: { x: 0, y: 0 }, metadata: { kind: 'method' } })
    dependencies.push({ id: edgeId(fileNodeId, symId, 'CONTAINS'), src: fileNodeId, dst: symId, type: 'CONTAINS', weight: 1, active: true })
  }
  return { nodes, dependencies }
}

const LUA_FUNC_RE = /^(?:local\s+)?function\s+(\w+(?:\.\w+)?)\s*\(/gm
const LUA_METHOD_RE = /^function\s+(\w+):(\w+)\s*\(/gm

function parseLua(filePath: string, content: string, rootPath: string): ParseResult {
  const fileNodeId = nodeId(filePath)
  const fileNode: AsmNode = {
    id: fileNodeId, type: 'file', layer: 'FILE',
    label: path.basename(filePath), filePath, language: 'lua',
    lineCount: content.split('\n').length, childCount: 0, semanticDepth: 2,
    position: { x: 0, y: 0 },
    metadata: { relativePath: path.relative(rootPath, filePath) },
  }
  const nodes: AsmNode[] = [fileNode]
  const dependencies: AsmDependency[] = []
  const seen = new Set<string>()

  let match: RegExpExecArray | null
  LUA_FUNC_RE.lastIndex = 0
  while ((match = LUA_FUNC_RE.exec(content)) !== null) {
    const name = match[1].replace('.', '_')
    if (seen.has(name)) continue
    seen.add(name)
    const symId = nodeId(filePath, name)
    nodes.push({ id: symId, type: 'symbol', layer: 'SYMBOL', label: name, filePath, language: 'lua', childCount: 0, parentId: fileNodeId, semanticDepth: 3, position: { x: 0, y: 0 }, metadata: { kind: 'function' } })
    dependencies.push({ id: edgeId(fileNodeId, symId, 'CONTAINS'), src: fileNodeId, dst: symId, type: 'CONTAINS', weight: 1, active: true })
  }

  LUA_METHOD_RE.lastIndex = 0
  while ((match = LUA_METHOD_RE.exec(content)) !== null) {
    const name = `${match[1]}:${match[2]}`
    if (seen.has(name)) continue
    seen.add(name)
    const symId = nodeId(filePath, name)
    nodes.push({ id: symId, type: 'symbol', layer: 'SYMBOL', label: name, filePath, language: 'lua', childCount: 0, parentId: fileNodeId, semanticDepth: 3, position: { x: 0, y: 0 }, metadata: { kind: 'method' } })
    dependencies.push({ id: edgeId(fileNodeId, symId, 'CONTAINS'), src: fileNodeId, dst: symId, type: 'CONTAINS', weight: 1, active: true })
  }
  return { nodes, dependencies }
}

// ─── Tree-Sitter AST Traversal Parsers ──────────────────────────────────────

function parseTypeScriptTreeSitter(filePath: string, content: string, rootPath: string, langName: 'typescript' | 'javascript'): ParseResult {
  const fileNodeId = nodeId(filePath)
  const relPath = path.relative(rootPath, filePath)
  const lineCount = content.split('\n').length

  const fileNode: AsmNode = {
    id: fileNodeId,
    type: 'file',
    layer: 'FILE',
    label: path.basename(filePath),
    filePath,
    language: langName,
    lineCount,
    childCount: 0,
    semanticDepth: 2,
    position: { x: 0, y: 0 },
    metadata: { relativePath: relPath },
  }

  const nodes: AsmNode[] = [fileNode]
  const dependencies: AsmDependency[] = []
  const localSymbols = new Set<string>()

  const parser = new Parser()
  parser.setLanguage(languages[langName])
  const tree = parser.parse(content)

  const importedPaths = new Set<string>()
  const methodCalls = new Set<string>()

  function traverse(node: Parser.SyntaxNode, currentParentSymbolId: string | null) {
    let nextParentId = currentParentSymbolId

    // 1. Imports detection
    if (node.type === 'import_statement' || node.type === 'export_statement') {
      const sourceNode = node.childForFieldName('source') || node.descendantsOfType('string')[0]
      if (sourceNode) {
        const importText = sourceNode.text.replace(/['"]/g, '')
        if (importText.startsWith('.')) {
          const resolved = resolveLocalImport(filePath, importText)
          if (resolved) importedPaths.add(resolved)
        }
      }
    }

    // Require calls
    if (node.type === 'call_expression') {
      const functionNode = node.child(0)
      if (functionNode && functionNode.type === 'identifier' && functionNode.text === 'require') {
        const argNode = node.child(1)?.child(1)
        if (argNode && (argNode.type === 'string' || argNode.type === 'string_fragment')) {
          const importText = argNode.text.replace(/['"]/g, '')
          if (importText.startsWith('.')) {
            const resolved = resolveLocalImport(filePath, importText)
            if (resolved) importedPaths.add(resolved)
          }
        }
      }
    }

    // 2. Class/Function/Interface/Enum declarations
    let isSymbol = false
    let symbolType: string | null = null
    let symbolName: string | null = null

    if (node.type === 'class_declaration') {
      isSymbol = true
      symbolType = 'class'
      symbolName = node.childForFieldName('name')?.text ?? null
    } else if (node.type === 'function_declaration') {
      isSymbol = true
      symbolType = 'function'
      symbolName = node.childForFieldName('name')?.text ?? null
    } else if (node.type === 'method_definition') {
      isSymbol = true
      symbolType = 'method'
      symbolName = node.childForFieldName('name')?.text ?? null
    } else if (node.type === 'interface_declaration') {
      isSymbol = true
      symbolType = 'interface'
      symbolName = node.childForFieldName('name')?.text ?? null
    } else if (node.type === 'enum_declaration') {
      isSymbol = true
      symbolType = 'enum'
      symbolName = node.childForFieldName('name')?.text ?? null
    }

    if (isSymbol && symbolName) {
      const symId = nodeId(filePath, symbolName)
      localSymbols.add(symbolName)

      nodes.push({
        id: symId,
        type: 'symbol',
        layer: 'SYMBOL',
        label: symbolName,
        filePath,
        language: langName,
        childCount: 0,
        parentId: fileNodeId,
        semanticDepth: 3,
        position: { x: 0, y: 0 },
        metadata: { kind: symbolType },
      })

      dependencies.push({
        id: edgeId(fileNodeId, symId, 'CONTAINS'),
        src: fileNodeId,
        dst: symId,
        type: 'CONTAINS',
        weight: 1,
        active: true,
      })

      nextParentId = symId
    }

    // 3. Method Calls
    if (node.type === 'call_expression') {
      const fnNode = node.childForFieldName('function')
      if (fnNode) {
        if (fnNode.type === 'identifier') {
          methodCalls.add(fnNode.text)
        } else if (fnNode.type === 'member_expression') {
          const propertyNode = fnNode.childForFieldName('property')
          if (propertyNode) {
            methodCalls.add(propertyNode.text)
          }
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      traverse(node.child(i)!, nextParentId)
    }
  }

  traverse(tree.rootNode, null)

  // Add import dependencies
  for (const dstPath of importedPaths) {
    const dstId = nodeId(dstPath)
    dependencies.push({
      id: edgeId(fileNodeId, dstId, 'IMPORTS'),
      src: fileNodeId,
      dst: dstId,
      type: 'IMPORTS',
      weight: 1,
      active: true,
    })
  }

  fileNode.metadata.methodCalls = Array.from(methodCalls)
  return { nodes, dependencies }
}

function parseCSharpTreeSitter(filePath: string, content: string, rootPath: string): ParseResult {
  const fileNodeId = nodeId(filePath)
  const relPath = path.relative(rootPath, filePath)
  const lineCount = content.split('\n').length

  const parser = new Parser()
  parser.setLanguage(languages['c_sharp'])
  const tree = parser.parse(content)

  let namespace: string | null = null
  const nodes: AsmNode[] = []
  const dependencies: AsmDependency[] = []
  const definedSymbols = new Set<string>()
  const methodCalls = new Set<string>()
  const importedNamespaces = new Set<string>()

  function traverse(node: Parser.SyntaxNode, currentParentSymbolId: string | null) {
    let nextParentId = currentParentSymbolId

    if (node.type === 'namespace_declaration' || node.type === 'file_scoped_namespace_declaration') {
      const nameNode = node.childForFieldName('name')
      if (nameNode) namespace = nameNode.text
    }

    if (node.type === 'using_directive') {
      const nameNode = node.child(1)
      if (nameNode) importedNamespaces.add(nameNode.text)
    }

    let isSymbol = false
    let symbolType: string | null = null
    let symbolName: string | null = null

    if (node.type === 'class_declaration') {
      isSymbol = true
      symbolType = 'class'
      symbolName = node.childForFieldName('name')?.text ?? null
    } else if (node.type === 'interface_declaration') {
      isSymbol = true
      symbolType = 'interface'
      symbolName = node.childForFieldName('name')?.text ?? null
    } else if (node.type === 'struct_declaration') {
      isSymbol = true
      symbolType = 'struct'
      symbolName = node.childForFieldName('name')?.text ?? null
    } else if (node.type === 'enum_declaration') {
      isSymbol = true
      symbolType = 'enum'
      symbolName = node.childForFieldName('name')?.text ?? null
    } else if (node.type === 'record_declaration') {
      isSymbol = true
      symbolType = 'record'
      symbolName = node.childForFieldName('name')?.text ?? null
    } else if (node.type === 'method_declaration') {
      isSymbol = true
      symbolType = 'method'
      symbolName = node.childForFieldName('name')?.text ?? null
    } else if (node.type === 'constructor_declaration') {
      isSymbol = true
      symbolType = 'constructor'
      symbolName = node.childForFieldName('name')?.text ?? null
    }

    if (isSymbol && symbolName) {
      if (!definedSymbols.has(symbolName)) {
        definedSymbols.add(symbolName)
        const symId = nodeId(filePath, symbolName)

        nodes.push({
          id: symId,
          type: 'symbol',
          layer: 'SYMBOL',
          label: symbolName,
          filePath,
          language: 'csharp',
          childCount: 0,
          parentId: fileNodeId,
          semanticDepth: 3,
          position: { x: 0, y: 0 },
          metadata: { kind: symbolType },
        })

        dependencies.push({
          id: edgeId(fileNodeId, symId, 'CONTAINS'),
          src: fileNodeId,
          dst: symId,
          type: 'CONTAINS',
          weight: 1,
          active: true,
        })

        nextParentId = symId
      }
    }

    if (node.type === 'invocation_expression') {
      const expr = node.childForFieldName('expression')
      if (expr) {
        if (expr.type === 'identifier') {
          methodCalls.add(expr.text)
        } else if (expr.type === 'member_access_expression') {
          const nameNode = expr.childForFieldName('name')
          if (nameNode) methodCalls.add(nameNode.text)
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      traverse(node.child(i)!, nextParentId)
    }
  }

  traverse(tree.rootNode, null)

  const fileNode: AsmNode = {
    id: fileNodeId,
    type: 'file',
    layer: 'FILE',
    label: path.basename(filePath),
    filePath,
    language: 'csharp',
    lineCount,
    childCount: 0,
    semanticDepth: 2,
    position: { x: 0, y: 0 },
    metadata: {
      relativePath: relPath,
      ...(namespace ? { namespace } : {}),
      methodCalls: Array.from(methodCalls),
      importedNamespaces: Array.from(importedNamespaces),
    },
  }

  nodes.unshift(fileNode)
  return { nodes, dependencies }
}

function parsePythonTreeSitter(filePath: string, content: string, rootPath: string): ParseResult {
  const fileNodeId = nodeId(filePath)
  const relPath = path.relative(rootPath, filePath)
  const lineCount = content.split('\n').length

  const parser = new Parser()
  parser.setLanguage(languages['python'])
  const tree = parser.parse(content)

  const nodes: AsmNode[] = []
  const dependencies: AsmDependency[] = []
  const seen = new Set<string>()
  const methodCalls = new Set<string>()

  function traverse(node: Parser.SyntaxNode) {
    let isSymbol = false
    let symbolType: string | null = null
    let symbolName: string | null = null

    if (node.type === 'class_definition') {
      isSymbol = true
      symbolType = 'class'
      symbolName = node.childForFieldName('name')?.text ?? null
    } else if (node.type === 'function_definition') {
      isSymbol = true
      symbolType = 'function'
      symbolName = node.childForFieldName('name')?.text ?? null
    }

    if (isSymbol && symbolName && !seen.has(symbolName)) {
      seen.add(symbolName)
      const symId = nodeId(filePath, symbolName)
      nodes.push({
        id: symId,
        type: 'symbol',
        layer: 'SYMBOL',
        label: symbolName,
        filePath,
        language: 'python',
        childCount: 0,
        parentId: fileNodeId,
        semanticDepth: 3,
        position: { x: 0, y: 0 },
        metadata: { kind: symbolType },
      })
      dependencies.push({
        id: edgeId(fileNodeId, symId, 'CONTAINS'),
        src: fileNodeId,
        dst: symId,
        type: 'CONTAINS',
        weight: 1,
        active: true,
      })
    }

    if (node.type === 'call') {
      const functionNode = node.childForFieldName('function')
      if (functionNode) {
        if (functionNode.type === 'identifier') {
          methodCalls.add(functionNode.text)
        } else if (functionNode.type === 'attribute') {
          const attributeNode = functionNode.childForFieldName('attribute')
          if (attributeNode) methodCalls.add(attributeNode.text)
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      traverse(node.child(i)!)
    }
  }

  traverse(tree.rootNode)

  const fileNode: AsmNode = {
    id: fileNodeId,
    type: 'file',
    layer: 'FILE',
    label: path.basename(filePath),
    filePath,
    language: 'python',
    lineCount,
    childCount: 0,
    semanticDepth: 2,
    position: { x: 0, y: 0 },
    metadata: {
      relativePath: relPath,
      methodCalls: Array.from(methodCalls),
    },
  }
  nodes.unshift(fileNode)
  return { nodes, dependencies }
}

function parseGoTreeSitter(filePath: string, content: string, rootPath: string): ParseResult {
  const fileNodeId = nodeId(filePath)
  const relPath = path.relative(rootPath, filePath)
  const lineCount = content.split('\n').length

  const parser = new Parser()
  parser.setLanguage(languages['go'])
  const tree = parser.parse(content)

  const nodes: AsmNode[] = []
  const dependencies: AsmDependency[] = []
  const seen = new Set<string>()
  const methodCalls = new Set<string>()

  function traverse(node: Parser.SyntaxNode) {
    let isSymbol = false
    let symbolType: string | null = null
    let symbolName: string | null = null

    if (node.type === 'function_declaration') {
      isSymbol = true
      symbolType = 'function'
      symbolName = node.childForFieldName('name')?.text ?? null
    } else if (node.type === 'method_declaration') {
      isSymbol = true
      symbolType = 'method'
      symbolName = node.childForFieldName('name')?.text ?? null
    } else if (node.type === 'type_spec') {
      isSymbol = true
      symbolType = 'type'
      symbolName = node.childForFieldName('name')?.text ?? null
    }

    if (isSymbol && symbolName && !seen.has(symbolName)) {
      seen.add(symbolName)
      const symId = nodeId(filePath, symbolName)
      nodes.push({
        id: symId,
        type: 'symbol',
        layer: 'SYMBOL',
        label: symbolName,
        filePath,
        language: 'go',
        childCount: 0,
        parentId: fileNodeId,
        semanticDepth: 3,
        position: { x: 0, y: 0 },
        metadata: { kind: symbolType },
      })
      dependencies.push({
        id: edgeId(fileNodeId, symId, 'CONTAINS'),
        src: fileNodeId,
        dst: symId,
        type: 'CONTAINS',
        weight: 1,
        active: true,
      })
    }

    if (node.type === 'call_expression') {
      const functionNode = node.childForFieldName('function')
      if (functionNode) {
        if (functionNode.type === 'identifier') {
          methodCalls.add(functionNode.text)
        } else if (functionNode.type === 'selector_expression') {
          const fieldNode = functionNode.childForFieldName('field')
          if (fieldNode) methodCalls.add(fieldNode.text)
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      traverse(node.child(i)!)
    }
  }

  traverse(tree.rootNode)

  const fileNode: AsmNode = {
    id: fileNodeId,
    type: 'file',
    layer: 'FILE',
    label: path.basename(filePath),
    filePath,
    language: 'go',
    lineCount,
    childCount: 0,
    semanticDepth: 2,
    position: { x: 0, y: 0 },
    metadata: {
      relativePath: relPath,
      methodCalls: Array.from(methodCalls),
    },
  }
  nodes.unshift(fileNode)
  return { nodes, dependencies }
}

function parseRustTreeSitter(filePath: string, content: string, rootPath: string): ParseResult {
  const fileNodeId = nodeId(filePath)
  const relPath = path.relative(rootPath, filePath)
  const lineCount = content.split('\n').length

  const parser = new Parser()
  parser.setLanguage(languages['rust'])
  const tree = parser.parse(content)

  const nodes: AsmNode[] = []
  const dependencies: AsmDependency[] = []
  const seen = new Set<string>()
  const methodCalls = new Set<string>()

  function traverse(node: Parser.SyntaxNode) {
    let isSymbol = false
    let symbolType: string | null = null
    let symbolName: string | null = null

    if (node.type === 'function_item') {
      isSymbol = true
      symbolType = 'function'
      symbolName = node.childForFieldName('name')?.text ?? null
    } else if (node.type === 'struct_item') {
      isSymbol = true
      symbolType = 'struct'
      symbolName = node.childForFieldName('name')?.text ?? null
    } else if (node.type === 'enum_item') {
      isSymbol = true
      symbolType = 'enum'
      symbolName = node.childForFieldName('name')?.text ?? null
    } else if (node.type === 'trait_item') {
      isSymbol = true
      symbolType = 'trait'
      symbolName = node.childForFieldName('name')?.text ?? null
    } else if (node.type === 'impl_item') {
      isSymbol = true
      symbolType = 'impl'
      const typeNode = node.childForFieldName('type')
      symbolName = typeNode ? `impl_${typeNode.text}` : 'impl_block'
    }

    if (isSymbol && symbolName && !seen.has(symbolName)) {
      seen.add(symbolName)
      const symId = nodeId(filePath, symbolName)
      nodes.push({
        id: symId,
        type: 'symbol',
        layer: 'SYMBOL',
        label: symbolName,
        filePath,
        language: 'rust',
        childCount: 0,
        parentId: fileNodeId,
        semanticDepth: 3,
        position: { x: 0, y: 0 },
        metadata: { kind: symbolType },
      })
      dependencies.push({
        id: edgeId(fileNodeId, symId, 'CONTAINS'),
        src: fileNodeId,
        dst: symId,
        type: 'CONTAINS',
        weight: 1,
        active: true,
      })
    }

    if (node.type === 'call_expression') {
      const functionNode = node.childForFieldName('function')
      if (functionNode) {
        if (functionNode.type === 'identifier') {
          methodCalls.add(functionNode.text)
        } else if (functionNode.type === 'field_expression') {
          const fieldNode = functionNode.childForFieldName('field')
          if (fieldNode) methodCalls.add(fieldNode.text)
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      traverse(node.child(i)!)
    }
  }

  traverse(tree.rootNode)

  const fileNode: AsmNode = {
    id: fileNodeId,
    type: 'file',
    layer: 'FILE',
    label: path.basename(filePath),
    filePath,
    language: 'rust',
    lineCount,
    childCount: 0,
    semanticDepth: 2,
    position: { x: 0, y: 0 },
    metadata: {
      relativePath: relPath,
      methodCalls: Array.from(methodCalls),
    },
  }
  nodes.unshift(fileNode)
  return { nodes, dependencies }
}

// ─── Module/Directory Node Builder ─────────────────────────────────────────

export function buildModuleNodes(
  rootPath: string,
  filePaths: string[]
): { nodes: AsmNode[]; dependencies: AsmDependency[]; fileParentMap: Map<string, string> } {
  const nodes: AsmNode[] = []
  const dependencies: AsmDependency[] = []
  const dirSet = new Set<string>()

  for (const fp of filePaths) {
    let dir = path.dirname(fp)
    while (dir.length >= rootPath.length) {
      dirSet.add(dir)
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }

  const dirs = [...dirSet].sort((a, b) => a.length - b.length)
  const rootDepth = rootPath.split(path.sep).length

  for (const dir of dirs) {
    const isRoot = dir === rootPath
    const relDir = path.relative(rootPath, dir)
    const modId = `mod_${hash(dir)}`
    const label = isRoot ? path.basename(rootPath) : path.basename(dir)
    const dirDepth = dir.split(path.sep).length
    const semanticDepth = isRoot ? 0 : Math.min(1, dirDepth - rootDepth)

    const parentDir = path.dirname(dir)
    const parentId = (!isRoot && parentDir !== dir && parentDir.length >= rootPath.length)
      ? `mod_${hash(parentDir)}`
      : undefined

    nodes.push({
      id: modId,
      type: isRoot ? 'service' : 'module',
      layer: isRoot ? 'SERVICE' : 'MODULE',
      label,
      childCount: 0,
      parentId,
      semanticDepth: isRoot ? 0 : semanticDepth,
      position: { x: 0, y: 0 },
      metadata: { dirPath: dir, relativePath: relDir || '.' },
    })

    if (parentId) {
      dependencies.push({
        id: edgeId(parentId, modId, 'CONTAINS'),
        src: parentId,
        dst: modId,
        type: 'CONTAINS',
        weight: 1,
        active: true,
      })
    }
  }

  const fileParentMap = new Map<string, string>()
  for (const fp of filePaths) {
    const dir = path.dirname(fp)
    const modId = `mod_${hash(dir)}`
    const fileId = nodeId(fp)
    fileParentMap.set(fp, modId)
    dependencies.push({
      id: edgeId(modId, fileId, 'CONTAINS'),
      src: modId,
      dst: fileId,
      type: 'CONTAINS',
      weight: 1,
      active: true,
    })
  }

  return { nodes, dependencies, fileParentMap }
}

// ─── Top-level entry point ─────────────────────────────────────────────────

export function parseFile(filePath: string, rootPath: string): ParseResult | null {
  const ext = path.extname(filePath).toLowerCase()
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }

  const useTreeSitter = parserInitialized

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    const lang = ['.ts', '.tsx'].includes(ext) ? 'typescript' : 'javascript'
    return useTreeSitter
      ? parseTypeScriptTreeSitter(filePath, content, rootPath, lang)
      : parseTypeScriptRegex(filePath, content, rootPath)
  }
  if (ext === '.cs') {
    return useTreeSitter
      ? parseCSharpTreeSitter(filePath, content, rootPath)
      : parseCSharpRegex(filePath, content, rootPath)
  }
  if (ext === '.py') {
    return useTreeSitter
      ? parsePythonTreeSitter(filePath, content, rootPath)
      : parsePythonRegex(filePath, content, rootPath)
  }
  if (ext === '.go') {
    return useTreeSitter
      ? parseGoTreeSitter(filePath, content, rootPath)
      : parseGoRegex(filePath, content, rootPath)
  }
  if (['.rs'].includes(ext)) {
    return useTreeSitter
      ? parseRustTreeSitter(filePath, content, rootPath)
      : parseRustRegex(filePath, content, rootPath)
  }
  if (['.java'].includes(ext)) return parseJava(filePath, content, rootPath)
  if (['.lua'].includes(ext)) return parseLua(filePath, content, rootPath)

  // Generic file node for other recognized types
  const fileNodeId = nodeId(filePath)
  return {
    nodes: [{
      id: fileNodeId,
      type: 'file',
      layer: 'FILE',
      label: path.basename(filePath),
      filePath,
      language: LANG_MAP[ext] ?? 'unknown',
      lineCount: content.split('\n').length,
      childCount: 0,
      semanticDepth: 2,
      position: { x: 0, y: 0 },
      metadata: { relativePath: path.relative(rootPath, filePath) },
    }],
    dependencies: [],
  }
}

// ─── Resolve local imports ─────────────────────────────────────────────────

function resolveLocalImport(fromFile: string, importPath: string): string | null {
  const dir = path.dirname(fromFile)
  const candidates = [
    importPath,
    `${importPath}.ts`,
    `${importPath}.tsx`,
    `${importPath}.js`,
    `${importPath}.jsx`,
    `${importPath}/index.ts`,
    `${importPath}/index.tsx`,
    `${importPath}/index.js`,
  ]
  for (const candidate of candidates) {
    const resolved = path.resolve(dir, candidate)
    if (fs.existsSync(resolved)) return resolved
  }
  return null
}

export { nodeId as computeNodeId, hash as computeHash }
