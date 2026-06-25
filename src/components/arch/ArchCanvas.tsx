import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeChange,
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
  | "owns";

export interface CanvasEdgeData {
  kind: EdgeKind;
  label?: string;
  managed?: boolean;
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
}

interface Props {
  elements: ArchElement[];
  state: CanvasState;
  onStateChange: (s: CanvasState) => void;
  activeEdgeKeys: Set<string>; // `${from}->${to}`
  onDropType?: (type: ElementType, pos: XYPosition) => void;
  managedEdges?: ManagedEdge[];
}

const TYPE_GLYPH: Record<ElementType, { glyph: string; color: string; label: string }> = {
  service: { glyph: "◇", color: "var(--color-primary)", label: "Service" },
  database: { glyph: "▭", color: "var(--color-info)", label: "Database" },
  queue: { glyph: "≡", color: "var(--color-warning)", label: "Queue" },
  topic: { glyph: "✦", color: "var(--color-accent)", label: "Topic" },
  cache: { glyph: "◷", color: "var(--color-success)", label: "Cache" },
  external: { glyph: "◯", color: "var(--color-muted-foreground)", label: "External" },
};

type ArchNodeData = {
  element: ArchElement;
  orphan: boolean;
  [key: string]: unknown;
};

function ArchNode({ data, selected }: NodeProps) {
  const d = data as ArchNodeData;
  const meta = TYPE_GLYPH[d.element.type];
  const tags = [
    d.element.hasOutbox && "outbox",
    d.element.hasInbox && "inbox",
    d.element.idempotent && "idem",
  ].filter(Boolean) as string[];
  const handleClass =
    "!w-3 !h-3 !bg-primary !border !border-background hover:!bg-accent transition-colors";
  const topicMeta =
    d.element.type === "topic"
      ? `${d.element.topicKind ?? "fanout"} · ${d.element.bindings?.length ?? 0} bind`
      : null;
  return (
    <div
      className={`relative rounded-md border bg-surface px-3 py-2 min-w-[160px] shadow-sm transition-colors ${
        selected ? "border-primary" : "border-border"
      }`}
    >
      {/* dual-mode handles on all 4 sides for easy connection (loose mode) */}
      <Handle id="l" type="source" position={Position.Left} className={handleClass} />
      <Handle id="r" type="source" position={Position.Right} className={handleClass} />
      <Handle id="t" type="source" position={Position.Top} className={handleClass} />
      <Handle id="b" type="source" position={Position.Bottom} className={handleClass} />
      <div className="flex items-center gap-2">
        <span
          className="w-6 h-6 grid place-items-center rounded border border-border font-mono text-sm"
          style={{ color: meta.color }}
        >
          {meta.glyph}
        </span>
        <div className="min-w-0">
          <div className="text-[12px] font-medium truncate">{d.element.name}</div>
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground mono">
            {d.element.id} · {meta.label}
          </div>
        </div>
      </div>
      {topicMeta && (
        <div className="mt-1 text-[9px] uppercase tracking-wider text-accent mono">
          {topicMeta}
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
};

const CYCLABLE: ReadonlySet<EdgeKind> = new Set(["sync", "async", "response"]);

function InnerCanvas({ elements, state, onStateChange, activeEdgeKeys, onDropType }: Props) {
  const positionsRef = useRef(state.positions);
  positionsRef.current = state.positions;

  const initialNodes: Node[] = useMemo(
    () =>
      elements.map((el, i) => ({
        id: el.id,
        type: "arch",
        position:
          state.positions[el.id] ??
          { x: 60 + (i % 3) * 220, y: 60 + Math.floor(i / 3) * 130 },
        data: { element: el, orphan: false },
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

  // sync elements -> nodes (add/remove/update data)
  useEffect(() => {
    setNodes((curr) => {
      const byId = new Map(curr.map((n) => [n.id, n]));
      const keep = elements.map((el, i) => {
        const existing = byId.get(el.id);
        const orphan = !edges.some((e) => e.source === el.id || e.target === el.id);
        if (existing) {
          return { ...existing, data: { element: el, orphan } };
        }
        return {
          id: el.id,
          type: "arch",
          position:
            positionsRef.current[el.id] ??
            { x: 80 + (i % 3) * 220, y: 80 + Math.floor(i / 3) * 130 },
          data: { element: el, orphan },
        } as Node;
      });
      return keep;
    });
  }, [elements, edges, setNodes]);

  // style edges with kind + active highlighting
  const styledEdges = useMemo<Edge[]>(() => {
    return edges.map((e) => {
      const kind = ((e.data as CanvasEdgeData | undefined)?.kind ?? "sync") as CanvasEdgeData["kind"];
      const style = EDGE_STYLE[kind];
      const active = activeEdgeKeys.has(`${e.source}->${e.target}`);
      return {
        ...e,
        animated: true,
        style: {
          stroke: active ? "var(--color-accent)" : style.stroke,
          strokeWidth: active ? 2.5 : 1.6,
          strokeDasharray: style.dasharray,
          filter: active ? "drop-shadow(0 0 6px var(--color-accent))" : undefined,
        },
      };
    });
  }, [edges, activeEdgeKeys]);

  // emit state upward on changes
  function emitState(nextNodes: Node[], nextEdges: Edge[]) {
    const positions: Record<string, XYPosition> = {};
    for (const n of nextNodes) positions[n.id] = n.position;
    onStateChange({
      positions,
      edges: nextEdges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        kind: ((e.data as CanvasEdgeData | undefined)?.kind ?? "sync") as CanvasEdgeData["kind"],
      })),
    });
  }

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);
      // sync positions when drag ends
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
    <div className="h-[480px] w-full" onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={styledEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onEdgeClick={(_, edge) => {
          // cycle edge kind on click
          setEdges((curr) => {
            const next = curr.map((e) => {
              if (e.id !== edge.id) return e;
              const kind = ((e.data as CanvasEdgeData | undefined)?.kind ?? "sync") as CanvasEdgeData["kind"];
              const nextKind: CanvasEdgeData["kind"] =
                kind === "sync" ? "async" : kind === "async" ? "response" : "sync";
              return { ...e, data: { kind: nextKind } };
            });
            emitState(nodes, next);
            return next;
          });
        }}
        fitView
        connectionMode={ConnectionMode.Loose}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ animated: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--color-grid)" />
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
