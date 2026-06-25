import { useMemo, useState } from "react";
import { MermaidView } from "@/components/arch/MermaidView";
import { ArchCanvas, type CanvasState, type ManagedEdge, type EdgeKind } from "@/components/arch/ArchCanvas";
import { parseSequence } from "@/lib/arch/parser";
import { importFromMermaid } from "@/lib/arch/import";
import { simulate } from "@/lib/arch/simulator";
import type { ArchElement, BrokerKind, ElementType, Fault, Severity, TopicKind, TopicBinding } from "@/lib/arch/types";
import { createFileRoute } from "@tanstack/react-router";


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Forge — Architecture Design Tester" },
      {
        name: "description",
        content:
          "Design distributed systems and simulate sequence diagrams to catch idempotency, outbox/inbox and async delivery bugs before they ship.",
      },
      { property: "og:title", content: "Forge — Architecture Design Tester" },
      {
        property: "og:description",
        content:
          "Drag in services, queues and databases. Write a Mermaid sequence. Run the simulator and surface dual-write, dedup and sync-coupling issues.",
      },
    ],
  }),
  component: ForgePage,
});

const TYPE_META: Record<ElementType, { label: string; glyph: string; color: string }> = {
  service: { label: "Service", glyph: "◇", color: "var(--color-primary)" },
  database: { label: "Database", glyph: "▭", color: "var(--color-info)" },
  queue: { label: "Queue", glyph: "≡", color: "var(--color-warning)" },
  topic: { label: "Topic", glyph: "✦", color: "var(--color-accent)" },
  cache: { label: "Cache", glyph: "◷", color: "var(--color-success)" },
  external: { label: "External", glyph: "◯", color: "var(--color-muted-foreground)" },
  "api-gateway": { label: "API Gateway", glyph: "⌥", color: "var(--color-primary)" },
  lambda: { label: "Lambda / FaaS", glyph: "λ", color: "var(--color-accent)" },
  scheduler: { label: "Scheduler", glyph: "⏱", color: "var(--color-info)" },
  stream: { label: "Stream Processor", glyph: "⌇", color: "var(--color-warning)" },
  saga: { label: "Saga Orchestrator", glyph: "⎈", color: "var(--color-success)" },
};

const DEFAULT_ELEMENTS: ArchElement[] = [
  { id: "API", name: "Orders API", type: "service" },
  { id: "DB", name: "Orders DB", type: "database" },
  { id: "BUS", name: "Events Bus", type: "topic" },
  { id: "WORKER", name: "Email Worker", type: "service" },
];

const DEFAULT_SEQ = `sequenceDiagram
  autonumber
  participant API as Orders API
  participant DB as Orders DB
  participant BUS as Events Bus
  participant WORKER as Email Worker

  API->>DB: insert order
  Note over API: db write committed
  API-)BUS: OrderPlaced
  BUS-)WORKER: OrderPlaced
  WORKER->>WORKER: send confirmation email
`;

