'use strict'
// AST instrumentation — the heart of the Node adapter.
//
// Every function in a watched workspace file is rewritten at load time to call
// into the main-thread runtime (globalThis.__axiom) on entry, return, throw,
// and exit. Instrumentation is UNCONDITIONAL (all functions), but the enter
// hook returns a shared inactive context in O(1) when the function isn't
// watched, so unwatched code stays near-native. Watches (and injections) can
// therefore be toggled at runtime with zero reload.
//
// Original:                          Instrumented:
//   function f(a, b) {                 function f(a, b) {
//     return a + b;                      const __axm = G.enter("file","f",12,[a,b],["a","b"]);
//   }                                    if (__axm.o) { if ("a" in __axm.o) a = __axm.o.a; ... }
//                                        try { return G.ret(__axm, (a + b)); }
//                                        catch (__axe) { G.error(__axm, __axe); throw __axe; }
//                                        finally { G.exit(__axm); }
//                                      }
//
// Only simple identifier params (incl. defaulted) are captured/injectable —
// destructured/rest params are skipped for capture (mirrors the Python
// adapter's pragmatic arg handling).

const acorn = require('acorn')
const MagicString = require('magic-string')

const G = 'globalThis.__axiom'

// Instrumentable function node types.
const FN_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
])

/**
 * Instrument JS source. Returns { code, map } or null if the source could not
 * be parsed (caller falls back to the original source — never break the app).
 * @param {string} source
 * @param {{filename: string, sourceType?: 'module'|'script'}} opts
 */
function transform(source, opts) {
  const filename = opts.filename
  let ast
  const parseOpts = {
    ecmaVersion: 'latest',
    locations: true,
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  }
  try {
    ast = acorn.parse(source, { ...parseOpts, sourceType: opts.sourceType || 'module' })
  } catch (_) {
    // Retry as the other source type before giving up.
    try {
      ast = acorn.parse(source, {
        ...parseOpts,
        sourceType: opts.sourceType === 'script' ? 'module' : 'script',
      })
    } catch (_e) {
      return null
    }
  }

  const s = new MagicString(source)
  const fileLit = JSON.stringify(filename)
  let count = 0

  // Unique per-file identifiers so instrumentation never collides with a
  // user variable named __axm/__axe. Nested functions reuse the same names and
  // shadow correctly (inner returns reference the inner context).
  const sfx = Math.random().toString(36).slice(2, 8)
  const names = { CTX: '__axm_' + sfx, ERR: '__axe_' + sfx }

  // Collect all functions with their inferred names, then instrument each.
  const functions = []
  collectFunctions(ast, null, functions)

  for (const { node, name } of functions) {
    if (instrumentFunction(s, source, node, name, fileLit, names)) count++
  }

  if (count === 0) return null
  return {
    code: s.toString(),
    map: s.generateMap({ source: filename, hires: false, includeContent: false }),
  }
}

// ─── function discovery + name inference ──────────────────────────────────────

function collectFunctions(root, _parent, out) {
  // Manual traversal so we can infer names from parents (var declarators,
  // properties, methods, assignments).
  const visit = (node, parent, key) => {
    if (!node || typeof node.type !== 'string') return
    if (FN_TYPES.has(node.type) && !skipFunction(node, parent)) {
      out.push({ node, name: inferName(node, parent, key) })
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue
      const v = node[k]
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c.type === 'string') visit(c, node, k)
      } else if (v && typeof v.type === 'string') {
        visit(v, node, k)
      }
    }
  }
  visit(root, null, null)
}

function inferName(node, parent, key) {
  if (node.id && node.id.name) return node.id.name
  if (parent) {
    if (parent.type === 'VariableDeclarator' && parent.id && parent.id.name) return parent.id.name
    if (parent.type === 'MethodDefinition' && parent.key) return keyName(parent.key)
    if (parent.type === 'Property' && parent.key) return keyName(parent.key)
    if (parent.type === 'AssignmentExpression' && parent.left) {
      if (parent.left.type === 'Identifier') return parent.left.name
      if (parent.left.type === 'MemberExpression' && parent.left.property) return keyName(parent.left.property)
    }
    if (parent.type === 'ExportDefaultDeclaration') return 'default'
  }
  return '<anonymous>'
}

function keyName(key) {
  if (!key) return '<computed>'
  if (key.type === 'Identifier') return key.name
  if (key.type === 'Literal') return String(key.value)
  return '<computed>'
}

