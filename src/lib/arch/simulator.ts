import type {
  ArchElement,
  Contract,
  Fault,
  RemediationAction,
  SeqStep,
  SimEvent,
} from "./types";

interface SimInput {
  elements: ArchElement[];
  steps: SeqStep[];
  faults: Fault[];
  contracts?: Contract[];
}

export interface SimResult {
  events: SimEvent[];
  timeline: {
    stepIndex: number;
    raw: string;
    delivered: boolean;
    duplicated: boolean;
    latencyMs?: number;
    note?: string;
  }[];
  summary: { errors: number; warnings: number; infos: number };
}

export function simulate({ elements, steps, faults, contracts = [] }: SimInput): SimResult {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const contractById = new Map(contracts.map((c) => [c.id, c]));
  const events: SimEvent[] = [];
  const timeline: SimResult["timeline"] = [];

  const received = new Map<string, Map<string, number>>();
  const pendingDbWrite = new Map<string, boolean>();
  const openBreakers = new Set<string>();

  const faultByStep = new Map<number, Fault["kind"][]>();
  for (const f of faults) {
    const arr = faultByStep.get(f.stepIndex) ?? [];
    arr.push(f.kind);
    faultByStep.set(f.stepIndex, arr);
  }

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
    const latency = stepFaults.includes("latency");

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
      timeline.push({
        stepIndex: step.index,
        raw: step.raw,
        delivered: true,
        duplicated: false,
        note: step.label,
      });
      continue;
    }

    const from = step.from!;
    const to = step.to!;
    const consumer = byId.get(to);
    const producer = byId.get(from);

    if (latency && step.kind === "sync") {
      events.push({
        stepIndex: step.index,
        severity: producer?.circuitBreaker ? "warning" : "error",
        message: `High latency on sync ${from} → ${to}`,
        detail: producer?.circuitBreaker
          ? "Circuit breaker should trip and fail fast."
          : "No circuit breaker on caller — thread/connection pool will exhaust.",
        suggestions: producer?.circuitBreaker
          ? undefined
          : [{ kind: "addCircuitBreaker", targetId: from, label: `Add circuit breaker to ${from}` }],
      });
    }

    if (drop) {
      const sugg: RemediationAction[] = [];
      if (step.kind === "async" && consumer?.type === "queue") {
        if (!consumer.dlqId)
          sugg.push({ kind: "addDlq", targetId: to, label: `Add DLQ to ${to}` });
        if (!consumer.retryQueueId)
          sugg.push({ kind: "addRetry", targetId: to, label: `Add retry queue to ${to}` });
      }
      events.push({
        stepIndex: step.index,
        severity: step.kind === "sync" ? "error" : "warning",
        message: `Message dropped: ${from} → ${to} "${step.label}"`,
        detail:
          step.kind === "sync"
            ? "Synchronous call lost — caller will time out and fail."
            : "Async message lost — without retries the consumer never processes it.",
        suggestions: sugg.length ? sugg : undefined,
      });
      timeline.push({ stepIndex: step.index, raw: step.raw, delivered: false, duplicated: false });
      continue;
    }

    // Dual-write
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
        suggestions: [{ kind: "addOutbox", targetId: from, label: `Add Outbox + Relay to ${from}` }],
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

    // Sync into messaging infra
    if (step.kind === "sync" && (consumer?.type === "queue" || consumer?.type === "topic")) {
      events.push({
        stepIndex: step.index,
        severity: "warning",
        message: `Sync call into ${consumer.type} ${to}`,
        detail: "Messaging infrastructure should be invoked asynchronously. Use -) instead of ->>.",
        suggestions: [
          { kind: "convertAsync", targetId: String(step.index), label: `Convert step ${step.index + 1} to async` },
        ],
      });
    }

    // Tight sync coupling
    if (step.kind === "sync" && producer?.type === "service" && consumer?.type === "service") {
      const sugg: RemediationAction[] = [];
      if (!producer.circuitBreaker)
        sugg.push({ kind: "addCircuitBreaker", targetId: from, label: `Add circuit breaker to ${from}` });
      events.push({
        stepIndex: step.index,
        severity: producer.circuitBreaker ? "info" : "warning",
        message: `Sync coupling: ${from} → ${to}`,
        detail: "Caller's availability is bound to callee. Consider async or a circuit breaker.",
        suggestions: sugg.length ? sugg : undefined,
      });
    }

    // Contract checks (when a contract is attached at edge or step)
    const contractId = step.contractId ?? consumer?.contractId ?? producer?.contractId;
    if (step.kind === "async" && contractId) {
      const c = contractById.get(contractId);
      if (c) {
        if (c.producerId && c.producerId !== from) {
          events.push({
            stepIndex: step.index,
            severity: "warning",
            message: `Contract producer mismatch on ${c.name} v${c.version}`,
            detail: `Contract declares producer ${c.producerId} but ${from} is publishing.`,
          });
        }
        if (c.consumerIds && consumer?.type === "service" && !c.consumerIds.includes(to)) {
          events.push({
            stepIndex: step.index,
            severity: "warning",
            message: `Undeclared consumer for ${c.name} v${c.version}`,
            detail: `${to} consumes the contract but is not in its consumer list.`,
          });
        }
      }
    }

    // FIFO / ordering hint
    if (step.kind === "async" && consumer?.type === "queue" && consumer.broker === "sqs" && consumer.fifo) {
      if (!consumer.partitions && !consumer.consumerGroup) {
        events.push({
          stepIndex: step.index,
          severity: "info",
          message: `SQS FIFO ${to} needs a MessageGroupId`,
          detail: "Ordering only holds per group. Configure the partition/group key.",
        });
      }
    }
    if (step.kind === "async" && consumer?.type === "topic" && consumer.broker === "kafka" && (consumer.partitions ?? 0) > 1) {
      events.push({
        stepIndex: step.index,
        severity: "info",
        message: `Kafka ordering is per-partition on ${to}`,
        detail: `Topic has ${consumer.partitions} partitions — pick a partition key for ordering.`,
      });
    }

    const deliverOnce = () => {
      if (!consumer) return;
      const map = received.get(to) ?? new Map<string, number>();
      const count = (map.get(step.label) ?? 0) + 1;
      map.set(step.label, count);
      received.set(to, map);

      if (count > 1) {
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
              suggestions: [
                { kind: "addInbox", targetId: to, label: `Add Inbox to ${to}` },
                { kind: "makeIdempotent", targetId: to, label: `Mark ${to} idempotent` },
              ],
            });
          }
        }
      } else if (
        step.kind === "async" &&
        consumer.type === "service" &&
        !consumer.hasInbox &&
        !consumer.idempotent
      ) {
        events.push({
          stepIndex: step.index,
          severity: "warning",
          message: `${to} has no dedup`,
          detail: `Async consumer ${to} has no Inbox and is not idempotent. At-least-once delivery will cause double-processing.`,
          suggestions: [
            { kind: "addInbox", targetId: to, label: `Add Inbox to ${to}` },
            { kind: "makeIdempotent", targetId: to, label: `Mark ${to} idempotent` },
          ],
        });
      }
    };

    deliverOnce();
    if (duplicate) {
      events.push({
        stepIndex: step.index,
        severity: "info",
        message: `Injected duplicate delivery of "${step.label}" → ${to}`,
      });
      deliverOnce();
    }

    timeline.push({
      stepIndex: step.index,
      raw: step.raw,
      delivered: true,
      duplicated: duplicate,
      latencyMs: latency ? 2500 : undefined,
    });

    void openBreakers;
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
