export type ElementType =
  | "service"
  | "database"
  | "queue"
  | "topic"
  | "cache"
  | "external"
  | "api-gateway"
  | "lambda"
  | "scheduler"
  | "stream"
  | "saga";

export type TopicKind = "fanout" | "direct" | "topic" | "headers" | "pubsub";

/**
 * Concrete messaging broker. Drives which broker-specific fields are
 * shown/applied and the warnings emitted by the simulator (e.g. SQS FIFO
 * requires a MessageGroupId, Kafka ordering is per-partition, SNS without
 * subscription filter fans out everything, etc.).
 */
export type BrokerKind =
  | "generic"
  | "rabbitmq"
  | "sqs"
  | "sns"
  | "kafka"
  | "eventbridge"
  | "redis-streams"
  | "gcp-pubsub";

export interface TopicBinding {
  queueId: string; // ArchElement.id of a queue
  routingKey?: string;
  /** SNS-style attribute filter or EventBridge pattern (free-form text). */
  filter?: string;
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

  // ───── broker-specific (queue or topic) ─────
  broker?: BrokerKind;
  /** SQS/RabbitMQ FIFO ordering. */
  fifo?: boolean;
  /** Kafka partitions or SQS message-group hint. */
  partitions?: number;
  /** Consumer group / subscription name (Kafka, PubSub). */
  consumerGroup?: string;
  /** Visibility timeout in seconds (SQS, RabbitMQ ack timeout). */
  visibilityTimeoutSec?: number;
  /** Max receives before DLQ (SQS redrive). */
  maxReceives?: number;
  /** Bound DLQ — references another queue element id. */
  dlqId?: string;
  /** Message retention in hours. */
  retentionHours?: number;
  /** SNS subscription filter / EventBridge pattern. */
  filterPolicy?: string;
  /** Kafka — has a schema registry contract. */
  schemaContract?: boolean;
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
