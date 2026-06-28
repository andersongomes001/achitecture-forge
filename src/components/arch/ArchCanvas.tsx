import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  NodeToolbar,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type XYPosition,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ArchElement, ElementType } from "@/lib/arch/types";

export type EdgeKind =
  | "sync"
  | "async"
  | "response"
  | "fanout"
  | "direct"
  | "topic-route"
  | "headers"
  | "pubsub"
  | "owns"
  | "dlq"
  | "retry"
  | "replica"
  | "relay-read"
  | "relay-publish"
  | "consume"
  | "broker-of"
  | "inbox-table"
  | "inbox-of";

export interface CanvasEdgeData {
  kind: EdgeKind;
  label?: string;
  managed?: boolean;
  failed?: boolean;
  offset?: { x: number; y: number };
  onOffset?: (id: string, offset: { x: number; y: number }) => void;
  [key: string]: unknown;
}

export interface ManagedEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
}

export interface CanvasState {
  positions: Record<string, XYPosition>;
  edges: { id: string; source: string; target: string; kind: EdgeKind }[];
  edgeOffsets?: Record<string, { x: number; y: number }>;
}

interface Props {
  elements: ArchElement[];
  state: CanvasState;
  onStateChange: (s: CanvasState) => void;
  activeEdgeKeys: Set<string>;
  failedEdgeKeys?: Set<string>;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onDropType?: (type: ElementType, pos: XYPosition) => void;
  managedEdges?: ManagedEdge[];
  onAddDlq?: (queueId: string) => void;
  onAddRetry?: (queueId: string) => void;
  onRemoveElement?: (id: string) => void;
}

const TYPE_GLYPH: Record<ElementType, { glyph: string; color: string; label: string }> = {
  service: { glyph: "◇", color: "var(--color-primary)", label: "Service" },
  database: { glyph: "▭", color: "var(--color-info)", label: "Database" },
  queue: { glyph: "≡", color: "var(--color-warning)", label: "Queue" },
  topic: { glyph: "✦", color: "var(--color-accent)", label: "Topic" },
  cache: { glyph: "◷", color: "var(--color-success)", label: "Cache" },
  external: { glyph: "◯", color: "var(--color-muted-foreground)", label: "External" },
  "api-gateway": { glyph: "⌥", color: "var(--color-primary)", label: "API Gateway" },
  lambda: { glyph: "λ", color: "var(--color-accent)", label: "Lambda" },
  scheduler: { glyph: "⏱", color: "var(--color-info)", label: "Scheduler" },
  stream: { glyph: "⌇", color: "var(--color-warning)", label: "Stream" },
  saga: { glyph: "⎈", color: "var(--color-success)", label: "Saga" },
  broker: { glyph: "⬡", color: "var(--color-accent)", label: "Broker" },
  relay: { glyph: "↻", color: "var(--color-info)", label: "Outbox Relay" },
  "inbox-store": { glyph: "▤", color: "var(--color-success)", label: "Inbox Store" },
};

type ArchNodeData = {
  element: ArchElement;
  orphan: boolean;
  onAddDlq?: (id: string) => void;
  onAddRetry?: (id: string) => void;
  [key: string]: unknown;
};