// Constructors, getters, and setters have special return/init semantics
// (super() ordering, implicit return of accessors) — leave them uninstrumented.
function skipFunction(node, parent) {
  if (!parent) return false
  if (parent.type === 'MethodDefinition') {
    return parent.kind === 'constructor' || parent.kind === 'get' || parent.kind === 'set'
  }
  if (parent.type === 'Property') {
    return parent.kind === 'get' || parent.kind === 'set'
  }
  return false
}

// ─── instrumentation ──────────────────────────────────────────────────────────

function instrumentFunction(s, source, node, name, fileLit, names) {
  const CTX = names.CTX
  const ERR = names.ERR
  const body = node.body
  const line = node.loc.start.line

  // Simple identifier params (incl. defaulted) are captured + injectable.
  const params = []
  for (const p of node.params) {
    if (p.type === 'Identifier') params.push(p.name)
    else if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier') params.push(p.left.name)
  }
  const argsArr = '[' + params.join(', ') + ']'
  const namesArr = '[' + params.map((n) => JSON.stringify(n)).join(', ') + ']'
  const enterCall = `${G}.enter(${fileLit}, ${JSON.stringify(name)}, ${line}, ${argsArr}, ${namesArr})`

  // Parameter injection reassignment (only simple identifier params).
  let injectApply = ''
  if (params.length) {
    const asgs = params
      .map((n) => `if (${JSON.stringify(n)} in ${CTX}.o) ${n} = ${CTX}.o[${JSON.stringify(n)}];`)
      .join(' ')
    injectApply = ` if (${CTX}.o) { ${asgs} }`
  }

  if (body.type !== 'BlockStatement') {
    // Arrow with expression body: `(...) => EXPR`  →  block with wrapped return.
    // Any grouping parens acorn stripped around EXPR must be consumed too, or
    // `=> ( { ...block... } )` is a syntax error. We re-parenthesize EXPR
    // inside our own `ret(ctx, (…))`, so removing the outer parens is safe
    // (and required for `=> ({obj})`, whose parens would otherwise wrap a block).
    let exprStart = body.start
    let exprEnd = body.end
    let li = exprStart - 1
    while (li >= 0 && /\s/.test(source[li])) li--
    let ri = exprEnd
    while (ri < source.length && /\s/.test(source[ri])) ri++
    while (li >= 0 && ri < source.length && source[li] === '(' && source[ri] === ')') {
      s.remove(li, li + 1)
      s.remove(ri, ri + 1)
      li--
      while (li >= 0 && /\s/.test(source[li])) li--
      ri++
      while (ri < source.length && /\s/.test(source[ri])) ri++
    }
    const prefix = `{ const ${CTX} = ${enterCall};${injectApply} try { return ${G}.ret(${CTX}, (`
    const suffix = `)); } catch (${ERR}) { ${G}.error(${CTX}, ${ERR}); throw ${ERR}; } finally { ${G}.exit(${CTX}); } }`
    s.prependLeft(exprStart, prefix)
    s.appendRight(exprEnd, suffix)
    return true
  }

  // Block body: inject after `{` and before final `}`, wrap own returns.
  const openBrace = body.start // index of '{'
  const closeBrace = body.end - 1 // index of '}'

  const header = ` const ${CTX} = ${enterCall};${injectApply} try {`
  const footer = ` } catch (${ERR}) { ${G}.error(${CTX}, ${ERR}); throw ${ERR}; } finally { ${G}.exit(${CTX}); } `

  s.appendRight(openBrace + 1, header)
  s.prependLeft(closeBrace, footer)

  // Wrap this function's own return statements (not nested functions').
  const returns = []
  collectOwnReturns(body, returns)
  for (const ret of returns) {
    if (ret.argument) {
      s.prependLeft(ret.argument.start, `${G}.ret(${CTX}, (`)
      s.appendRight(ret.argument.end, `))`)
    } else {
      // `return;`  →  `return globalThis.__axiom.ret(__axm, void 0);`
      // Insert the value expression right after `return`.
      const afterReturn = ret.start + 'return'.length
      s.appendRight(afterReturn, ` ${G}.ret(${CTX}, void 0)`)
    }
  }
  return true
}

// Collect ReturnStatements owned by this function body (stop at nested fns).
function collectOwnReturns(body, out) {
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return
    if (FN_TYPES.has(node.type)) return // don't descend into nested functions
    if (node.type === 'ReturnStatement') out.push(node)
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue
      const v = node[k]
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c.type === 'string') visit(c)
      } else if (v && typeof v.type === 'string') {
        visit(v)
      }
    }
  }
  // Visit the body's statements (not the function node itself).
  for (const stmt of body.body) visit(stmt)
}

module.exports = { transform }
