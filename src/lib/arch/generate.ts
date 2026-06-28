import type { ArchElement } from "./types";
import type { EdgeKind } from "@/components/arch/ArchCanvas";

interface GenEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
}

/** Map a canvas edge kind to a mermaid sequence arrow. */
function arrowFor(kind: EdgeKind): { token: string; isFlow: boolean } {
  switch (kind) {
    case "sync":
    case "direct":
      return { token: "->>", isFlow: true };
    case "response":
      return { token: "-->>", isFlow: true };
    case "async":
    case "fanout":
    case "pubsub":
    case "topic-route":
    case "headers":
    case "relay-publish":
    case "consume":
      return { token: "-)", isFlow: true };
    // structural relationships are not message flow — skip in sequence
    default:
      return { token: "", isFlow: false };
  }
}

/**
 * Generate a mermaid sequenceDiagram skeleton from the canvas elements and
 * their connections. Structural edges (owns / dlq / replica / broker-of …)
 * are emitted as notes so the author can see the topology context.
 */
export function generateMermaid(
  elements: ArchElement[],
  edges: GenEdge[],
  managedEdges: GenEdge[] = [],
): string {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const used = new Set<string>();
  const lines: string[] = ["sequenceDiagram", "  autonumber"];

  const flow = [...edges, ...managedEdges].filter((e) => byId.has(e.source) && byId.has(e.target));

  // Determine participant order: follow first appearance in flow edges, then leftovers.
  const order: string[] = [];
  const push = (id: string) => {
    if (!order.includes(id) && byId.has(id)) order.push(id);
  };
  for (const e of flow) {
    const a = arrowFor(e.kind);
    if (!a.isFlow) continue;
    push(e.source);
    push(e.target);
  }
  for (const el of elements) push(el.id);

  for (const id of order) {
    const el = byId.get(id)!;
    lines.push(`  participant ${el.id} as ${el.name}`);
  }
  lines.push("");

  // Message flow
  for (const e of flow) {
    const a = arrowFor(e.kind);
    if (!a.isFlow) continue;
    used.add(e.source);
    used.add(e.target);
    const label = e.label || messageLabel(byId.get(e.source), byId.get(e.target), e.kind);
    lines.push(`  ${e.source}${a.token}${e.target}: ${label}`);
  }

  // Structural context as notes (owns / dlq / replica / hosts)
  for (const e of managedEdges) {
    const a = arrowFor(e.kind);
    if (a.isFlow) continue;
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    lines.push(`  Note over ${e.source},${e.target}: ${e.label ?? e.kind}`);
  }

  if (flow.filter((e) => arrowFor(e.kind).isFlow).length === 0) {
    lines.push("  %% No message flow found — connect components on the canvas first.");
  }

  return lines.join("\n") + "\n";
}

function messageLabel(from?: ArchElement, to?: ArchElement, kind?: EdgeKind): string {
  if (!to) return "message";
  if (kind === "sync" || kind === "direct") {
    if (to.type === "database") return "read/write";
    if (to.type === "service" || to.type === "api-gateway") return "call";
  }
  if (to.type === "topic" || to.type === "queue") return "publish";
  return "message";
}