const TEMPLATES: Record<string, { elements: ArchElement[]; seq: string }> = {
  outbox: {
    elements: [
      { id: "API", name: "Orders API", type: "service", hasOutbox: true, idempotent: true, dataStores: ["DB"] },
      { id: "DB", name: "Orders DB", type: "database" },
      { id: "RELAY", name: "Outbox Relay", type: "service", idempotent: true },
      { id: "BUS", name: "Events Bus", type: "topic", topicKind: "fanout", bindings: [{ queueId: "Q_MAIL" }] },
      { id: "Q_MAIL", name: "Mail Queue", type: "queue", hasInbox: true },
      { id: "MAIL", name: "Email Worker", type: "service", hasInbox: true, idempotent: true },
    ],
    seq: `sequenceDiagram
  autonumber
  participant API
  participant DB
  participant RELAY
  participant BUS
  participant Q_MAIL
  participant MAIL

  API->>DB: insert order + outbox row
  Note over API: db write committed
  RELAY->>DB: poll outbox
  RELAY-)BUS: OrderPlaced
  BUS-)Q_MAIL: OrderPlaced
  Q_MAIL-)MAIL: OrderPlaced
  MAIL->>MAIL: send email
`,
  },
  cqrs: {
    elements: [
      { id: "API", name: "Write API", type: "service", dataStores: ["WDB"] },
      { id: "WDB", name: "Write DB", type: "database" },
      { id: "BUS", name: "Domain Events", type: "topic", topicKind: "pubsub", bindings: [{ queueId: "Q_PROJ" }] },
      { id: "Q_PROJ", name: "Projector Queue", type: "queue", hasInbox: true },
      { id: "PROJ", name: "Projector", type: "service", idempotent: true, dataStores: ["RDB"] },
      { id: "RDB", name: "Read Model", type: "database" },
      { id: "READ", name: "Query API", type: "service", dataStores: ["RDB"] },
    ],
    seq: `sequenceDiagram
  autonumber
  participant API
  participant WDB
  participant BUS
  participant Q_PROJ
  participant PROJ
  participant RDB
  participant READ

  API->>WDB: persist command
  API-)BUS: OrderChanged
  BUS-)Q_PROJ: OrderChanged
  Q_PROJ-)PROJ: OrderChanged
  PROJ->>RDB: upsert read model
  READ->>RDB: query
`,
  },
  saga: {
    elements: [
      { id: "ORDER", name: "Order Svc", type: "service", hasOutbox: true, idempotent: true, dataStores: ["ODB"] },
      { id: "ODB", name: "Order DB", type: "database" },
      { id: "BUS", name: "Saga Bus", type: "topic", topicKind: "topic", bindings: [
        { queueId: "Q_PAY", routingKey: "order.*" },
        { queueId: "Q_INV", routingKey: "order.*" },
      ] },
      { id: "Q_PAY", name: "Payment Q", type: "queue", hasInbox: true },
      { id: "Q_INV", name: "Inventory Q", type: "queue", hasInbox: true },
      { id: "PAY", name: "Payment Svc", type: "service", idempotent: true },
      { id: "INV", name: "Inventory Svc", type: "service", idempotent: true },
    ],
    seq: `sequenceDiagram
  autonumber
  participant ORDER
  participant ODB
  participant BUS
  participant Q_PAY
  participant PAY
  participant Q_INV
  participant INV

  ORDER->>ODB: create order pending
  ORDER-)BUS: order.created
  BUS-)Q_PAY: order.created
  BUS-)Q_INV: order.created
  Q_PAY-)PAY: order.created
  Q_INV-)INV: order.created
  PAY-)BUS: order.paid
  INV-)BUS: order.reserved
`,
  },
  fanout: {
    elements: [
      { id: "API", name: "Publisher", type: "service" },
      { id: "BUS", name: "Notify Topic", type: "topic", topicKind: "fanout", bindings: [
        { queueId: "Q_PUSH" }, { queueId: "Q_MAIL" }, { queueId: "Q_SMS" },
      ] },
      { id: "Q_PUSH", name: "Push Queue", type: "queue", hasInbox: true },
      { id: "Q_MAIL", name: "Mail Queue", type: "queue", hasInbox: true },
      { id: "Q_SMS", name: "SMS Queue", type: "queue", hasInbox: true },
      { id: "PUSH", name: "Push Worker", type: "service", idempotent: true },
      { id: "MAIL", name: "Mail Worker", type: "service", idempotent: true },
      { id: "SMS", name: "SMS Worker", type: "service", idempotent: true },
    ],
    seq: `sequenceDiagram
  autonumber
  participant API
  participant BUS
  participant Q_PUSH
  participant Q_MAIL
  participant Q_SMS
  participant PUSH
  participant MAIL
  participant SMS

  API-)BUS: UserSignedUp
  BUS-)Q_PUSH: UserSignedUp
  BUS-)Q_MAIL: UserSignedUp
  BUS-)Q_SMS: UserSignedUp
  Q_PUSH-)PUSH: deliver
  Q_MAIL-)MAIL: deliver
  Q_SMS-)SMS: deliver
`,
  },
  snsSqs: {
    elements: [
      { id: "API", name: "Orders API", type: "service", hasOutbox: true, idempotent: true, dataStores: ["DB"] },
      { id: "DB", name: "Orders DB", type: "database" },
      { id: "SNS", name: "orders-topic", type: "topic", topicKind: "fanout", broker: "sns",
        bindings: [{ queueId: "Q_MAIL", filter: "eventType=OrderPlaced" }, { queueId: "Q_ANALYTICS" }] },
      { id: "Q_MAIL", name: "mail-queue", type: "queue", broker: "sqs", hasInbox: true,
        visibilityTimeoutSec: 30, maxReceives: 5, dlqId: "DLQ_MAIL", retentionHours: 96 },
      { id: "DLQ_MAIL", name: "mail-dlq", type: "queue", broker: "sqs", retentionHours: 336 },
      { id: "Q_ANALYTICS", name: "analytics-queue", type: "queue", broker: "sqs", fifo: true,
        hasInbox: true, visibilityTimeoutSec: 60 },
      { id: "MAIL", name: "Email Worker", type: "lambda", idempotent: true, hasInbox: true },
      { id: "ANALY", name: "Analytics Worker", type: "service", idempotent: true, hasInbox: true },
    ],
    seq: `sequenceDiagram
  autonumber
  participant API
  participant DB
  participant SNS
  participant Q_MAIL
  participant Q_ANALYTICS
  participant MAIL
  participant ANALY

  API->>DB: insert order + outbox row
  Note over API: db write committed
  API-)SNS: OrderPlaced
  SNS-)Q_MAIL: OrderPlaced
  SNS-)Q_ANALYTICS: OrderPlaced
  Q_MAIL-)MAIL: deliver
  Q_ANALYTICS-)ANALY: deliver
`,
  },
  kafkaStream: {
    elements: [
      { id: "GW", name: "API Gateway", type: "api-gateway" },
      { id: "API", name: "Ingest Svc", type: "service", hasOutbox: true, dataStores: ["DB"] },
      { id: "DB", name: "Ingest DB", type: "database" },
      { id: "KAFKA", name: "events", type: "topic", topicKind: "pubsub", broker: "kafka",
        partitions: 12, schemaContract: true, bindings: [{ queueId: "CG_PROC" }, { queueId: "CG_AUDIT" }] },
      { id: "CG_PROC", name: "processors-cg", type: "queue", broker: "kafka", consumerGroup: "processors", hasInbox: true },
      { id: "CG_AUDIT", name: "audit-cg", type: "queue", broker: "kafka", consumerGroup: "audit", hasInbox: true },
      { id: "STREAM", name: "Enrichment Stream", type: "stream", idempotent: true },
      { id: "AUDIT", name: "Audit Sink", type: "service", idempotent: true, dataStores: ["WAREHOUSE"] },
      { id: "WAREHOUSE", name: "Data Warehouse", type: "database" },
    ],
    seq: `sequenceDiagram
  autonumber
  participant GW
  participant API
  participant DB
  participant KAFKA
  participant CG_PROC
  participant STREAM
  participant CG_AUDIT
  participant AUDIT

  GW->>API: POST /events
  API->>DB: persist
  Note over API: db write committed
  API-)KAFKA: event.raw
  KAFKA-)CG_PROC: event.raw
  CG_PROC-)STREAM: process
  STREAM-)KAFKA: event.enriched
  KAFKA-)CG_AUDIT: event.enriched
  CG_AUDIT-)AUDIT: persist
`,
  },
  sagaOrchestrator: {
    elements: [
      { id: "API", name: "Checkout API", type: "service" },
      { id: "SAGA", name: "Checkout Saga", type: "saga", idempotent: true, dataStores: ["SDB"] },
      { id: "SDB", name: "Saga State", type: "database" },
      { id: "BUS", name: "commands", type: "topic", topicKind: "direct", broker: "rabbitmq",
        bindings: [
          { queueId: "Q_PAY", routingKey: "payment" },
          { queueId: "Q_INV", routingKey: "inventory" },
          { queueId: "Q_SHIP", routingKey: "shipping" },
        ] },
      { id: "Q_PAY", name: "payment.cmd", type: "queue", broker: "rabbitmq", hasInbox: true },
      { id: "Q_INV", name: "inventory.cmd", type: "queue", broker: "rabbitmq", hasInbox: true },
      { id: "Q_SHIP", name: "shipping.cmd", type: "queue", broker: "rabbitmq", hasInbox: true },
      { id: "PAY", name: "Payment Svc", type: "service", idempotent: true },
      { id: "INV", name: "Inventory Svc", type: "service", idempotent: true },
      { id: "SHIP", name: "Shipping Svc", type: "service", idempotent: true },
    ],
    seq: `sequenceDiagram
  autonumber
  participant API
  participant SAGA
  participant BUS
  participant Q_PAY
  participant PAY
  participant Q_INV
  participant INV
  participant Q_SHIP
  participant SHIP

  API->>SAGA: start checkout
  SAGA-)BUS: payment.charge
  BUS-)Q_PAY: payment.charge
  Q_PAY-)PAY: charge
  PAY-)SAGA: payment.ok
  SAGA-)BUS: inventory.reserve
  BUS-)Q_INV: inventory.reserve
  Q_INV-)INV: reserve
  INV-)SAGA: inventory.ok
  SAGA-)BUS: shipping.dispatch
  BUS-)Q_SHIP: shipping.dispatch
  Q_SHIP-)SHIP: dispatch
`,
  },
};

