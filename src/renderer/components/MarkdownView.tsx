import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  isSafeHref,
  parseMarkdown,
  type MdBlock,
  type MdInline,
} from './markdown'
import { highlightSource, type HighlightedSource } from './sourceHighlighting'

/**
 * Renders parsed Markdown as React elements.
 *
 * Never `dangerouslySetInnerHTML`: the source is a file out of the user's
 * repository, so treating it as markup would let a document put arbitrary HTML
 * into the app. Every node here becomes an element this component chose.
 */

function Inline({ nodes }: { nodes: MdInline[] }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case 'text': return <span key={index}>{node.value}</span>
      case 'code': return <code key={index} className="axiom-md__code">{node.value}</code>
      case 'strong': return <strong key={index}><Inline nodes={node.children} /></strong>
      case 'em': return <em key={index}><Inline nodes={node.children} /></em>
      case 'strike': return <s key={index}><Inline nodes={node.children} /></s>
      case 'link': {
        if (!isSafeHref(node.href)) {
          // A link Axiom will not follow still shows its words - dropping it
          // would silently remove text the document meant to say.
          return <span key={index} className="axiom-md__deadlink"><Inline nodes={node.children} /></span>
        }
        return (
          <a key={index} href={node.href} target="_blank" rel="noreferrer noopener">
            <Inline nodes={node.children} />
          </a>
        )
      }
    }
  })
}

function CodeBlock({ language, value }: { language: string; value: string }) {
  const [highlighted, setHighlighted] = useState<HighlightedSource | null>(null)

  useEffect(() => {
    let cancelled = false
    void highlightSource(value, language, `snippet.${language || 'txt'}`)
      .then(result => { if (!cancelled) setHighlighted(result) })
      .catch(() => { /* plain text is a fine fallback for an unknown grammar */ })
    return () => { cancelled = true }
  }, [value, language])

  if (!highlighted) {
    return <pre className="axiom-md__pre"><code>{value}</code></pre>
  }
  return (
    <pre className="axiom-md__pre">
      <code>
        {highlighted.tokens.map((line, lineIndex) => (
          <span key={lineIndex} className="axiom-md__line">
            {line.map((token, tokenIndex) => (
              <span key={tokenIndex} style={token.color ? { color: token.color } : undefined}>
                {token.content}
              </span>
            ))}
            {'\n'}
          </span>
        ))}
      </code>
    </pre>
  )
}

function Block({ block }: { block: MdBlock }): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const Tag = `h${block.level}` as 'h1'
      return <Tag className="axiom-md__heading"><Inline nodes={block.children} /></Tag>
    }
    case 'paragraph':
      return <p className="axiom-md__p"><Inline nodes={block.children} /></p>
    case 'codeblock':
      return <CodeBlock language={block.language} value={block.value} />
    case 'rule':
      return <hr className="axiom-md__rule" />
    case 'quote':
      return (
        <blockquote className="axiom-md__quote">
          {block.children.map((child, index) => <Block key={index} block={child} />)}
        </blockquote>
      )
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag className="axiom-md__list">
          {block.items.map((item, index) => <li key={index}><Inline nodes={item} /></li>)}
        </Tag>
      )
    }
    case 'table':
      return (
        <div className="axiom-md__tablewrap">
          <table className="axiom-md__table">
            <thead>
              <tr>{block.header.map((cell, index) => <th key={index}><Inline nodes={cell} /></th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => <td key={cellIndex}><Inline nodes={cell} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

export function MarkdownView({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <article className="axiom-md">
      {blocks.map((block, index) => <Block key={index} block={block} />)}
    </article>
  )
}
