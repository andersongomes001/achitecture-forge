## Forge — Miro-style canvas + deep distributed-systems testing

Big upgrade across canvas UX, component depth, and live simulation. Grouped into 6 work areas so we can ship incrementally.

### 1. Miro-style canvas layout
- Full-bleed canvas as the primary surface (the current ~480px panel becomes the whole work area). Right side: collapsible inspector for the selected element. Left side: floating palette (draggable chips). Top: floating toolbar (templates, import, simulate, fault injection).
- Pan/zoom with infinite background, grid + dot toggle, fit-to-view, zoom-to-selection.
- Multi-select (marquee), copy/paste, duplicate, delete, undo/redo (history stack in memory).
- Snap-to-grid + alignment guides while dragging.
- **Smart edge routing**: replace default bezier with orthogonal routing that recomputes when nodes move, with auto-chosen handles (closest sides of source/target). Use React Flow `SmoothStepEdge` + dynamic `sourceHandle`/`targetHandle` selection based on relative positions of the two nodes; recompute on every node-position change.
- Edge labels with badges (broker, routing key, contract name).

### 2. Queue component — DLQ + retry inline
On a Queue node, add inline mini-buttons:
- `+ DLQ` → auto-creates a sibling queue named `<id>.dlq`, wires it as `dlqId`, draws the red dashed `dlq` managed edge.
- `+ Retry` → auto-creates `<id>.retry` queue with configurable delay (5s/30s/5m) + `maxReceives`; draws an amber dashed `retry` managed edge with the delay as label.
- Visibility timeout, retention, FIFO, message-group key — all in the inspector with per-broker validation (SQS FIFO needs group id, Kafka uses partitions instead of FIFO, etc.).

### 3. Database component — type-aware config
New `DbEngine`: `postgres | mysql | mongodb | dynamodb | cassandra | redis | elasticsearch | clickhouse`. Inspector shows fields that exist on that engine:
- Postgres/MySQL: replicas (read-replica count), failover mode (sync/async), connection pool size, isolation level.
- MongoDB: replica set size, write concern (w=1/majority), read preference.
- DynamoDB: partition key, consistency (eventual/strong), on-demand vs provisioned, streams on/off.
- Cassandra: replication factor, consistency level (ONE/QUORUM/ALL), keyspace.
- Redis: mode (standalone/cluster/sentinel), persistence (none/AOF/RDB), eviction policy.
- Elasticsearch: shards, replicas, refresh interval.
- ClickHouse: engine family, replication.
Auto-render read-replica nodes as small attached node + `replica` managed edge when count > 0.

### 4. RabbitMQ & broker realism
RabbitMQ-specific on topic/queue: exchange type (direct/fanout/topic/headers), routing key per binding (already partial — extend), queue arguments (`x-message-ttl`, `x-max-length`, `x-dead-letter-exchange`, `x-dead-letter-routing-key`), durable/auto-delete/exclusive, prefetch count on consumer.
Kafka: replication factor, min in-sync replicas, cleanup policy (delete/compact), partition key field name.
SNS: protocol per subscription (sqs/http/lambda), raw message delivery toggle.
EventBridge: bus name, event-pattern editor.

### 5. Outbox/Inbox → automatic Relay components
When a service is toggled `hasOutbox`:
- Auto-create an `outbox-relay` component (new `ElementType: "relay"`) named `<id>.outbox-relay` attached to the service's DB and to the downstream topic/queue. Draw managed edges `relay-read` (from DB) and `relay-publish` (to broker). Removing the toggle removes the relay.

When `hasInbox`:
- Auto-create `<id>.inbox` table node attached to the service (managed `owns` edge) and validate dedup on incoming async messages goes through it.

### 6. Contracts
- New top-level `contracts` collection: `{ id, name, version, schema (JSON), producerId, consumerIds[] }`.
- Attach a contract to a step (label binding) or to a topic/queue. Inspector: contract editor (name, version, schema textarea). Steps reference contract by name.
- Simulator validates: every async message has a contract; consumer is in `consumerIds`; producer matches `producerId`; warns on version mismatch.

### 7. Live data-flow simulation + remediation
- Step-by-step play/pause/scrub controls in the toolbar.
- During play, an animated "packet" (small dot) travels along the active edge from producer to consumer in sequence order. Speed slider. Highlight current step in the timeline.
- Failures show inline on the canvas: red pulse on the failing edge, a popover with **"Why it failed"** + **"How to fix"** offering one-click remediation:
  - "Add Outbox to <service>" → toggles `hasOutbox` (which now also creates the relay).
  - "Add Inbox to <consumer>" → toggles `hasInbox`.
  - "Add DLQ to <queue>" → calls the DLQ helper.
  - "Add retry queue to <queue>" → calls retry helper.
  - "Make consumer idempotent" → toggles `idempotent`.
  - "Convert sync→async" → mutates the step edge kind.
  - "Add contract" → opens contract editor pre-filled.
- After a remediation click, re-run the simulator and update the report.

### 8. Extra distributed-systems testing features
- **Fault injection expansion**: latency (slow), partial failure (5xx), partition (drop all messages between two nodes for N steps), clock skew on a service (affects idempotency windows).
- **Backpressure check**: warn if a fast producer feeds a queue without `maxReceives` / consumer concurrency set.
- **Ordering check**: per-partition ordering for Kafka, FIFO group-id check for SQS FIFO.
- **At-least-once vs exactly-once** badge per edge based on consumer config.
- **Saga compensation map**: on Saga node, declare forward + compensation step pairs; simulator runs compensations on injected failure.
- **Circuit breaker** flag on services (open/half-open/closed) — sync calls fail fast when open.
- **Trace view**: after a run, a Gantt-style timeline showing each step's start/end + injected delays.
- **Export**: download current architecture as JSON + as a regenerated Mermaid `sequenceDiagram` + as a flowchart.

### Technical notes
- Type additions in `src/lib/arch/types.ts`: `relay` element type, `DbEngine`, contract types, retry-queue metadata, replica counts, broker-arg bags.
- Edge routing helper in `src/components/arch/edgeRouting.ts` that picks handles based on `dx/dy` between node centers; React Flow `onNodesChange` triggers a memo recompute.
- New `src/components/arch/Inspector.tsx` (right panel) replacing today's stacked `ElementCard` cards.
- New `src/components/arch/Toolbar.tsx` (top floating bar) and `src/components/arch/Palette.tsx` (left floating chips).
- Simulator gains a streaming mode: yields events over time via `setTimeout` so the canvas can animate; existing batch `simulate()` stays for the report tab.
- Remediation actions are dispatched through a single `applyRemediation(action, ctx)` so the popover and the report use the same code path.

### Suggested rollout (parallelizable in 3 PRs)
1. Canvas UX shell (1, 2, 5) — Miro layout, inline DLQ/retry, auto relays. Highest user-visible impact.
2. Component depth (3, 4, 6) — DB engines, broker realism, contracts.
3. Live simulation + remediation + extras (7, 8).

Want me to start with all three at once, or ship #1 first so you can validate the layout before the deeper changes land?
