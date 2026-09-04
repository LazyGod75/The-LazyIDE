/* nodes/index.ts — the React Flow `nodeTypes` map (W1c wires this
   straight into `<ReactFlow nodeTypes={nodeTypes} .../>`), keyed exactly
   by `CanvasNodeKind` (canvasTypes.ts) so a node's `type` field always
   resolves to the right component. Also re-exports each node's pure inner
   "Card" component (fixture-testable without React Flow context) and its
   typed `Node<Data, Kind>` alias for callers building the reconciler's
   output array (W1a) without re-deriving the generic themselves.
*/

import type { NodeTypes } from '@xyflow/react';
import { MissionNode, MissionNodeCard, type MissionFlowNode } from './MissionNode';
import { ProjectGroupNode, ProjectGroupNodeCard, type ProjectFlowNode } from './ProjectGroupNode';
import { LoopNode, LoopNodeCard, type LoopFlowNode } from './LoopNode';
import { ScheduleNode, ScheduleNodeCard, type ScheduleFlowNode } from './ScheduleNode';
import { DraftNode, DraftNodeCard, type DraftFlowNode } from './DraftNode';
import { NoteNode, NoteNodeCard, type NoteFlowNode } from './NoteNode';
import { IterationNode, IterationNodeCard, type IterationFlowNode } from './IterationNode';
import { RouterNode, RouterNodeCard, type RouterFlowNode } from './RouterNode';
import { JoinNode, JoinNodeCard, type JoinFlowNode } from './JoinNode';
import { TerminalNode, TerminalNodeCard, type TerminalFlowNode } from './TerminalNode';
import { PreviewNode, PreviewNodeCard, type PreviewFlowNode } from './PreviewNode';
import { LazyBotNode, LazyBotNodeCard, type LazyBotFlowNode } from './LazyBotNode';
import { BotVmNode, BotVmNodeCard, type BotVmFlowNode } from './BotVmNode';
import { FrameNode, FrameNodeCard, type FrameFlowNode } from './FrameNode';
// P-SEARCH (additive) — SearchNode.tsx's `PreviewSlotNode` dispatches a
// 'preview'-typed node to SearchNode or PreviewNode based on
// `data.searchSurface` (see that module's own header) — registered below
// under the SAME `preview` nodeTypes key, no new CanvasNodeKind needed.
import { SearchNode, SearchNodeCard, PreviewSlotNode, type SearchFlowNode } from './SearchNode';

export {
  MissionNode,
  MissionNodeCard,
  ProjectGroupNode,
  ProjectGroupNodeCard,
  LoopNode,
  LoopNodeCard,
  ScheduleNode,
  ScheduleNodeCard,
  DraftNode,
  DraftNodeCard,
  NoteNode,
  NoteNodeCard,
  IterationNode,
  IterationNodeCard,
  RouterNode,
  RouterNodeCard,
  JoinNode,
  JoinNodeCard,
  TerminalNode,
  TerminalNodeCard,
  PreviewNode,
  PreviewNodeCard,
  FrameNode,
  FrameNodeCard,
  LazyBotNode,
  LazyBotNodeCard,
  BotVmNode,
  BotVmNodeCard,
  SearchNode,
  SearchNodeCard,
  PreviewSlotNode,
};
export type {
  MissionFlowNode,
  ProjectFlowNode,
  LoopFlowNode,
  ScheduleFlowNode,
  DraftFlowNode,
  NoteFlowNode,
  IterationFlowNode,
  RouterFlowNode,
  JoinFlowNode,
  TerminalFlowNode,
  PreviewFlowNode,
  FrameFlowNode,
  LazyBotFlowNode,
  BotVmFlowNode,
  SearchFlowNode,
};

/** Union of every concrete canvas node type — handy for the reconciler's
 *  (W1a) `Node[]` return type instead of the untyped generic `Node`. */
export type CanvasFlowNode =
  | ProjectFlowNode
  | MissionFlowNode
  | LoopFlowNode
  | ScheduleFlowNode
  | DraftFlowNode
  | NoteFlowNode
  | IterationFlowNode
  | RouterFlowNode
  | JoinFlowNode
  | TerminalFlowNode
  | PreviewFlowNode
  | FrameFlowNode
  | LazyBotFlowNode
  | BotVmFlowNode;

export const nodeTypes: NodeTypes = {
  project: ProjectGroupNode,
  mission: MissionNode,
  loop: LoopNode,
  schedule: ScheduleNode,
  draft: DraftNode,
  note: NoteNode,
  iteration: IterationNode,
  router: RouterNode,
  join: JoinNode,
  terminal: TerminalNode,
  // P-SEARCH — PreviewSlotNode dispatches per-instance (data.searchSurface
  // presence) to SearchNode.tsx or PreviewNode.tsx; a real preview renders
  // exactly as before (see SearchNode.tsx's own header).
  preview: PreviewSlotNode,
  frame: FrameNode,
  bot: LazyBotNode,
  botVm: BotVmNode,
};
