import type { ArchElement, ElementType } from "./types";
import { parseSequence } from "./parser";

/** Heuristic type inference from a participant alias/label. */
export function inferType(id: string, label?: string): ElementType {
  const s = `${id} ${label ?? ""}`.toLowerCase();
  if (/(gateway|gw|apigw|kong|envoy|alb|elb|nginx|cdn)/.test(s)) return "api-gateway";
  if (/(lambda|function|fn_|faas)/.test(s)) return "lambda";
  if (/(cron|schedule|scheduler|eventbridge.*rule)/.test(s)) return "scheduler";
  if (/(saga|orchestrator|workflow|stepfn|temporal)/.test(s)) return "saga";
  if (/(stream|kafka.*stream|kinesis|flink)/.test(s)) return "stream";
  if (/(cache|redis|memcache|varnish)/.test(s)) return "cache";
  if (/(^q_|queue|sqs|rabbit.*q|^dlq|_dlq$)/.test(s)) return "queue";
  if (/(topic|bus|sns|exchange|kafka|pubsub|eventbridge)/.test(s)) return "topic";
  if (/(^db$|_db$|database|postgres|mysql|mongo|dynamo|cassandra|^rdb$|^wdb$)/.test(s)) return "database";
  if (/(external|3rd|third.party|stripe|twilio|sendgrid|webhook)/.test(s)) return "external";
  return "service";
}

export interface ImportResult {
  elements: ArchElement[];
  edges: { id: string; source: string; target: string; kind: "sync" | "async" | "response" }[];
}

/**
 * Map a mermaid sequenceDiagram source into Forge elements + canvas edges,
 * preserving any pre-existing element configuration (flags, broker, etc.).
 */
export function importFromMermaid(src: string, existing: ArchElement[] = []): ImportResult {
  const parsed = parseSequence(src);
  const byId = new Map(existing.map((e) => [e.id, e]));
  const out: ArchElement[] = [];

  for (const p of parsed.participants) {
    const prev = byId.get(p.id);
    if (prev) {
      out.push({ ...prev, name: prev.name || p.label });
    } else {
      const type = inferType(p.id, p.label);
      const base: ArchElement = {
        id: p.id,
        name: p.label || p.id,
        type,
      };
      if (type === "topic") {
        base.topicKind = "fanout";
        base.bindings = [];
        base.broker = "generic";
      }
      if (type === "queue") {
        base.broker = "generic";
        base.hasInbox = true;
      }
      out.push(base);
    }
  }

  // edges from steps (one per unique from→to+kind pair)
  const edges: ImportResult["edges"] = [];
  const seen = new Set<string>();
  for (const s of parsed.steps) {
    if (!s.from || !s.to || s.kind === "note") continue;
    const key = `${s.from}->${s.to}:${s.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      id: `imp:${key}`,
      source: s.from,
      target: s.to,
      kind: s.kind as "sync" | "async" | "response",
    });
  }

  return { elements: out, edges };
}
