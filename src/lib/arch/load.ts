import type { ArchElement } from "./types";

export type LoadStatus = "ok" | "warn" | "over" | "na";

export interface LoadRow {
  id: string;
  name: string;
  type: ArchElement["type"];
  offered: number | null; // req/msg per second arriving
  capacity: number | null; // total sustained capacity (instances * capacityRps)
  utilization: number | null; // offered / capacity
  status: LoadStatus;
  note?: string;
}

export interface LoadResult {
  rows: LoadRow[];
  errors: number;
  warnings: number;
}

const LOAD_TYPES = new Set<ArchElement["type"]>([
  "service",
  "api-gateway",
  "lambda",
  "saga",
  "stream",
  "external",
  "queue",
  "topic",
]);

function fmtRate(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k/s`;
  return `${Math.round(n)}/s`;
}

/**
 * Estimate and validate offered load vs. capacity for APIs, services and
 * messaging destinations. Queues/topics validate arrival rate vs. drain rate.
 */
export function computeLoad(elements: ArchElement[]): LoadResult {
  const rows: LoadRow[] = [];
  let errors = 0;
  let warnings = 0;

  for (const el of elements) {
    if (!LOAD_TYPES.has(el.type)) continue;
    const offered = typeof el.loadRps === "number" ? el.loadRps : null;

    const isQueue = el.type === "queue" || el.type === "topic";
    const instances = Math.max(1, el.instances ?? (isQueue ? el.partitions ?? 1 : 1));

    let capacity: number | null = null;
    if (isQueue) {
      capacity = typeof el.consumerRps === "number" ? el.consumerRps : null;
    } else {
      capacity =
        typeof el.capacityRps === "number" ? el.capacityRps * instances : null;
    }

    if (offered == null && capacity == null) continue;

    const utilization = capacity != null && capacity > 0 && offered != null ? offered / capacity : null;
    let status: LoadStatus = "na";
    let note: string | undefined;

    if (utilization != null) {
      if (utilization > 1) {
        status = "over";
        errors++;
        if (isQueue && offered != null && capacity != null) {
          const backlog = offered - capacity;
          note = `Backlog grows ~${fmtRate(backlog)} — consumers can't keep up. Add consumers/partitions or raise drain rate.`;
        } else {
          note = `Overloaded at ${Math.round(utilization * 100)}%. Scale out (more instances) or raise per-instance capacity.`;
        }
      } else if (utilization > 0.8) {
        status = "warn";
        warnings++;
        note = `Hot at ${Math.round(utilization * 100)}% — little headroom for spikes.`;
      } else {
        status = "ok";
        note = `${Math.round(utilization * 100)}% utilized.`;
      }
    } else if (offered != null && capacity == null) {
      note = isQueue
        ? "Set a consumer drain rate to validate backlog."
        : "Set a per-instance capacity to validate headroom.";
    }

    rows.push({
      id: el.id,
      name: el.name,
      type: el.type,
      offered,
      capacity,
      utilization,
      status,
      note,
    });
  }

  return { rows, errors, warnings };
}

export { fmtRate };