function ArchNode({ data, selected }: NodeProps) {
  const d = data as ArchNodeData;
  const el = d.element;
  const meta = TYPE_GLYPH[el.type];
  const tags = [
    el.hasOutbox && "outbox",
    el.hasInbox && "inbox",
    el.idempotent && "idem",
    el.circuitBreaker && "cb",
  ].filter(Boolean) as string[];

  const handleClass =
    "!w-2.5 !h-2.5 !bg-primary !border !border-background hover:!bg-accent !opacity-70 hover:!opacity-100 transition";
  const topicMeta =
    el.type === "topic"
      ? `${el.broker ?? "generic"} · ${el.topicKind ?? "fanout"}${el.partitions ? ` · p${el.partitions}` : ""}`
      : el.type === "queue"
        ? `${el.broker ?? "generic"}${el.fifo ? " · fifo" : ""}${el.consumerGroup ? ` · cg:${el.consumerGroup}` : ""}${el.dlqId ? " · dlq" : ""}${el.retryQueueId ? " · retry" : ""}`
        : el.type === "database"
          ? `${el.dbEngine ?? "generic"}${(el.dbReplicas ?? 0) > 0 ? ` · ${el.dbReplicas} replicas` : ""}${el.dbConsistency ? ` · ${el.dbConsistency}` : ""}`
          : null;

  const isQueue = el.type === "queue" && !el.isDlqFor && !el.isRetryFor;

  return (
    <div
      className={`relative rounded-md border bg-surface px-3 py-2 min-w-[160px] shadow-sm transition-colors ${
        selected ? "border-primary ring-1 ring-primary/40" : "border-border"
      }`}
    >
      {isQueue && (
        <NodeToolbar position={Position.Top} offset={6}>
          <div className="flex gap-1">
            {!el.dlqId && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  d.onAddDlq?.(el.id);
                }}
                className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20"
              >
                + DLQ
              </button>
            )}
            {!el.retryQueueId && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  d.onAddRetry?.(el.id);
                }}
                className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-warning/50 bg-warning/10 text-warning hover:bg-warning/20"
              >
                + Retry
              </button>
            )}
          </div>
        </NodeToolbar>
      )}

      {/* dual handles on all 4 sides */}
      {(["l", "r", "t", "b"] as const).map((side) => {
        const pos =
          side === "l" ? Position.Left : side === "r" ? Position.Right : side === "t" ? Position.Top : Position.Bottom;
        return (
          <span key={side}>
            <Handle id={`${side}-s`} type="source" position={pos} className={handleClass} />
            <Handle id={`${side}-t`} type="target" position={pos} className={handleClass} />
          </span>
        );
      })}

      <div className="flex items-center gap-2">
        <span
          className="w-6 h-6 grid place-items-center rounded border border-border font-mono text-sm shrink-0"
          style={{ color: meta.color }}
        >
          {meta.glyph}
        </span>
        <div className="min-w-0">
          <div className="text-[12px] font-medium truncate">{el.name}</div>
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground mono">
            {el.id} · {meta.label}
          </div>
        </div>
      </div>
      {topicMeta && (
        <div className="mt-1 text-[9px] uppercase tracking-wider text-accent mono truncate">
          {topicMeta}
        </div>
      )}
      {el.contractId && (
        <div className="mt-1 text-[9px] uppercase tracking-wider text-info mono truncate">
          ⌘ contract:{el.contractId}
        </div>
      )}
      {tags.length > 0 && (
        <div className="mt-1.5 flex gap-1 flex-wrap">
          {tags.map((t) => (
            <span
              key={t}
              className="text-[8.5px] uppercase tracking-wider px-1 py-px rounded border border-primary/40 text-primary bg-primary/10"
            >
              {t}
            </span>
          ))}
        </div>
      )}
      {d.orphan && (
        <span
          title="No connections — connect this component"
          className="absolute -top-2 -right-2 w-5 h-5 grid place-items-center rounded-full border border-destructive/70 bg-destructive/20 text-destructive text-[11px] font-bold animate-pulse"
        >
          ✕
        </span>
      )}
    </div>
  );
}

const nodeTypes: NodeTypes = { arch: ArchNode };

const EDGE_STYLE: Record<EdgeKind, { stroke: string; dasharray?: string; width?: number }> = {
  sync: { stroke: "var(--color-primary)" },
  async: { stroke: "var(--color-warning)", dasharray: "6 4" },
  response: { stroke: "var(--color-info)", dasharray: "2 3" },
  fanout: { stroke: "var(--color-warning)", width: 2.4 },
  direct: { stroke: "var(--color-primary)", width: 2 },
  "topic-route": { stroke: "var(--color-accent)", dasharray: "8 3 2 3", width: 1.8 },
  headers: { stroke: "var(--color-info)", dasharray: "1 4", width: 2 },
  pubsub: { stroke: "var(--color-success)", dasharray: "10 3", width: 2.2 },
  owns: { stroke: "var(--color-muted-foreground)", dasharray: "3 3", width: 1.2 },
  dlq: { stroke: "var(--color-destructive)", dasharray: "4 2", width: 1.6 },
  retry: { stroke: "var(--color-warning)", dasharray: "2 2", width: 1.4 },
  replica: { stroke: "var(--color-info)", dasharray: "1 3", width: 1 },
  "relay-read": { stroke: "var(--color-info)", dasharray: "3 2", width: 1.4 },
  "relay-publish": { stroke: "var(--color-accent)", dasharray: "5 2", width: 1.6 },
  consume: { stroke: "var(--color-success)", dasharray: "5 2", width: 1.6 },
  "broker-of": { stroke: "var(--color-accent)", dasharray: "1 3", width: 1 },
  "inbox-table": { stroke: "var(--color-success)", dasharray: "3 3", width: 1.2 },
  "inbox-of": { stroke: "var(--color-success)", dasharray: "2 4", width: 1.2 },
};

const CYCLABLE: ReadonlySet<EdgeKind> = new Set(["sync", "async", "response"]);

