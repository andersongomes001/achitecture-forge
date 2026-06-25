export type ElementType =
  | "service"
  | "database"
  | "queue"
  | "topic"
  | "cache"
  | "external";

export interface ArchElement {
  id: string; // short alias used in sequence diagram (e.g. "API")
  name: string;
  type: ElementType;
  idempotent?: boolean;
  hasOutbox?: boolean;
  hasInbox?: boolean;
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
