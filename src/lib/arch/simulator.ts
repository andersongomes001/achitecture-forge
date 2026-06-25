import type { ArchElement, Fault, SeqStep, SimEvent } from "./types";

interface SimInput {
  elements: ArchElement[];
  steps: SeqStep[];
  faults: Fault[];
}

interface DeliveredMsg {
  key: string; // label
  from: string;
  to: string;
  stepIndex: number;
}

export interface SimResult {
  events: SimEvent[];
  timeline: {
    stepIndex: number;
    raw: string;
    delivered: boolean;
    duplicated: boolean;
    note?: string;
  }[];
  summary: { errors: number; warnings: number; infos: number };
}

export function simulate({ elements, steps, faults }: SimInput): SimResult {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const events: SimEvent[] = [];
  const timeline: SimResult["timeline"] = [];

  // Per-consumer received message keys (for duplicate-detection rule)
  const received = new Map<string, Map<string, number>>();
  // Per-service pending DB writes (from Notes mentioning "db" or "write")
  const pendingDbWrite = new Map<string, boolean>();

  const faultByStep = new Map<number, Fault["kind"][]>();
  for (const f of faults) {
    const arr = faultByStep.get(f.stepIndex) ?? [];
    arr.push(f.kind);
    faultByStep.set(f.stepIndex, arr);
  }

  // Apply reorder: simple swap with next step
  const order = steps.map((_, i) => i);
  for (let i = 0; i < order.length - 1; i++) {
    if (faultByStep.get(order[i])?.includes("reorder")) {
      [order[i], order[i + 1]] = [order[i + 1], order[i]];
    }
  }

  for (const oi of order) {
    const step = steps[oi];
    const stepFaults = faultByStep.get(step.index) ?? [];
    const drop = stepFaults.includes("drop");
    const duplicate = stepFaults.includes("duplicate");

    if (step.kind === "note") {
      const who = step.from!;
      const label = step.label.toLowerCase();
      if (/(db|database|write|persist|save|insert|update)/.test(label)) {
        pendingDbWrite.set(who, true);
        events.push({
          stepIndex: step.index,
          severity: "info",
          message: `${who} performed local DB write`,
          detail: step.label,
        });
      }
      timeline.push({ stepIndex: step.index, raw: step.raw, delivered: true, duplicated: false, note: step.label });
      continue;
    }

    const from = step.from!;
    const to = step.to!;
    const consumer = byId.get(to);
    const producer = byId.get(from);

    if (drop) {
      events.push({
        stepIndex: step.index,
        severity: step.kind === "sync" ? "error" : "warning",
        message: `Message dropped: ${from} → ${to} "${step.label}"`,
        detail:
          step.kind === "sync"
            ? "Synchronous call lost — caller will time out and fail."
            : "Async message lost — without retries the consumer never processes it.",
      });
      timeline.push({ stepIndex: step.index, raw: step.raw, delivered: false, duplicated: false });
      continue;
    }

    // Validate outbox pattern: producer is service with pending DB write, sending async
    if (
      step.kind === "async" &&
      producer?.type === "service" &&
      pendingDbWrite.get(from) &&
      !producer.hasOutbox
    ) {
      events.push({
        stepIndex: step.index,
        severity: "error",
        message: `Dual-write risk at ${from}`,
        detail: `${from} wrote to its DB and now publishes async to ${to} without an Outbox. If the publish fails, the system is inconsistent.`,
      });
    } else if (
      step.kind === "async" &&
      producer?.type === "service" &&
      pendingDbWrite.get(from) &&
      producer.hasOutbox
    ) {
      events.push({
        stepIndex: step.index,
        severity: "success",
        message: `Outbox used by ${from}`,
        detail: "DB write + event publish are atomic via outbox.",
      });
    }
    if (step.kind === "async" && producer?.type === "service") {
      pendingDbWrite.delete(from);
    }

    // Sync call to a queue/topic is suspicious
    if (step.kind === "sync" && (consumer?.type === "queue" || consumer?.type === "topic")) {
      events.push({
        stepIndex: step.index,
        severity: "warning",
        message: `Sync call into ${consumer.type} ${to}`,
        detail: "Messaging infrastructure should be invoked asynchronously. Use -) instead of ->>.",
      });
    }

    // Sync call across two services — tight coupling info
    if (step.kind === "sync" && producer?.type === "service" && consumer?.type === "service") {
      events.push({
        stepIndex: step.index,
        severity: "info",
        message: `Sync coupling: ${from} → ${to}`,
        detail: "Caller's availability is bound to callee. Consider async if not strictly needed.",
      });
    }

    // Deliver
    const deliverOnce = (dupTag: boolean) => {
      if (!consumer) return;
      const map = received.get(to) ?? new Map<string, number>();
      const count = (map.get(step.label) ?? 0) + 1;
      map.set(step.label, count);
      received.set(to, map);

      if (count > 1) {
        // duplicate arrived at consumer
        if (step.kind === "async") {
          if (consumer.hasInbox) {
            events.push({
              stepIndex: step.index,
              severity: "success",
              message: `Inbox at ${to} deduplicated "${step.label}"`,
            });
          } else if (consumer.idempotent) {
            events.push({
              stepIndex: step.index,
              severity: "info",
              message: `${to} is idempotent — duplicate "${step.label}" absorbed`,
            });
          } else {
            events.push({
              stepIndex: step.index,
              severity: "error",
              message: `Duplicate processed twice at ${to}`,
              detail: `${to} received "${step.label}" ${count}x but has no Inbox and is not marked idempotent. Side-effects will repeat.`,
            });
          }
        }
      } else if (step.kind === "async" && consumer.type === "service" && !consumer.hasInbox && !consumer.idempotent) {
        events.push({
          stepIndex: step.index,
          severity: "warning",
          message: `${to} has no dedup`,
          detail: `Async consumer ${to} has no Inbox and is not idempotent. At-least-once delivery will cause double-processing.`,
        });
      }
      void dupTag;
    };

    deliverOnce(false);
    if (duplicate) {
      events.push({
        stepIndex: step.index,
        severity: "info",
        message: `Injected duplicate delivery of "${step.label}" → ${to}`,
      });
      deliverOnce(true);
    }

    timeline.push({
      stepIndex: step.index,
      raw: step.raw,
      delivered: true,
      duplicated: duplicate,
    });
  }

  const summary = events.reduce(
    (acc, e) => {
      if (e.severity === "error") acc.errors++;
      else if (e.severity === "warning") acc.warnings++;
      else acc.infos++;
      return acc;
    },
    { errors: 0, warnings: 0, infos: 0 },
  );

  return { events, timeline, summary };
}
