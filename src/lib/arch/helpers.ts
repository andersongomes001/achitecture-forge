import type { ArchElement } from "./types";

/** Update an element by id, returning a new list. */
export function patchElement(
  list: ArchElement[],
  id: string,
  patch: Partial<ArchElement>,
): ArchElement[] {
  return list.map((e) => (e.id === id ? { ...e, ...patch } : e));
}

function uniqueId(list: ArchElement[], base: string) {
  let id = base;
  let n = 2;
  while (list.some((e) => e.id === id)) id = `${base}_${n++}`;
  return id;
}

/** Add a DLQ for a queue (auto-creates the dlq queue element if needed). */
export function addDlqFor(list: ArchElement[], queueId: string): ArchElement[] {
  const q = list.find((e) => e.id === queueId);
  if (!q || q.type !== "queue" || q.dlqId) return list;
  const dlqId = uniqueId(list, `${queueId}_DLQ`);
  const dlq: ArchElement = {
    id: dlqId,
    name: `${q.name} · DLQ`,
    type: "queue",
    broker: q.broker,
    retentionHours: 336,
    isDlqFor: queueId,
  };
  return patchElement([...list, dlq], queueId, {
    dlqId,
    maxReceives: q.maxReceives ?? 5,
  });
}

/** Add a retry queue for a queue (auto-creates the retry queue element). */
export function addRetryFor(
  list: ArchElement[],
  queueId: string,
  delayMs = 30000,
): ArchElement[] {
  const q = list.find((e) => e.id === queueId);
  if (!q || q.type !== "queue" || q.retryQueueId) return list;
  const retryId = uniqueId(list, `${queueId}_RETRY`);
  const retry: ArchElement = {
    id: retryId,
    name: `${q.name} · Retry`,
    type: "queue",
    broker: q.broker,
    retentionHours: 24,
    retryDelayMs: delayMs,
    isRetryFor: queueId,
  };
  return patchElement([...list, retry], queueId, { retryQueueId: retryId });
}

/** Toggle outbox on a service — when turning on, auto-creates an outbox-relay element. */
export function setOutbox(list: ArchElement[], serviceId: string, on: boolean): ArchElement[] {
  const svc = list.find((e) => e.id === serviceId);
  if (!svc || svc.type !== "service") return list;
  if (on) {
    if (svc.outboxRelayId) return patchElement(list, serviceId, { hasOutbox: true });
    const relayId = uniqueId(list, `${serviceId}_RELAY`);
    const relay: ArchElement = {
      id: relayId,
      name: `${svc.name} · Outbox Relay`,
      type: "relay",
      idempotent: true,
      isRelayFor: serviceId,
    };
    return patchElement([...list, relay], serviceId, { hasOutbox: true, outboxRelayId: relayId });
  }
  // turning off — remove the relay
  let next = list;
  if (svc.outboxRelayId) next = next.filter((e) => e.id !== svc.outboxRelayId);
  return patchElement(next, serviceId, { hasOutbox: false, outboxRelayId: undefined });
}

/** Toggle inbox on a service — when turning on, auto-creates an inbox-store element. */
export function setInbox(list: ArchElement[], serviceId: string, on: boolean): ArchElement[] {
  const svc = list.find((e) => e.id === serviceId);
  if (!svc) return list;
  if (svc.type !== "service" && svc.type !== "queue") {
    // Inbox is the idempotency mechanism — enabling it implies idempotent processing.
    return patchElement(list, serviceId, { hasInbox: on, idempotent: on ? true : svc.idempotent });
  }
  if (on) {
    if (svc.inboxStoreId)
      return patchElement(list, serviceId, { hasInbox: true, idempotent: true });
    const inboxId = uniqueId(list, `${serviceId}_INBOX`);
    const inbox: ArchElement = {
      id: inboxId,
      name: `${svc.name} · Inbox`,
      type: "inbox-store",
      isInboxFor: serviceId,
    };
    // Inbox guarantees idempotency by deduplicating on message id.
    return patchElement([...list, inbox], serviceId, {
      hasInbox: true,
      idempotent: true,
      inboxStoreId: inboxId,
    });
  }
  let next = list;
  if (svc.inboxStoreId) next = next.filter((e) => e.id !== svc.inboxStoreId);
  return patchElement(next, serviceId, { hasInbox: false, inboxStoreId: undefined });
}

/** Replica nodes for a database based on its dbReplicas count. */
export function syncDbReplicas(list: ArchElement[]): ArchElement[] {
  const dbs = list.filter((e) => e.type === "database" && (e.dbReplicas ?? 0) > 0);
  const existing = new Map<string, ArchElement[]>();
  for (const e of list) {
    if (e.isReplicaOf) {
      const arr = existing.get(e.isReplicaOf) ?? [];
      arr.push(e);
      existing.set(e.isReplicaOf, arr);
    }
  }
  let next = [...list];
  for (const db of dbs) {
    const want = db.dbReplicas ?? 0;
    const have = existing.get(db.id) ?? [];
    if (have.length < want) {
      for (let i = have.length; i < want; i++) {
        const repId = uniqueId(next, `${db.id}_R${i + 1}`);
        next.push({
          id: repId,
          name: `${db.name} · Replica ${i + 1}`,
          type: "database",
          dbEngine: db.dbEngine,
          isReplicaOf: db.id,
        });
      }
    } else if (have.length > want) {
      const drop = have.slice(want).map((r) => r.id);
      next = next.filter((e) => !drop.includes(e.id));
    }
  }
  // remove orphan replicas whose parent has no replicas or doesn't exist
  next = next.filter((e) => {
    if (!e.isReplicaOf) return true;
    const parent = next.find((p) => p.id === e.isReplicaOf);
    if (!parent || (parent.dbReplicas ?? 0) === 0) return false;
    return true;
  });
  return next;
}

/** Convert a step from sync to async by mutating the source text. */
export function convertStepToAsync(seqSrc: string, stepIndex: number): string {
  const lines = seqSrc.split("\n");
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || l.startsWith("%%") || l.startsWith("sequenceDiagram") || l === "autonumber") continue;
    if (/^(participant|actor|note)\b/i.test(l)) continue;
    idx++;
    if (idx === stepIndex) {
      lines[i] = lines[i].replace("->>", "-)");
      break;
    }
  }
  return lines.join("\n");
}
