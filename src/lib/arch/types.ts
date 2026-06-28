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
  | "saga"
  | "broker"
  | "relay"
  | "inbox-store";

export type TopicKind = "fanout" | "direct" | "topic" | "headers" | "pubsub";

export type BrokerKind =
  | "generic"
  | "rabbitmq"
  | "sqs"
  | "sns"
  | "kafka"
  | "eventbridge"
  | "redis-streams"
  | "gcp-pubsub";

export type DbEngine =
  | "generic"
  | "postgres"
  | "mysql"
  | "mongodb"
  | "dynamodb"
  | "cassandra"
  | "redis"
  | "elasticsearch"
  | "clickhouse";

export interface TopicBinding {
  queueId: string;
  routingKey?: string;
  filter?: string;
  contractId?: string;
}

export interface ArchElement {
  id: string;
  name: string;
  type: ElementType;
  idempotent?: boolean;
  hasOutbox?: boolean;
  hasInbox?: boolean;

  // topic-only
  topicKind?: TopicKind;
  bindings?: TopicBinding[];

  // service-only
  dataStores?: string[];
  /** stateless direct publish targets (topic / queue / broker ids) — no outbox. */
  publishesTo?: string[];
  /** stateless direct consume sources (topic / queue / broker ids) — no inbox. */
  consumesFrom?: string[];
  circuitBreaker?: boolean;
  retryPolicy?: "none" | "linear" | "exponential";
  /** auto-derived relay/inbox attachments live as separate elements; these point back. */
  outboxRelayId?: string;
  inboxStoreId?: string;
  /** outbox: where the relay publishes (topic / queue / broker element id). */
  outboxTargetId?: string;
  /** inbox: where messages are consumed from (topic / queue / broker element id). */
  inboxSourceId?: string;
  /** inbox: database hosting the dedup table — typically the same DB bound to the outbox. */
  inboxDbId?: string;

  // broker-specific (queue or topic)
  broker?: BrokerKind;
  /** topic/queue: id of a broker element that hosts this destination. */
  brokerId?: string;
  fifo?: boolean;
  partitions?: number;
  consumerGroup?: string;
  visibilityTimeoutSec?: number;
  maxReceives?: number;
  dlqId?: string;
  retryQueueId?: string;
  retryDelayMs?: number;
  retentionHours?: number;
  filterPolicy?: string;
  schemaContract?: boolean;

  // RabbitMQ realism
  rabbitDurable?: boolean;
  rabbitTtlMs?: number;
  rabbitMaxLength?: number;
  rabbitDlx?: string;        // dead-letter exchange name
  rabbitDlrk?: string;       // dead-letter routing key
  prefetch?: number;

  // Kafka realism
  replicationFactor?: number;
  minInSyncReplicas?: number;
  cleanupPolicy?: "delete" | "compact";

  // Roles when auto-created
  isRelayFor?: string;       // service id that owns this relay
  isInboxFor?: string;       // service id that owns this inbox
  isRetryFor?: string;       // queue id that owns this retry queue
  isDlqFor?: string;         // queue id that owns this dlq
  isReplicaOf?: string;      // db id this is a replica of

  // database-specific
  dbEngine?: DbEngine;
  dbReplicas?: number;
  dbConsistency?: "eventual" | "strong" | "quorum" | "one" | "all";
  dbWriteConcern?: string;   // mongo: "1" | "majority"
  dbReadPreference?: string; // mongo: "primary" | "secondary"
  dbMode?: string;           // redis: standalone/cluster/sentinel
  dbPersistence?: string;    // redis: none/AOF/RDB
  dbPartitionKey?: string;   // dynamodb
  dbShards?: number;         // elasticsearch
  dbIsolation?: string;      // sql isolation level

  // contract attached at the element level (topic/queue produce/consume contract)
  contractId?: string;

  // load / capacity estimation
  /** offered load: requests/s (service/api/external) or messages/s produced (topic/queue). */
  loadRps?: number;
  /** max sustained throughput a single instance/partition can handle (req|msg per s). */
  capacityRps?: number;
  /** number of instances / consumers / partitions sharing the load. */
  instances?: number;
  /** aggregate consumer drain rate for a queue/topic (msg/s). */
  consumerRps?: number;
}

export interface Contract {
  id: string;
  name: string;
  version: string;
  producerId?: string;
  consumerIds?: string[];
  schema?: string; // free-form (JSON, Avro, proto) text
}

export type StepKind = "sync" | "async" | "response" | "note";

export interface SeqStep {
  index: number;
  raw: string;
  kind: StepKind;
  from?: string;
  to?: string;
  label: string;
  contractId?: string;
}

export type Severity = "error" | "warning" | "info" | "success";

export type RemediationKind =
  | "addOutbox"
  | "addInbox"
  | "makeIdempotent"
  | "addDlq"
  | "addRetry"
  | "convertAsync"
  | "addContract"
  | "addCircuitBreaker";

export interface RemediationAction {
  kind: RemediationKind;
  targetId: string;          // element id (or step index encoded as string)
  label: string;
}

export interface SimEvent {
  stepIndex: number;
  severity: Severity;
  message: string;
  detail?: string;
  suggestions?: RemediationAction[];
}

export type FaultKind = "duplicate" | "drop" | "reorder" | "latency";

export interface Fault {
  stepIndex: number;
  kind: FaultKind;
}
