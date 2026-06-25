export type ElementType =
  | "service"
  | "database"
  | "queue"
  | "topic"
  | "cache"
  | "external";

export type TopicKind = "fanout" | "direct" | "topic" | "headers" | "pubsub";

export interface TopicBinding {
  queueId: string; // ArchElement.id of a queue
  routingKey?: string;
}

export interface ArchElement {
  id: string; // short alias used in sequence diagram (e.g. "API")
  name: string;
  type: ElementType;
  idempotent?: boolean;
  hasOutbox?: boolean;
  hasInbox?: boolean;
  // topic-only
  topicKind?: TopicKind;
  bindings?: TopicBinding[];
  // service-only: owned databases / caches
  dataStores?: string[]; // ArchElement.id list
}

export type StepKind = "sync" | "async" | "response" | "note";

export interface SeqStep {
  index: number;
  raw: string;
  kind: StepKind;
  from?: string;
  to?: string;
  label: string;
}

export type Severity = "error" | "warning" | "info" | "success";

export interface SimEvent {
  stepIndex: number;
  severity: Severity;
  message: string;
  detail?: string;
}

export type FaultKind = "duplicate" | "drop" | "reorder";

export interface Fault {
  stepIndex: number;
  kind: FaultKind;
}
