import type { DbSystem } from '../../shared/types'
import type { PlannedNodeKind, PlannedNodeMetadata } from '../store/sheetStore'
import type { NodeResizeParams } from './resizeGeometry'

// Transient choreography intent stamped onto a node so it runs a one-shot
// animation when the live map changes: `enter` = just materialized from a
// patch (new file/system), `edit` = an existing file was just rewritten,
// `classify` = a loose file settled into a proposed architectural system.
// `key` bumps per event so a repeat animation re-fires. See graphStore.nodeFx.
export interface NodeFx {
  kind:
    | 'enter' | 'edit' | 'classify' | 'exit'
    | 'flow-add' | 'flow-update' | 'flow-remove'
    | 'surface-add' | 'surface-update' | 'surface-remove'
  key: number
  /** Backend save identity used to trace one event through the full pipeline. */
  traceId?: string
  /** Original semantic nodes represented when hidden activity is surfaced. */
  originIds?: string[]
  /** Compact identities shown by a visible ancestor's activity peek. */
  originLabels?: string[]
  /** Number of concurrent hidden descendants represented by this signal. */
  count?: number
}

export interface LivingInspectionWindow {
  traceId?: string
  key: number
  kind: NodeFx['kind']
  originId: string
  /** Rectangle of the hidden origin in this system's local flow coordinates. */
  x: number
  y: number
  width: number
  height: number
}

export interface AgentPresence {
  id: string
  agent: string
  goal: string
}

export interface SystemNodeData {
  id: string
  name: string
  source: DbSystem['source']
  color: string
  colorRgb: string
  description: string | null
  agentNotes: string | null
  depth: number
  /** Every direct child descriptor, regardless of type, counted exactly once. */
  directChildCount: number
  /** Zoom at projection time. Not refreshed per frame — read `detailRevealed`
   *  instead of recomputing a threshold from this. */
  currentZoom: number
  /** Resolved by the semantic-zoom pass: has this leaf reached detail zoom? */
  detailRevealed?: boolean
  isChild: boolean
  childrenVisible: number
  selfScale?: number
  selfBlur?: number
  isDropTarget?: boolean
  onResizeStart?: (params: NodeResizeParams) => void
  onResizeEnd?: (params: NodeResizeParams) => void
  onRename?: (name: string) => void
  umlKind?: PlannedNodeKind
  umlMetadata?: PlannedNodeMetadata
  onUmlMetadataChange?: (metadata: PlannedNodeMetadata) => void
  nodeW?: number
  nodeH?: number
  gridCellW?: number
  gridCellH?: number
  gridGap?: number
  occupiedCells?: Set<string>
  snapPreview?: { col: number; row: number; wUnits: number; hUnits: number } | null
  previewOffset?: { x: number; y: number } | null
  frameScale?: number
  /** World scale of this frame itself. */
  worldScale?: number
  /** World scale this frame hands to its children (worldScale x interiorScale). */
  contentScale?: number
  /** How much this frame compresses its contents. 1 means not at all. */
  interiorScale?: number
  minResizeWidth?: number
  minResizeHeight?: number
  /** West/north handles move the origin, so they need their own minima. */
  minResizeWidthWest?: number
  minResizeHeightNorth?: number
  /** Authored design size, CANONICAL — never multiplied by world scale. */
  presentationBaseWidth?: number
  presentationBaseHeight?: number
  /**
   * Canonical size / authored design size. Computed in the projection so no
   * component can reintroduce a world-scale term and make chrome sensitive to
   * nesting depth or to interior compression.
   */
  presentationScale?: number
  fx?: NodeFx | null
  livingWindows?: LivingInspectionWindow[]
  /** Active agents that declared this boundary in their work scope. */
  agentPresence?: AgentPresence[]
}

export interface FileNodeData {
  id: string
  label: string
  relPath: string
  language: string
  lineCount: number
  churnScore: number
  shape: '' | 'class' | 'cylinder' | 'hexagon'
  displayName: string
  depth: number
  /** Zoom at projection time. Not refreshed per frame — read `detailRevealed`
   *  instead of recomputing a threshold from this. */
  currentZoom: number
  /** Resolved by the semantic-zoom pass: has this leaf reached detail zoom? */
  detailRevealed?: boolean
  childrenVisible: number
  worldScale: number
  previewOffset?: { x: number; y: number } | null
  frameScale?: number
  /** Temporarily overrides semantic-zoom opacity for a real live event. */
  livingReveal?: boolean
  symbols?: Array<{ name: string; kind: string; lineStart: number; lineEnd: number }>
  onRename?: (name: string) => void
  onLanguageChange?: (language: string) => void
  onResizeStart?: (params: NodeResizeParams) => void
  onResizeEnd?: (params: NodeResizeParams) => void
  onSymbolsChange?: (symbols: Array<{ name: string; kind: string; lineStart: number; lineEnd: number }>) => void
  umlKind?: PlannedNodeKind
  umlMetadata?: PlannedNodeMetadata
  onUmlMetadataChange?: (metadata: PlannedNodeMetadata) => void
  fx?: NodeFx | null
  /** Morning Delta review: how this node changed since the last review. */
  deltaMark?: 'created' | 'updated' | 'deleted' | null
  /** True while this node is the delta stop currently being stepped through. */
  deltaFocused?: boolean
  /** Active agents that declared this file in their work scope. */
  agentPresence?: AgentPresence[]
}

export interface InfraNodeData {
  id: string
  label: string
  name: string
  /** @deprecated superseded by category/provider/service */
  infraType: string
  category: string
  provider: string
  service: string
  subtype: string
  status: string
  umlKind?: PlannedNodeKind
  umlMetadata?: PlannedNodeMetadata
  onRename?: (name: string) => void
  onChooseInfra?: () => void
  onUmlMetadataChange?: (metadata: PlannedNodeMetadata) => void
  onResizeStart?: (params: NodeResizeParams) => void
  onResizeEnd?: (params: NodeResizeParams) => void
  frameScale?: number
  worldScale?: number
}