function uid() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function ForgePage() {
  const [elements, setElements] = useState<ArchElement[]>(DEFAULT_ELEMENTS);
  const [seqCode, setSeqCode] = useState(DEFAULT_SEQ);
  const [faults, setFaults] = useState<Fault[]>([]);
  const [currentStep, setCurrentStep] = useState<number | null>(null);
  const [canvasState, setCanvasState] = useState<CanvasState>({ positions: {}, edges: [] });

  const parsed = useMemo(() => parseSequence(seqCode), [seqCode]);
  const result = useMemo(
    () => simulate({ elements, steps: parsed.steps, faults }),
    [elements, parsed.steps, faults],
  );

  const activeEdgeKeys = useMemo(() => {
    const set = new Set<string>();
    if (currentStep == null) return set;
    const s = parsed.steps[currentStep];
    if (s?.from && s?.to) set.add(`${s.from}->${s.to}`);
    return set;
  }, [currentStep, parsed.steps]);

  // Auto-generated edges from element configuration:
  //  - topic bindings -> visual edge per exchange kind
  //  - service.dataStores -> "owns" edge to each db/cache
  const managedEdges = useMemo<ManagedEdge[]>(() => {
    const out: ManagedEdge[] = [];
    const elementIds = new Set(elements.map((e) => e.id));
    for (const el of elements) {
      if (el.type === "topic" && el.bindings?.length) {
        const kindMap: Record<TopicKind, EdgeKind> = {
          fanout: "fanout",
          direct: "direct",
          topic: "topic-route",
          headers: "headers",
          pubsub: "pubsub",
        };
        const tKind = el.topicKind ?? "fanout";
        for (const b of el.bindings) {
          if (!b.queueId || !elementIds.has(b.queueId)) continue;
          const label =
            tKind === "fanout"
              ? "fanout"
              : tKind === "pubsub"
                ? "pub/sub"
                : tKind === "headers"
                  ? `hdr:${b.routingKey ?? ""}`
                  : b.routingKey || tKind;
          out.push({
            id: `mng:bind:${el.id}->${b.queueId}:${b.routingKey ?? ""}`,
            source: el.id,
            target: b.queueId,
            kind: kindMap[tKind],
            label,
          });
        }
      }
      if (el.type === "service" && el.dataStores?.length) {
        for (const dsId of el.dataStores) {
          if (!elementIds.has(dsId)) continue;
          out.push({
            id: `mng:owns:${el.id}->${dsId}`,
            source: el.id,
            target: dsId,
            kind: "owns",
            label: "owns",
          });
        }
      }
      if (el.type === "queue" && el.dlqId && elementIds.has(el.dlqId)) {
        out.push({
          id: `mng:dlq:${el.id}->${el.dlqId}`,
          source: el.id,
          target: el.dlqId,
          kind: "dlq",
          label: `DLQ${el.maxReceives ? ` · max ${el.maxReceives}` : ""}`,
        });
      }
    }
    return out;
  }, [elements]);



  function addElement(type: ElementType) {
    const id = uid();
    const extra: Partial<ArchElement> =
      type === "topic" ? { topicKind: "fanout", bindings: [] } : {};
    setElements((es) => [
      ...es,
      { id, name: `${TYPE_META[type].label} ${id}`, type, hasInbox: false, hasOutbox: false, idempotent: false, ...extra },
    ]);
  }
  function patchEl(id: string, patch: Partial<ArchElement>) {
    setElements((es) => es.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }
  function removeEl(id: string) {
    setElements((es) => es.filter((e) => e.id !== id));
  }

  function toggleFault(stepIndex: number, kind: Fault["kind"]) {
    setFaults((fs) => {
      const idx = fs.findIndex((f) => f.stepIndex === stepIndex && f.kind === kind);
      if (idx >= 0) return fs.filter((_, i) => i !== idx);
      return [...fs, { stepIndex, kind }];
    });
  }

  function hasFault(stepIndex: number, kind: Fault["kind"]) {
    return faults.some((f) => f.stepIndex === stepIndex && f.kind === kind);
  }

  return (
    <div className="min-h-screen text-foreground">
      <header className="border-b border-border bg-surface/60 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-[1600px] px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-md grid place-items-center border border-primary/40 bg-primary/10 text-primary font-mono text-lg">
              ⌬
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight">Forge</h1>
              <p className="text-xs text-muted-foreground -mt-0.5">
                Architecture design tester · Mermaid sequence simulator
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const { elements: imported, edges: importedEdges } = importFromMermaid(seqCode, elements);
                setElements(imported);
                setCanvasState((s) => {
                  // merge: keep existing user edges, add any new ones from import
                  const existingKeys = new Set(s.edges.map((e) => `${e.source}->${e.target}:${e.kind}`));
                  const additions = importedEdges
                    .filter((e) => !existingKeys.has(`${e.source}->${e.target}:${e.kind}`))
                    .map((e) => ({ id: e.id, source: e.source, target: e.target, kind: e.kind as EdgeKind }));
                  return { positions: s.positions, edges: [...s.edges, ...additions] };
                });
              }}
              className="text-xs px-2 py-1 rounded-md border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
              title="Parse the sequence diagram and create matching components + connections"
            >
              ⇪ Import from Mermaid
            </button>
            <select
              className="bg-surface-2 border border-border rounded-md px-2 py-1 text-xs"
              value=""
              onChange={(e) => {
                const t = e.target.value as keyof typeof TEMPLATES;
                if (t && TEMPLATES[t]) {
                  setElements(TEMPLATES[t].elements);
                  setSeqCode(TEMPLATES[t].seq);
                  setCanvasState({ positions: {}, edges: [] });
                  setFaults([]);
                }
                e.currentTarget.value = "";
              }}
              title="Load architecture pattern template"
            >
              <option value="">⌬ Templates…</option>
              <option value="outbox">Transactional Outbox</option>
              <option value="cqrs">CQRS + Read Model</option>
              <option value="saga">Choreography Saga</option>
              <option value="fanout">Fan-out Notifications</option>
              <option value="snsSqs">SNS → SQS (fanout + DLQ)</option>
              <option value="kafkaStream">Kafka Stream Processing</option>
              <option value="sagaOrchestrator">Saga Orchestrator</option>
            </select>
            <Pill tone="info">{parsed.steps.length} steps</Pill>
            <Pill tone={result.summary.errors ? "error" : "success"}>
              {result.summary.errors} errors
            </Pill>
            <Pill tone={result.summary.warnings ? "warning" : "muted"}>
              {result.summary.warnings} warnings
            </Pill>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-6 py-6 grid grid-cols-12 gap-6">
        {/* Left: components */}
        <section className="col-span-12 lg:col-span-3 space-y-4">
          <Panel
            title="Components"
            action={
              <select
                className="bg-surface-2 border border-border rounded-md px-2 py-1 text-xs"
                value=""
                onChange={(e) => {
                  if (e.target.value) addElement(e.target.value as ElementType);
                  e.currentTarget.value = "";
                }}
              >
                <option value="">+ Add…</option>
                {Object.entries(TYPE_META).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
            }
          >
            <div className="space-y-2">
              {elements.map((el) => (
                <ElementCard
                  key={el.id}
                  el={el}
                  queues={elements.filter((e) => e.type === "queue")}
                  databases={elements.filter((e) => e.type === "database" || e.type === "cache")}
                  onChange={(p) => patchEl(el.id, p)}
                  onRemove={() => removeEl(el.id)}
                />
              ))}
              {elements.length === 0 && (
                <p className="text-xs text-muted-foreground p-3">No components yet.</p>
              )}
            </div>
          </Panel>

          <Panel title="Legend">
            <ul className="text-xs space-y-1.5 text-muted-foreground">
              <li>
                <code className="text-primary">A-&gt;&gt;B</code> synchronous call
              </li>
              <li>
                <code className="text-warning">A-)B</code> asynchronous message
              </li>
              <li>
                <code className="text-info">A--&gt;&gt;B</code> response
              </li>
              <li>
                <code className="text-accent">Note over A: db write</code> persists state
              </li>
            </ul>
          </Panel>
        </section>

        {/* Center: architecture canvas + sequence */}
        <section className="col-span-12 lg:col-span-6 space-y-4">
          <Panel
            title="Architecture canvas"
            action={
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                drag to add · drag handles to connect · click line to change type
              </span>
            }
          >
            <DragPalette onAdd={(t) => addElement(t)} />
            <ArchCanvas
              elements={elements}
              state={canvasState}
              onStateChange={setCanvasState}
              activeEdgeKeys={activeEdgeKeys}
              managedEdges={managedEdges}
              onDropType={(type) => addElement(type)}
            />
          </Panel>



          <Panel
            title="Sequence diagram"
            action={<span className="text-[10px] uppercase tracking-wider text-muted-foreground">mermaid</span>}
          >
            <textarea
              className="mono w-full bg-surface-2 text-foreground text-[12.5px] leading-relaxed p-3 outline-none resize-y min-h-[260px] rounded-b-lg border-t border-border"
              value={seqCode}
              spellCheck={false}
              onChange={(e) => setSeqCode(e.target.value)}
            />
          </Panel>

          <Panel title="Rendered sequence">
            <div className="p-3">
              <MermaidView code={seqCode} />
            </div>
          </Panel>
        </section>

        {/* Right: simulator */}
        <section className="col-span-12 lg:col-span-3 space-y-4">
          <Panel
            title="Simulator"
            action={
              <button
                onClick={() => setFaults([])}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                clear faults
              </button>
            }
          >
            <ol className="divide-y divide-border max-h-[420px] overflow-auto">
              {parsed.steps.map((s) => (
                <li
                  key={s.index}
                  className={`px-3 py-2 text-xs cursor-pointer transition-colors ${
                    currentStep === s.index ? "bg-primary/10" : "hover:bg-surface-2"
                  }`}
                  onMouseEnter={() => setCurrentStep(s.index)}
                  onMouseLeave={() => setCurrentStep(null)}
                >
                  <div className="flex items-start gap-2">
                    <span className="text-muted-foreground mono w-6">{s.index + 1}.</span>
                    <div className="flex-1 min-w-0">
                      <div className="mono truncate" title={s.raw}>
                        {s.raw}
                      </div>
                      {s.kind !== "note" && (
                        <div className="mt-1 flex gap-1 flex-wrap">
                          <FaultBtn active={hasFault(s.index, "drop")} onClick={() => toggleFault(s.index, "drop")}>
                            drop
                          </FaultBtn>
                          <FaultBtn
                            active={hasFault(s.index, "duplicate")}
                            onClick={() => toggleFault(s.index, "duplicate")}
                          >
                            duplicate
                          </FaultBtn>
                          <FaultBtn
                            active={hasFault(s.index, "reorder")}
                            onClick={() => toggleFault(s.index, "reorder")}
                          >
                            reorder
                          </FaultBtn>
                        </div>
                      )}
                    </div>
                    <KindBadge kind={s.kind} />
                  </div>
                </li>
              ))}
              {parsed.steps.length === 0 && (
                <li className="p-4 text-xs text-muted-foreground">No steps parsed yet.</li>
              )}
            </ol>
          </Panel>

          <Panel title={`Findings · ${result.events.length}`}>
            <ul className="divide-y divide-border max-h-[420px] overflow-auto">
              {result.events.map((ev, i) => (
                <li
                  key={i}
                  className={`px-3 py-2 text-xs ${
                    currentStep === ev.stepIndex ? "bg-surface-2" : ""
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <SeverityDot s={ev.severity} />
                    <div>
                      <div className="font-medium">{ev.message}</div>
                      {ev.detail && <div className="text-muted-foreground mt-0.5">{ev.detail}</div>}
                      <div className="text-[10px] text-muted-foreground mt-1 mono">
                        step {ev.stepIndex + 1}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
              {result.events.length === 0 && (
                <li className="p-4 text-xs text-muted-foreground">
                  No issues detected. Try injecting a duplicate or drop.
                </li>
              )}
            </ul>
          </Panel>
        </section>
      </main>
    </div>
  );
}

function DragPalette({ onAdd }: { onAdd: (t: ElementType) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 px-3 py-2 border-b border-border bg-surface-2/30">
      {(Object.keys(TYPE_META) as ElementType[]).map((t) => {
        const m = TYPE_META[t];
        return (
          <button
            key={t}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("application/arch-type", t);
              e.dataTransfer.effectAllowed = "move";
            }}
            onClick={() => onAdd(t)}
            className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border border-border bg-surface hover:border-primary/60 hover:text-primary cursor-grab active:cursor-grabbing"
            title={`Drag onto canvas or click to add ${m.label}`}
          >
            <span className="mono" style={{ color: m.color }}>{m.glyph}</span>
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

function Panel({
  title,

  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface-2/40">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </div>
  );
}

function Pill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "info" | "success" | "warning" | "error" | "muted";
}) {
  const map: Record<string, string> = {
    info: "border-info/40 text-info bg-info/10",
    success: "border-success/40 text-success bg-success/10",
    warning: "border-warning/40 text-warning bg-warning/10",
    error: "border-destructive/40 text-destructive bg-destructive/10",
    muted: "border-border text-muted-foreground bg-surface",
  };
  return (
    <span
      className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded-full border ${map[tone]}`}
    >
      {children}
    </span>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const map: Record<string, string> = {
    sync: "text-primary border-primary/40 bg-primary/10",
    async: "text-warning border-warning/40 bg-warning/10",
    response: "text-info border-info/40 bg-info/10",
    note: "text-accent border-accent/40 bg-accent/10",
  };
  return (
    <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${map[kind]}`}>
      {kind}
    </span>
  );
}

function SeverityDot({ s }: { s: Severity }) {
  const map: Record<Severity, string> = {
    error: "bg-destructive",
    warning: "bg-warning",
    info: "bg-info",
    success: "bg-success",
  };
  return <span className={`inline-block w-2 h-2 rounded-full mt-1 shrink-0 ${map[s]}`} />;
}

function FaultBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border transition-colors ${
        active
          ? "bg-destructive/20 border-destructive/60 text-destructive"
          : "border-border text-muted-foreground hover:text-foreground hover:bg-surface-2"
      }`}
    >
      {children}
    </button>
  );
}

function ElementCard({
  el,
  queues,
  databases,
  onChange,
  onRemove,
}: {
  el: ArchElement;
  queues: ArchElement[];
  databases: ArchElement[];
  onChange: (p: Partial<ArchElement>) => void;
  onRemove: () => void;
}) {
  const meta = TYPE_META[el.type];
  const bindings = el.bindings ?? [];
  function setBinding(i: number, patch: Partial<TopicBinding>) {
    const next = bindings.map((b, idx) => (idx === i ? { ...b, ...patch } : b));
    onChange({ bindings: next });
  }
  function addBinding() {
    const firstQueue = queues[0]?.id ?? "";
    onChange({ bindings: [...bindings, { queueId: firstQueue, routingKey: "" }] });
  }
  function removeBinding(i: number) {
    onChange({ bindings: bindings.filter((_, idx) => idx !== i) });
  }
  return (
    <div className="rounded-md border border-border bg-surface-2/60 p-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <span
          className="w-7 h-7 grid place-items-center rounded border border-border font-mono text-sm"
          style={{ color: meta.color }}
        >
          {meta.glyph}
        </span>
        <input
          value={el.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="flex-1 bg-transparent text-sm font-medium outline-none min-w-0"
        />
        <button
          onClick={onRemove}
          className="text-muted-foreground hover:text-destructive text-xs px-1"
          aria-label="remove"
        >
          ✕
        </button>
      </div>
      <div className="flex items-center gap-2">
        <input
          value={el.id}
          onChange={(e) => onChange({ id: e.target.value.replace(/\s+/g, "_").toUpperCase() })}
          className="mono text-[11px] bg-surface border border-border rounded px-1.5 py-0.5 w-20 outline-none"
        />
        <select
          value={el.type}
          onChange={(e) => onChange({ type: e.target.value as ElementType })}
          className="text-[11px] bg-surface border border-border rounded px-1.5 py-0.5 flex-1 outline-none"
        >
          {Object.entries(TYPE_META).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      </div>
      {(el.type === "service" || el.type === "queue") && (
        <div className="flex flex-wrap gap-1.5">
          <Toggle on={!!el.idempotent} onChange={(v) => onChange({ idempotent: v })}>
            idempotent
          </Toggle>
          <Toggle on={!!el.hasOutbox} onChange={(v) => onChange({ hasOutbox: v })}>
            outbox
          </Toggle>
          <Toggle on={!!el.hasInbox} onChange={(v) => onChange({ hasInbox: v })}>
            inbox
          </Toggle>
        </div>
      )}
      {(el.type === "queue" || el.type === "topic") && (
        <div className="space-y-1.5 pt-1 border-t border-border/60">
          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground w-14">
              broker
            </label>
            <select
              value={el.broker ?? "generic"}
              onChange={(e) => onChange({ broker: e.target.value as BrokerKind })}
              className="text-[11px] bg-surface border border-border rounded px-1.5 py-0.5 flex-1 outline-none"
            >
              {(["generic", "rabbitmq", "sqs", "sns", "kafka", "eventbridge", "redis-streams", "gcp-pubsub"] as BrokerKind[]).map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          {el.type === "queue" && (
            <div className="grid grid-cols-2 gap-1">
              {(el.broker === "sqs" || el.broker === "rabbitmq") && (
                <Toggle on={!!el.fifo} onChange={(v) => onChange({ fifo: v })}>fifo</Toggle>
              )}
              {el.broker === "kafka" && (
                <NumField label="parts" value={el.partitions} onChange={(v) => onChange({ partitions: v })} />
              )}
              {(el.broker === "kafka" || el.broker === "gcp-pubsub") && (
                <TextField label="group" value={el.consumerGroup} onChange={(v) => onChange({ consumerGroup: v })} />
              )}
              {(el.broker === "sqs" || el.broker === "rabbitmq") && (
                <NumField label="vis(s)" value={el.visibilityTimeoutSec} onChange={(v) => onChange({ visibilityTimeoutSec: v })} />
              )}
              {el.broker === "sqs" && (
                <NumField label="maxRx" value={el.maxReceives} onChange={(v) => onChange({ maxReceives: v })} />
              )}
              <NumField label="ret(h)" value={el.retentionHours} onChange={(v) => onChange({ retentionHours: v })} />
              <div className="col-span-2 flex items-center gap-1">
                <label className="text-[9px] uppercase tracking-wider text-muted-foreground w-10">dlq</label>
                <select
                  value={el.dlqId ?? ""}
                  onChange={(e) => onChange({ dlqId: e.target.value || undefined })}
                  className="mono text-[10px] bg-surface border border-border rounded px-1 py-0.5 outline-none flex-1"
                >
                  <option value="">— none —</option>
                  {queues.filter((q) => q.id !== el.id).map((q) => (
                    <option key={q.id} value={q.id}>{q.id} · {q.name}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
          {el.type === "topic" && (
            <div className="grid grid-cols-2 gap-1">
              {el.broker === "kafka" && (
                <>
                  <NumField label="parts" value={el.partitions} onChange={(v) => onChange({ partitions: v })} />
                  <Toggle on={!!el.schemaContract} onChange={(v) => onChange({ schemaContract: v })}>schema</Toggle>
                </>
              )}
              {(el.broker === "sns" || el.broker === "eventbridge") && (
                <div className="col-span-2">
                  <TextField label="filter" value={el.filterPolicy} onChange={(v) => onChange({ filterPolicy: v })} />
                </div>
              )}
              <NumField label="ret(h)" value={el.retentionHours} onChange={(v) => onChange({ retentionHours: v })} />
            </div>
          )}
        </div>
      )}
      {el.type === "topic" && (
        <div className="space-y-2 pt-1 border-t border-border/60">
          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              exchange
            </label>
            <select
              value={el.topicKind ?? "fanout"}
              onChange={(e) => onChange({ topicKind: e.target.value as TopicKind })}
              className="text-[11px] bg-surface border border-border rounded px-1.5 py-0.5 flex-1 outline-none"
            >
              {(["fanout", "direct", "topic", "headers", "pubsub"] as TopicKind[]).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                bindings ({bindings.length})
              </span>
              <button
                onClick={addBinding}
                disabled={queues.length === 0}
                className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-primary hover:border-primary/60 disabled:opacity-40"
              >
                + bind queue
              </button>
            </div>
            {queues.length === 0 && bindings.length === 0 && (
              <p className="text-[10px] text-muted-foreground italic">
                add a queue component first to bind it here.
              </p>
            )}
            {bindings.map((b, i) => (
              <div key={i} className="flex items-center gap-1">
                <select
                  value={b.queueId}
                  onChange={(e) => setBinding(i, { queueId: e.target.value })}
                  className="mono text-[10px] bg-surface border border-border rounded px-1 py-0.5 outline-none flex-1 min-w-0"
                >
                  {queues.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.id} · {q.name}
                    </option>
                  ))}
                </select>
                {(el.topicKind === "direct" ||
                  el.topicKind === "topic" ||
                  el.topicKind === "headers" ||
                  el.topicKind == null) && (
                  <input
                    value={b.routingKey ?? ""}
                    onChange={(e) => setBinding(i, { routingKey: e.target.value })}
                    placeholder={el.topicKind === "topic" ? "order.*" : "key"}
                    className="mono text-[10px] bg-surface border border-border rounded px-1 py-0.5 outline-none w-24"
                  />
                )}
                <button
                  onClick={() => removeBinding(i)}
                  className="text-muted-foreground hover:text-destructive text-[10px] px-1"
                  aria-label="remove binding"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {el.type === "service" && (
        <div className="space-y-1 pt-1 border-t border-border/60">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              data stores ({el.dataStores?.length ?? 0})
            </span>
            <button
              onClick={() => {
                const first = databases.find((d) => !el.dataStores?.includes(d.id));
                if (!first) return;
                onChange({ dataStores: [...(el.dataStores ?? []), first.id] });
              }}
              disabled={databases.length === 0 || (el.dataStores?.length ?? 0) >= databases.length}
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-info hover:border-info/60 disabled:opacity-40"
            >
              + bind store
            </button>
          </div>
          {databases.length === 0 && (
            <p className="text-[10px] text-muted-foreground italic">
              add a database or cache to bind it.
            </p>
          )}
          {(el.dataStores ?? []).map((dsId, i) => (
            <div key={`${dsId}-${i}`} className="flex items-center gap-1">
              <select
                value={dsId}
                onChange={(e) => {
                  const next = [...(el.dataStores ?? [])];
                  next[i] = e.target.value;
                  onChange({ dataStores: next });
                }}
                className="mono text-[10px] bg-surface border border-border rounded px-1 py-0.5 outline-none flex-1 min-w-0"
              >
                {databases.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.id} · {d.name} ({d.type})
                  </option>
                ))}
              </select>
              <button
                onClick={() =>
                  onChange({ dataStores: (el.dataStores ?? []).filter((_, idx) => idx !== i) })
                }
                className="text-muted-foreground hover:text-destructive text-[10px] px-1"
                aria-label="unbind"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value?: number; onChange: (v: number | undefined) => void }) {
  return (
    <label className="flex items-center gap-1">
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground w-10">{label}</span>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        className="mono text-[10px] bg-surface border border-border rounded px-1 py-0.5 outline-none w-full min-w-0"
      />
    </label>
  );
}

function TextField({ label, value, onChange }: { label: string; value?: string; onChange: (v: string | undefined) => void }) {
  return (
    <label className="flex items-center gap-1">
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground w-10">{label}</span>
      <input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="mono text-[10px] bg-surface border border-border rounded px-1 py-0.5 outline-none w-full min-w-0"
      />
    </label>
  );
}

function Toggle({
  on,
  onChange,
  children,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border transition-colors ${
        on
          ? "bg-primary/15 border-primary/50 text-primary"
          : "border-border text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function buildArchDiagram(
  elements: ArchElement[],
  steps: { from?: string; to?: string; kind: string }[],
) {
  const lines: string[] = ["flowchart LR"];
  const shape: Record<ElementType, (id: string, label: string) => string> = {
    service: (id, l) => `${id}(["${l}"])`,
    database: (id, l) => `${id}[("${l}")]`,
    queue: (id, l) => `${id}[/"${l}"/]`,
    topic: (id, l) => `${id}{{"${l}"}}`,
    cache: (id, l) => `${id}[\\"${l}"\\]`,
    external: (id, l) => `${id}(("${l}"))`,
    "api-gateway": (id, l) => `${id}>"${l}"]`,
    lambda: (id, l) => `${id}(["${l}"])`,
    scheduler: (id, l) => `${id}{{"${l}"}}`,
    stream: (id, l) => `${id}[/"${l}"\\]`,
    saga: (id, l) => `${id}(["${l}"])`,
  };
  for (const e of elements) {
    const tags = [
      e.hasOutbox ? "outbox" : null,
      e.hasInbox ? "inbox" : null,
      e.idempotent ? "idem" : null,
    ]
      .filter(Boolean)
      .join("·");
    const label = tags ? `${e.name}\\n[${tags}]` : e.name;
    lines.push("  " + shape[e.type](e.id, label));
  }
  const seen = new Set<string>();
  for (const s of steps) {
    if (!s.from || !s.to) continue;
    const key = `${s.from}|${s.to}|${s.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const arrow = s.kind === "async" ? "-.->|async|" : s.kind === "response" ? "-.->" : "-->";
    lines.push(`  ${s.from} ${arrow} ${s.to}`);
  }
  return lines.join("\n");
}
