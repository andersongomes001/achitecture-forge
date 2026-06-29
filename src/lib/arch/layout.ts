import type { XYPosition } from "@xyflow/react";

export interface LayoutEdge {
  source: string;
  target: string;
}

const COL_GAP = 280;
const ROW_GAP = 150;
const MARGIN = 80;

/**
 * Layered (left-to-right) auto-layout for the architecture canvas.
 * Assigns each node to a column based on its longest path from a root,
 * then spreads nodes vertically within each column, ordering them to
 * sit close to the average position of their connected neighbours.
 */
export function beautifyLayout(
  ids: string[],
  edges: LayoutEdge[],
): Record<string, XYPosition> {
  if (ids.length === 0) return {};
  const idSet = new Set(ids);
  const clean = edges.filter(
    (e) => idSet.has(e.source) && idSet.has(e.target) && e.source !== e.target,
  );

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const id of ids) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const e of clean) {
    outgoing.get(e.source)!.push(e.target);
    incoming.get(e.source); // noop, keep typing happy
    incoming.get(e.target)!.push(e.source);
  }

  // Longest-path layering (ignores back edges so cycles don't loop forever).
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  function depth(id: string): number {
    if (layer.has(id)) return layer.get(id)!;
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    let max = 0;
    for (const p of incoming.get(id)!) {
      max = Math.max(max, depth(p) + 1);
    }
    visiting.delete(id);
    layer.set(id, max);
    return max;
  }
  for (const id of ids) depth(id);

  // Group by column.
  const columns = new Map<number, string[]>();
  for (const id of ids) {
    const c = layer.get(id) ?? 0;
    if (!columns.has(c)) columns.set(c, []);
    columns.get(c)!.push(id);
  }
  const cols = [...columns.keys()].sort((a, b) => a - b);

  const pos: Record<string, XYPosition> = {};
  const rowIndex = new Map<string, number>();

  // First pass: initial ordering = insertion order.
  for (const c of cols) {
    columns.get(c)!.forEach((id, i) => rowIndex.set(id, i));
  }

  // Barycenter ordering sweeps to reduce crossings.
  for (let sweep = 0; sweep < 4; sweep++) {
    for (const c of cols) {
      const list = columns.get(c)!;
      const score = new Map<string, number>();
      for (const id of list) {
        const neigh = [...incoming.get(id)!, ...outgoing.get(id)!];
        const rows = neigh
          .map((n) => rowIndex.get(n))
          .filter((v): v is number => v !== undefined);
        score.set(
          id,
          rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : rowIndex.get(id)!,
        );
      }
      list.sort((a, b) => (score.get(a)! - score.get(b)!));
      list.forEach((id, i) => rowIndex.set(id, i));
    }
  }

  const maxRows = Math.max(...cols.map((c) => columns.get(c)!.length));
  for (let ci = 0; ci < cols.length; ci++) {
    const c = cols[ci];
    const list = columns.get(c)!;
    const offset = ((maxRows - list.length) * ROW_GAP) / 2;
    list.forEach((id, ri) => {
      pos[id] = {
        x: MARGIN + ci * COL_GAP,
        y: MARGIN + offset + ri * ROW_GAP,
      };
    });
  }

  return pos;
}