/** Curved edge whose midpoint can be dragged to route lines around nodes. */
function EditableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  style,
  data,
  label,
  labelStyle,
}: EdgeProps) {
  const { screenToFlowPosition } = useReactFlow();
  const d = data as CanvasEdgeData | undefined;
  const off = d?.offset ?? { x: 0, y: 0 };
  const cx = (sourceX + targetX) / 2;
  const cy = (sourceY + targetY) / 2;
  const midX = cx + off.x;
  const midY = cy + off.y;
  const ctrlX = cx + 2 * off.x;
  const ctrlY = cy + 2 * off.y;
  const path = `M ${sourceX},${sourceY} Q ${ctrlX},${ctrlY} ${targetX},${targetY}`;
  const dragging = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragging.current = true;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    d?.onOffset?.(id, { x: p.x - cx, y: p.y - cy });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragging.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };
  const reset = (e: React.MouseEvent) => {
    e.stopPropagation();
    d?.onOffset?.(id, { x: 0, y: 0 });
  };

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan group"
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${midX}px, ${midY}px)`,
            pointerEvents: "all",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {label && (
            <span
              style={labelStyle}
              className="mono text-[10px] px-1 rounded bg-surface/85 border border-border whitespace-nowrap"
            >
              {label}
            </span>
          )}
          <span
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={reset}
            title="Drag to reroute · double-click to reset"
            className="block w-2.5 h-2.5 rounded-full border border-background bg-accent/40 opacity-40 hover:opacity-100 hover:scale-150 transition cursor-move"
          />
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes: EdgeTypes = { editable: EditableEdge };


function pickHandles(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
): { sourceHandle: string; targetHandle: string } {
  const dx = tx - sx;
  const dy = ty - sy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: "r-s", targetHandle: "l-t" }
      : { sourceHandle: "l-s", targetHandle: "r-t" };
  }
  return dy >= 0
    ? { sourceHandle: "b-s", targetHandle: "t-t" }
    : { sourceHandle: "t-s", targetHandle: "b-t" };
}

function InnerCanvas({
  elements,
  state,
  onStateChange,
  activeEdgeKeys,
  failedEdgeKeys,
  selectedId,
  onSelect,
  onDropType,
  managedEdges = [],
  onAddDlq,
  onAddRetry,
}: Props) {
  const positionsRef = useRef(state.positions);
  positionsRef.current = state.positions;
  const edgeOffsets = state.edgeOffsets ?? {};
  const offsetsRef = useRef(edgeOffsets);
  offsetsRef.current = edgeOffsets;

  const initialNodes: Node[] = useMemo(
    () =>
      elements.map((el, i) => ({
        id: el.id,
        type: "arch",
        position:
          state.positions[el.id] ?? {
            x: 60 + (i % 4) * 240,
            y: 60 + Math.floor(i / 4) * 150,
          },
        data: { element: el, orphan: false, onAddDlq, onAddRetry },
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(
    state.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      data: { kind: e.kind },
      animated: true,
    })),
  );

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  const updateOffset = useCallback(
    (edgeId: string, offset: { x: number; y: number }) => {
      const next = { ...offsetsRef.current, [edgeId]: offset };
      offsetsRef.current = next;
      const positions: Record<string, XYPosition> = {};
      for (const n of nodesRef.current) positions[n.id] = n.position;
      onStateChange({
        positions,
        edges: edgesRef.current.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          kind: ((e.data as CanvasEdgeData | undefined)?.kind ?? "sync") as EdgeKind,
        })),
        edgeOffsets: next,
      });
    },
    [onStateChange],
  );

  // map id → position for handle picking
  const nodePos = useMemo(() => {
    const m = new Map<string, XYPosition>();
    for (const n of nodes) m.set(n.id, n.position);
    return m;
  }, [nodes]);

  // sync elements -> nodes
  useEffect(() => {
    setNodes((curr) => {
      const byId = new Map(curr.map((n) => [n.id, n]));
      return elements.map((el, i) => {
        const existing = byId.get(el.id);
        const connected =
          edges.some((e) => e.source === el.id || e.target === el.id) ||
          managedEdges.some((e) => e.source === el.id || e.target === el.id);
        const orphan = !connected;
        if (existing) {
          return {
            ...existing,
            selected: existing.id === selectedId,
            data: { element: el, orphan, onAddDlq, onAddRetry },
          };
        }
        return {
          id: el.id,
          type: "arch",
          position:
            positionsRef.current[el.id] ??
            { x: 80 + (i % 4) * 240, y: 80 + Math.floor(i / 4) * 150 },
          selected: el.id === selectedId,
          data: { element: el, orphan, onAddDlq, onAddRetry },
        } as Node;
      });
    });
  }, [elements, edges, managedEdges, selectedId, onAddDlq, onAddRetry, setNodes]);

  const styledEdges = useMemo<Edge[]>(() => {
    type EE = { e: Edge; kind: EdgeKind; label?: string; managed: boolean };
    const all: EE[] = [];
    for (const e of edges) {
      const data = e.data as CanvasEdgeData | undefined;
      all.push({ e, kind: (data?.kind ?? "sync") as EdgeKind, label: data?.label, managed: false });
    }
    for (const m of managedEdges) {
      all.push({
        e: { id: m.id, source: m.source, target: m.target, data: { kind: m.kind, label: m.label, managed: true } } as Edge,
        kind: m.kind,
        label: m.label,
        managed: true,
      });
    }
    return all.map(({ e, kind, label, managed }) => {
      const style = EDGE_STYLE[kind];
      const active = activeEdgeKeys.has(`${e.source}->${e.target}`);
      const failed = failedEdgeKeys?.has(`${e.source}->${e.target}`) ?? false;
      const sp = nodePos.get(e.source);
      const tp = nodePos.get(e.target);
      const handles = sp && tp
        ? pickHandles(sp.x, sp.y, tp.x, tp.y)
        : { sourceHandle: "r-s", targetHandle: "l-t" };
      return {
        ...e,
        type: "editable",
        sourceHandle: handles.sourceHandle,
        targetHandle: handles.targetHandle,
        animated: true,
        label,
        labelStyle: { color: "var(--color-foreground)" },
        data: {
          ...(e.data as object),
          kind,
          label,
          managed,
          offset: edgeOffsets[e.id],
          onOffset: updateOffset,
        },
        style: {
          stroke: failed ? "var(--color-destructive)" : active ? "var(--color-accent)" : style.stroke,
          strokeWidth: failed ? 3 : active ? 2.8 : style.width ?? 1.6,
          strokeDasharray: style.dasharray,
          opacity: managed ? 0.9 : 1,
          filter: failed
            ? "drop-shadow(0 0 8px var(--color-destructive))"
            : active
              ? "drop-shadow(0 0 6px var(--color-accent))"
              : undefined,
        },
      } as Edge;
    });
  }, [edges, managedEdges, activeEdgeKeys, failedEdgeKeys, nodePos, edgeOffsets, updateOffset]);

  function emitState(nextNodes: Node[], nextEdges: Edge[]) {
    const positions: Record<string, XYPosition> = {};
    for (const n of nextNodes) positions[n.id] = n.position;
    onStateChange({
      positions,
      edges: nextEdges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        kind: ((e.data as CanvasEdgeData | undefined)?.kind ?? "sync") as EdgeKind,
      })),
      edgeOffsets: offsetsRef.current,
    });
  }

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);
      if (changes.some((c) => c.type === "position" && c.dragging === false)) {
        setNodes((curr) => {
          emitState(curr, edges);
          return curr;
        });
      }
    },
    [onNodesChange, edges, setNodes],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChange(changes);
      setEdges((curr) => {
        emitState(nodes, curr);
        return curr;
      });
    },
    [onEdgesChange, nodes, setEdges],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      setEdges((curr) => {
        const next = addEdge(
          {
            ...c,
            id: `${c.source}-${c.target}-${Date.now().toString(36)}`,
            animated: true,
            data: { kind: "sync" as const },
          },
          curr,
        );
        emitState(nodes, next);
        return next;
      });
    },
    [nodes, setEdges],
  );

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData("application/arch-type") as ElementType;
    if (!type || !onDropType) return;
    const bounds = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    onDropType(type, { x: e.clientX - bounds.left - 80, y: e.clientY - bounds.top - 30 });
  };

  return (
    <div className="h-full w-full" onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={styledEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, n) => onSelect?.(n.id)}
        onPaneClick={() => onSelect?.(null)}
        onEdgeClick={(_, edge) => {
          const data = edge.data as CanvasEdgeData | undefined;
          if (data?.managed || !CYCLABLE.has((data?.kind ?? "sync") as EdgeKind)) return;
          setEdges((curr) => {
            const next = curr.map((e) => {
              if (e.id !== edge.id) return e;
              const kind = ((e.data as CanvasEdgeData | undefined)?.kind ?? "sync") as EdgeKind;
              const nextKind: EdgeKind =
                kind === "sync" ? "async" : kind === "async" ? "response" : "sync";
              return { ...e, data: { ...(e.data ?? {}), kind: nextKind } };
            });
            emitState(nodes, next);
            return next;
          });
        }}
        fitView
        snapToGrid
        snapGrid={[16, 16]}
        connectionMode={ConnectionMode.Loose}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ animated: true, type: "editable" }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-grid)" />
        <Controls className="!bg-surface !border !border-border" />
        <MiniMap
          maskColor="oklch(0.18 0.03 250 / 0.7)"
          nodeColor={() => "var(--color-primary)"}
          pannable
          zoomable
          className="!bg-surface !border !border-border"
        />
      </ReactFlow>
    </div>
  );
}

export function ArchCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <InnerCanvas {...props} />
    </ReactFlowProvider>
  );
}

export { TYPE_GLYPH };
