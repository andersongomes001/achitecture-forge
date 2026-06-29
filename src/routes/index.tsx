import { useEffect, useMemo, useRef, useState } from "react";
import { ArchCanvas, type CanvasState, type ManagedEdge, type EdgeKind, TYPE_GLYPH, EDGE_STYLE, EDGE_LEGEND } from "@/components/arch/ArchCanvas";
import { Inspector } from "@/components/arch/Inspector";
import { parseSequence } from "@/lib/arch/parser";
import { importFromMermaid } from "@/lib/arch/import";
import { generateMermaid } from "@/lib/arch/generate";
import { computeLoad, fmtRate, type LoadRow, type LoadResult, type LoadStatus } from "@/lib/arch/load";
import { simulate } from "@/lib/arch/simulator";
import {
  addDlqFor,
  addRetryFor,
  convertStepToAsync,
  patchElement,
  setInbox,
  setOutbox,
  syncDbReplicas,
} from "@/lib/arch/helpers";
import type {
  ArchElement,
  Contract,
  ElementType,
  Fault,
  RemediationAction,
  Severity,
  TopicKind,
} from "@/lib/arch/types";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Forge — Architecture Design Tester" },
      {
        name: "description",
        content:
          "Miro-style canvas for designing distributed systems and simulating sequence diagrams. Catch idempotency, outbox/inbox, dual-write and ordering bugs before they ship.",
      },
      { property: "og:title", content: "Forge — Architecture Design Tester" },
      {
        property: "og:description",
        content:
          "Drop services, queues, brokers and databases on a Miro-style board. Configure SQS/Kafka/RabbitMQ realism. Run the simulator with fault injection and one-click remediation.",
      },
    ],
  }),
  component: ForgePage,
});

const DEFAULT_ELEMENTS: ArchElement[] = [
  { id: "API", name: "Orders API", type: "service" },
  { id: "DB", name: "Orders DB", type: "database", dbEngine: "postgres" },
  { id: "BUS", name: "Events Bus", type: "topic", topicKind: "fanout", broker: "generic" },
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
      { id: "API", name: "Orders API", type: "service", hasOutbox: true, idempotent: true, dataStores: ["DB"], outboxRelayId: "RELAY", outboxTargetId: "BUS" },
      { id: "DB", name: "Orders DB", type: "database", dbEngine: "postgres" },
      { id: "RELAY", name: "Outbox Relay", type: "relay", idempotent: true, isRelayFor: "API" },
      { id: "BUS", name: "Events Bus", type: "topic", topicKind: "fanout", broker: "rabbitmq", bindings: [{ queueId: "Q_MAIL" }] },
      { id: "Q_MAIL", name: "Mail Queue", type: "queue", broker: "rabbitmq", hasInbox: true },
      { id: "MAIL", name: "Email Worker", type: "service", hasInbox: true, idempotent: true, inboxSourceId: "Q_MAIL", inboxStoreId: "MAIL_INBOX" },
      { id: "MAIL_INBOX", name: "Email Worker · Inbox", type: "inbox-store", isInboxFor: "MAIL" },
    ],
    seq: `sequenceDiagram
  autonumber
  API->>DB: insert order + outbox row
  Note over API: db write committed
  RELAY->>DB: poll outbox
  RELAY-)BUS: OrderPlaced
  BUS-)Q_MAIL: OrderPlaced
  Q_MAIL-)MAIL: OrderPlaced
  MAIL->>MAIL: send email
`,
  },
  snsSqs: {
    elements: [
      { id: "API", name: "Orders API", type: "service", hasOutbox: true, idempotent: true, dataStores: ["DB"], outboxRelayId: "RELAY", outboxTargetId: "SNS" },
      { id: "DB", name: "Orders DB", type: "database", dbEngine: "postgres", dbReplicas: 2 },
      { id: "RELAY", name: "Outbox Relay", type: "relay", isRelayFor: "API" },
      { id: "SNS", name: "orders-topic", type: "topic", topicKind: "fanout", broker: "sns",
        bindings: [{ queueId: "Q_MAIL", filter: "eventType=OrderPlaced" }, { queueId: "Q_ANALYTICS" }] },
      { id: "Q_MAIL", name: "mail-queue", type: "queue", broker: "sqs", hasInbox: true,
        visibilityTimeoutSec: 30, maxReceives: 5, dlqId: "Q_MAIL_DLQ", retentionHours: 96 },
      { id: "Q_MAIL_DLQ", name: "mail-dlq", type: "queue", broker: "sqs", retentionHours: 336, isDlqFor: "Q_MAIL" },
      { id: "Q_ANALYTICS", name: "analytics-queue", type: "queue", broker: "sqs", fifo: true, hasInbox: true, visibilityTimeoutSec: 60 },
      { id: "MAIL", name: "Email Worker", type: "lambda", idempotent: true, hasInbox: true },
      { id: "ANALY", name: "Analytics Worker", type: "service", idempotent: true, hasInbox: true, circuitBreaker: true },
    ],
    seq: `sequenceDiagram
  autonumber
  API->>DB: insert order + outbox row
  Note over API: db write committed
  RELAY-)SNS: OrderPlaced
  SNS-)Q_MAIL: OrderPlaced
  SNS-)Q_ANALYTICS: OrderPlaced
  Q_MAIL-)MAIL: deliver
  Q_ANALYTICS-)ANALY: deliver
`,
  },
  kafkaStream: {
    elements: [
      { id: "GW", name: "API Gateway", type: "api-gateway" },
      { id: "API", name: "Ingest Svc", type: "service", hasOutbox: true, dataStores: ["DB"], outboxRelayId: "RELAY", outboxTargetId: "KAFKA", circuitBreaker: true },
      { id: "DB", name: "Ingest DB", type: "database", dbEngine: "postgres", dbReplicas: 1 },
      { id: "RELAY", name: "Outbox Relay", type: "relay", isRelayFor: "API" },
      { id: "KAFKA", name: "events", type: "topic", topicKind: "pubsub", broker: "kafka",
        partitions: 12, replicationFactor: 3, schemaContract: true,
        bindings: [{ queueId: "CG_PROC" }, { queueId: "CG_AUDIT" }] },
      { id: "CG_PROC", name: "processors-cg", type: "queue", broker: "kafka", consumerGroup: "processors", hasInbox: true },
      { id: "CG_AUDIT", name: "audit-cg", type: "queue", broker: "kafka", consumerGroup: "audit", hasInbox: true },
      { id: "STREAM", name: "Enrichment Stream", type: "stream", idempotent: true },
      { id: "AUDIT", name: "Audit Sink", type: "service", idempotent: true, dataStores: ["WAREHOUSE"] },
      { id: "WAREHOUSE", name: "Data Warehouse", type: "database", dbEngine: "clickhouse" },
    ],
    seq: `sequenceDiagram
  autonumber
  GW->>API: POST /events
  API->>DB: persist
  Note over API: db write committed
  RELAY-)KAFKA: event.raw
  KAFKA-)CG_PROC: event.raw
  CG_PROC-)STREAM: process
  STREAM-)KAFKA: event.enriched
  KAFKA-)CG_AUDIT: event.enriched
  CG_AUDIT-)AUDIT: persist
`,
  },
  saga: {
    elements: [
      { id: "API", name: "Checkout API", type: "service" },
      { id: "SAGA", name: "Checkout Saga", type: "saga", idempotent: true, dataStores: ["SDB"] },
      { id: "SDB", name: "Saga State", type: "database", dbEngine: "postgres" },
      { id: "BUS", name: "commands", type: "topic", topicKind: "direct", broker: "rabbitmq",
        bindings: [
          { queueId: "Q_PAY", routingKey: "payment" },
          { queueId: "Q_INV", routingKey: "inventory" },
        ] },
      { id: "Q_PAY", name: "payment.cmd", type: "queue", broker: "rabbitmq", hasInbox: true, rabbitDurable: true, prefetch: 10 },
      { id: "Q_INV", name: "inventory.cmd", type: "queue", broker: "rabbitmq", hasInbox: true, rabbitDurable: true, prefetch: 10 },
      { id: "PAY", name: "Payment Svc", type: "service", idempotent: true, circuitBreaker: true },
      { id: "INV", name: "Inventory Svc", type: "service", idempotent: true },
    ],
    seq: `sequenceDiagram
  autonumber
  API->>SAGA: start checkout
  SAGA-)BUS: payment.charge
  BUS-)Q_PAY: payment.charge
  Q_PAY-)PAY: charge
  PAY-)SAGA: payment.ok
  SAGA-)BUS: inventory.reserve
  BUS-)Q_INV: inventory.reserve
  Q_INV-)INV: reserve
  INV-)SAGA: inventory.ok
`,
  },
};

function uid() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

interface Scenario {
  id: string;
  name: string;
  seq: string;
}

interface BuilderStep {
  from: string;
  to: string;
  kind: "sync" | "async" | "response";
  label: string;
}

function ForgePage() {
  const [elements, setElementsRaw] = useState<ArchElement[]>(DEFAULT_ELEMENTS);
  const [scenarios, setScenarios] = useState<Scenario[]>([
    { id: "s1", name: "Main flow", seq: DEFAULT_SEQ },
  ]);
  const [activeScenario, setActiveScenario] = useState("s1");
  const seqCode = scenarios.find((s) => s.id === activeScenario)?.seq ?? "";
  function setSeqCode(updater: string | ((prev: string) => string)) {
    setScenarios((prev) =>
      prev.map((s) =>
        s.id === activeScenario
          ? { ...s, seq: typeof updater === "function" ? updater(s.seq) : updater }
          : s,
      ),
    );
  }
  const [faults, setFaults] = useState<Fault[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [currentStep, setCurrentStep] = useState<number | null>(null);
  const [canvasState, setCanvasState] = useState<CanvasState>({ positions: {}, edges: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showInspector, setShowInspector] = useState(true);
  const [drawerTab, setDrawerTab] = useState<"sequence" | "findings" | "playback" | "load">("playback");
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [paletteExpanded, setPaletteExpanded] = useState(false);
  const [showLegend, setShowLegend] = useState(true);
  const [showGuide, setShowGuide] = useState(false);

  // playback
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(900); // ms per step
  const playRef = useRef<number | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);

  // canvas step builder (compose a sequence by clicking components)
  const [builderMode, setBuilderMode] = useState(false);
  const [builderSteps, setBuilderSteps] = useState<BuilderStep[]>([]);
  const [builderPending, setBuilderPending] = useState<string | null>(null);

  function setElements(updater: ArchElement[] | ((prev: ArchElement[]) => ArchElement[])) {
    setElementsRaw((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      return syncDbReplicas(next);
    });
  }

  const parsed = useMemo(() => parseSequence(seqCode), [seqCode]);
  const result = useMemo(
    () => simulate({ elements, steps: parsed.steps, faults, contracts }),
    [elements, parsed.steps, faults, contracts],
  );
  const load = useMemo(() => computeLoad(elements), [elements]);


  const activeEdgeKeys = useMemo(() => {
    const set = new Set<string>();
    if (currentStep == null) return set;
    const s = parsed.steps[currentStep];
    if (s?.from && s?.to) set.add(`${s.from}->${s.to}`);
    return set;
  }, [currentStep, parsed.steps]);

  const failedEdgeKeys = useMemo(() => {
    const set = new Set<string>();
    for (const ev of result.events) {
      if (ev.severity !== "error") continue;
      const s = parsed.steps[ev.stepIndex];
      if (s?.from && s?.to) set.add(`${s.from}->${s.to}`);
    }
    return set;
  }, [result.events, parsed.steps]);

  const managedEdges = useMemo<ManagedEdge[]>(() => {
    const out: ManagedEdge[] = [];
    const ids = new Set(elements.map((e) => e.id));
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
          if (!b.queueId || !ids.has(b.queueId)) continue;
          const label =
            tKind === "fanout" ? "fanout"
              : tKind === "pubsub" ? "pub/sub"
              : tKind === "headers" ? `hdr:${b.routingKey ?? ""}`
              : b.routingKey || tKind;
          out.push({ id: `mng:bind:${el.id}->${b.queueId}:${b.routingKey ?? ""}`, source: el.id, target: b.queueId, kind: kindMap[tKind], label });
        }
      }
      if ((el.type === "service" || el.type === "lambda" || el.type === "saga" || el.type === "stream") && el.dataStores?.length) {
        for (const dsId of el.dataStores) {
          if (!ids.has(dsId)) continue;
          out.push({ id: `mng:owns:${el.id}->${dsId}`, source: el.id, target: dsId, kind: "owns", label: "owns" });
        }
      }
      // stateless direct publishers (service publishes straight to a destination, no outbox)
      if ((el.type === "service" || el.type === "lambda" || el.type === "saga" || el.type === "stream") && el.publishesTo?.length) {
        for (const tId of el.publishesTo) {
          if (!ids.has(tId)) continue;
          out.push({ id: `mng:publish:${el.id}->${tId}`, source: el.id, target: tId, kind: "publish", label: "publish" });
        }
      }
      // stateless direct consumers (service consumes straight from a source, no inbox)
      if ((el.type === "service" || el.type === "lambda" || el.type === "saga" || el.type === "stream") && el.consumesFrom?.length) {
        for (const sId of el.consumesFrom) {
          if (!ids.has(sId)) continue;
          out.push({ id: `mng:subscribe:${sId}->${el.id}`, source: sId, target: el.id, kind: "subscribe", label: "consume" });
        }
      }
      if (el.type === "queue" && el.dlqId && ids.has(el.dlqId)) {
        out.push({ id: `mng:dlq:${el.id}->${el.dlqId}`, source: el.id, target: el.dlqId, kind: "dlq",
          label: `DLQ${el.maxReceives ? ` · max ${el.maxReceives}` : ""}` });
      }
      if (el.type === "queue" && el.retryQueueId && ids.has(el.retryQueueId)) {
        out.push({ id: `mng:retry:${el.id}->${el.retryQueueId}`, source: el.id, target: el.retryQueueId, kind: "retry",
          label: `retry${el.retryDelayMs ? ` ${el.retryDelayMs}ms` : ""}` });
      }
      if (el.type === "relay" && el.isRelayFor && ids.has(el.isRelayFor)) {
        const svc = elements.find((e) => e.id === el.isRelayFor);
        // relay reads from the service's first datastore
        const firstDb = svc?.dataStores?.[0];
        if (firstDb && ids.has(firstDb)) {
          out.push({ id: `mng:relayread:${el.id}->${firstDb}`, source: el.id, target: firstDb, kind: "relay-read", label: "poll outbox" });
        }
        // relay publishes to the configured destination(s) (topic / queue / broker)
        const pubTargets = [svc?.outboxTargetId, ...(svc?.outboxTargetIds ?? [])].filter(Boolean) as string[];
        for (const tId of Array.from(new Set(pubTargets))) {
          if (ids.has(tId)) {
            out.push({ id: `mng:relaypub:${el.id}->${tId}`, source: el.id, target: tId, kind: "relay-publish", label: "publish" });
          }
        }
      }
      if (el.type === "inbox-store" && el.isInboxFor && ids.has(el.isInboxFor)) {
        out.push({ id: `mng:inbox:${el.isInboxFor}->${el.id}`, source: el.isInboxFor, target: el.id, kind: "inbox-of", label: "dedup" });
        const svc = elements.find((e) => e.id === el.isInboxFor);
        // messages consumed from the configured source(s) flow into the inbox store
        const consumeSources = [svc?.inboxSourceId, ...(svc?.inboxSourceIds ?? [])].filter(Boolean) as string[];
        for (const sId of Array.from(new Set(consumeSources))) {
          if (ids.has(sId)) {
            out.push({ id: `mng:consume:${sId}->${el.id}`, source: sId, target: el.id, kind: "consume", label: "consume" });
          }
        }
        // inbox dedup table lives in a database (often the same as the outbox DB)
        if (svc?.inboxDbId && ids.has(svc.inboxDbId)) {
          out.push({ id: `mng:inboxtbl:${el.id}->${svc.inboxDbId}`, source: el.id, target: svc.inboxDbId, kind: "inbox-table", label: "dedup table" });
        }
      }
      // broker element contains its topics / queues
      if (el.type === "broker") {
        for (const child of elements) {
          if (child.brokerId === el.id && (child.type === "topic" || child.type === "queue")) {
            out.push({ id: `mng:broker:${el.id}->${child.id}`, source: el.id, target: child.id, kind: "broker-of", label: "hosts" });
          }
        }
      }
      if (el.type === "database" && el.isReplicaOf && ids.has(el.isReplicaOf)) {
        out.push({ id: `mng:replica:${el.isReplicaOf}->${el.id}`, source: el.isReplicaOf, target: el.id, kind: "replica", label: "replica" });
      }
    }
    return out;
  }, [elements]);

  // playback driver
  useEffect(() => {
    if (!playing) {
      if (playRef.current) window.clearTimeout(playRef.current);
      return;
    }
    if (parsed.steps.length === 0) {
      setPlaying(false);
      return;
    }
    playRef.current = window.setTimeout(() => {
      setCurrentStep((s) => {
        const next = s == null ? 0 : s + 1;
        if (next >= parsed.steps.length) {
          setPlaying(false);
          return null;
        }
        return next;
      });
    }, speed);
    return () => { if (playRef.current) window.clearTimeout(playRef.current); };
  }, [playing, currentStep, speed, parsed.steps.length]);

  function addElement(type: ElementType, pos?: { x: number; y: number }) {
    const id = uid();
    const extra: Partial<ArchElement> =
      type === "topic" ? { topicKind: "fanout", bindings: [], broker: "generic" }
      : type === "queue" ? { broker: "generic" }
      : type === "broker" ? { broker: "rabbitmq" }
      : type === "database" ? { dbEngine: "generic" }
      : {};
    const meta = TYPE_GLYPH[type];
    const newEl: ArchElement = { id, name: `${meta.label} ${id}`, type, ...extra };
    setElements((es) => [...es, newEl]);
    if (pos) {
      setCanvasState((s) => ({ ...s, positions: { ...s.positions, [id]: pos } }));
    }
    setSelectedId(id);
    setShowInspector(true);
  }

  function patchEl(id: string, patch: Partial<ArchElement>) {
    setElements((es) => {
      let next = patchElement(es, id, patch);
      // when a queue is renamed, keep its DLQ / retry queue names in sync
      if (patch.name !== undefined) {
        const q = next.find((e) => e.id === id);
        if (q && q.type === "queue") {
          if (q.dlqId) next = patchElement(next, q.dlqId, { name: `${patch.name} · DLQ` });
          if (q.retryQueueId) next = patchElement(next, q.retryQueueId, { name: `${patch.name} · Retry` });
        }
      }
      return next;
    });
  }
  function removeEl(id: string) {
    setElements((es) => es.filter((e) => e.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  // remediation dispatcher
  function applyRemediation(a: RemediationAction) {
    switch (a.kind) {
      case "addOutbox": setElements((es) => setOutbox(es, a.targetId, true)); break;
      case "addInbox": setElements((es) => setInbox(es, a.targetId, true)); break;
      case "makeIdempotent": setElements((es) => patchElement(es, a.targetId, { idempotent: true })); break;
      case "addCircuitBreaker": setElements((es) => patchElement(es, a.targetId, { circuitBreaker: true })); break;
      case "addDlq": setElements((es) => addDlqFor(es, a.targetId)); break;
      case "addRetry": setElements((es) => addRetryFor(es, a.targetId)); break;
      case "convertAsync": setSeqCode((src) => convertStepToAsync(src, Number(a.targetId))); break;
      case "addContract": addContract(); break;
    }
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

  function addContract() {
    const id = uid();
    setContracts((cs) => [...cs, { id, name: `Contract ${id}`, version: "1.0.0" }]);
  }
  function patchContract(id: string, p: Partial<Contract>) {
    setContracts((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
  }
  function removeContract(id: string) {
    setContracts((cs) => cs.filter((c) => c.id !== id));
  }

  function exportJson() {
    const blob = new Blob(
      [JSON.stringify({ elements, edges: canvasState.edges, positions: canvasState.positions, contracts, scenarios, seq: seqCode, faults }, null, 2)],
      { type: "application/json" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "forge-architecture.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importJson(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (Array.isArray(data.elements)) setElements(data.elements);
        if (Array.isArray(data.contracts)) setContracts(data.contracts);
        if (Array.isArray(data.faults)) setFaults(data.faults);
        if (Array.isArray(data.scenarios) && data.scenarios.length) {
          setScenarios(data.scenarios);
          setActiveScenario(data.scenarios[0].id);
        } else if (typeof data.seq === "string") {
          const id = "s1";
          setScenarios([{ id, name: "Imported", seq: data.seq }]);
          setActiveScenario(id);
        }
        setCanvasState({
          positions: data.positions ?? {},
          edges: Array.isArray(data.edges) ? data.edges : [],
        });
        setSelectedId(null);
        setCurrentStep(null);
        setPlaying(false);
      } catch (err) {
        // eslint-disable-next-line no-alert
        alert("Invalid Forge JSON file: " + (err as Error).message);
      }
    };
    reader.readAsText(file);
  }

  // ----- canvas step builder -----
  function onCanvasSelect(id: string | null) {
    if (builderMode && id) {
      if (!builderPending) {
        setBuilderPending(id);
      } else {
        setBuilderSteps((prev) => [
          ...prev,
          { from: builderPending, to: id, kind: "sync", label: "" },
        ]);
        setBuilderPending(null);
      }
      setSelectedId(id);
      return;
    }
    setSelectedId(id);
    if (id) setShowInspector(true);
  }

  function buildBuilderMermaid(steps: BuilderStep[]): string {
    const tokenFor = (k: BuilderStep["kind"]) =>
      k === "async" ? "-)" : k === "response" ? "-->>" : "->>";
    const byId = new Map(elements.map((e) => [e.id, e]));
    const order: string[] = [];
    for (const s of steps) for (const x of [s.from, s.to]) if (!order.includes(x)) order.push(x);
    const lines = ["sequenceDiagram", "  autonumber"];
    for (const pid of order) lines.push(`  participant ${pid} as ${byId.get(pid)?.name ?? pid}`);
    lines.push("");
    for (const s of steps) {
      lines.push(`  ${s.from}${tokenFor(s.kind)}${s.to}: ${s.label || "message"}`);
    }
    return lines.join("\n") + "\n";
  }

  function saveBuilderScenario() {
    if (builderSteps.length === 0) return;
    const seq = buildBuilderMermaid(builderSteps);
    const id = `s${uid()}`;
    setScenarios((prev) => [...prev, { id, name: `Canvas flow ${prev.length + 1}`, seq }]);
    setActiveScenario(id);
    setBuilderSteps([]);
    setBuilderPending(null);
    setBuilderMode(false);
    setDrawerTab("sequence");
    setDrawerOpen(true);
    setCurrentStep(null);
    setPlaying(false);
  }

  // ----- scenarios (multiple sequence diagrams) -----
  function addScenario() {
    const id = `s${uid()}`;
    setScenarios((prev) => [...prev, { id, name: `Scenario ${prev.length + 1}`, seq: "sequenceDiagram\n  autonumber\n" }]);
    setActiveScenario(id);
    setCurrentStep(null);
    setPlaying(false);
  }
  function removeScenario(id: string) {
    setScenarios((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((s) => s.id !== id);
      if (id === activeScenario) setActiveScenario(next[0].id);
      return next;
    });
  }
  function renameScenario(id: string, name: string) {
    setScenarios((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
  }

  // generate a mermaid sequence diagram from the current canvas
  function generateFromCanvas() {
    const seq = generateMermaid(elements, canvasState.edges, managedEdges);
    const id = `s${uid()}`;
    setScenarios((prev) => [...prev, { id, name: `From canvas ${prev.length + 1}`, seq }]);
    setActiveScenario(id);
    setDrawerTab("sequence");
    setDrawerOpen(true);
    setCurrentStep(null);
    setPlaying(false);
  }

  const selected = elements.find((e) => e.id === selectedId) ?? null;
  const stepEvents = useMemo(() => {
    const map = new Map<number, typeof result.events>();
    for (const ev of result.events) {
      const arr = map.get(ev.stepIndex) ?? [];
      arr.push(ev);
      map.set(ev.stepIndex, arr);
    }
    return map;
  }, [result.events]);

  return (
    <div className="h-screen flex flex-col text-foreground overflow-hidden">
      {/* Top toolbar */}
      <header className="h-12 border-b border-border bg-surface/80 backdrop-blur flex items-center px-3 gap-2 shrink-0 z-20">
        <div className="flex items-center gap-2 pr-3 border-r border-border">
          <div className="w-7 h-7 rounded grid place-items-center border border-primary/40 bg-primary/10 text-primary font-mono">⌬</div>
          <div className="leading-tight">
            <div className="text-xs font-semibold tracking-tight">Forge</div>
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Architecture Tester</div>
          </div>
        </div>

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
              setSelectedId(null);
            }
            e.currentTarget.value = "";
          }}
        >
          <option value="">⌬ Templates…</option>
          <option value="outbox">Transactional Outbox</option>
          <option value="snsSqs">SNS → SQS (fanout + DLQ)</option>
          <option value="kafkaStream">Kafka Stream Processing</option>
          <option value="saga">Saga Orchestrator</option>
        </select>

        <button
          onClick={() => {
            const { elements: imported, edges: importedEdges } = importFromMermaid(seqCode, elements);
            setElements(imported);
            setCanvasState((s) => {
              const existingKeys = new Set(s.edges.map((e) => `${e.source}->${e.target}:${e.kind}`));
              const additions = importedEdges
                .filter((e) => !existingKeys.has(`${e.source}->${e.target}:${e.kind}`))
                .map((e) => ({ id: e.id, source: e.source, target: e.target, kind: e.kind as EdgeKind }));
              return { positions: s.positions, edges: [...s.edges, ...additions] };
            });
          }}
          className="text-xs px-2 py-1 rounded-md border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
        >
          ⇪ Import Mermaid
        </button>

        <button
          onClick={generateFromCanvas}
          title="Generate a Mermaid sequence diagram from the components & connections on the canvas"
          className="text-xs px-2 py-1 rounded-md border border-accent/40 bg-accent/10 text-accent hover:bg-accent/20"
        >
          ⤓ Generate from canvas
        </button>

        <button onClick={exportJson}
          className="text-xs px-2 py-1 rounded-md border border-border bg-surface-2 hover:border-primary/40 hover:text-primary">
          ↧ Export JSON
        </button>

        <button onClick={() => importRef.current?.click()}
          className="text-xs px-2 py-1 rounded-md border border-border bg-surface-2 hover:border-primary/40 hover:text-primary">
          ↥ Import JSON
        </button>
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importJson(f);
            e.currentTarget.value = "";
          }}
        />

        <button
          onClick={() => { setBuilderMode((v) => !v); setBuilderPending(null); }}
          title="Compose a sequence by clicking components on the canvas in order"
          className={`text-xs px-2 py-1 rounded-md border ${builderMode ? "border-accent bg-accent/20 text-accent" : "border-border bg-surface-2 hover:border-primary/40 hover:text-primary"}`}
        >
          ✎ Build on canvas
        </button>

        <button onClick={() => setShowGuide(true)}
          className="text-xs px-2 py-1 rounded-md border border-border bg-surface-2 hover:border-primary/40 hover:text-primary">
          ? Guide
        </button>

        <div className="flex-1" />

        <Pill tone="info">{parsed.steps.length} steps</Pill>
        <Pill tone={result.summary.errors ? "error" : "success"}>{result.summary.errors} errors</Pill>
        <Pill tone={result.summary.warnings ? "warning" : "muted"}>{result.summary.warnings} warnings</Pill>
        <Pill tone={load.errors ? "error" : load.warnings ? "warning" : "muted"}>
          {load.errors + load.warnings} load
        </Pill>

        <button
          onClick={() => setShowLegend((v) => !v)}
          className="ml-2 text-xs px-2 py-1 rounded-md border border-border bg-surface-2 hover:border-primary/40 hover:text-primary"
        >
          {showLegend ? "Hide legend" : "Legend"}
        </button>


        <button
          onClick={() => setShowInspector((v) => !v)}
          className="ml-2 text-xs px-2 py-1 rounded-md border border-border bg-surface-2 hover:border-primary/40 hover:text-primary"
        >
          {showInspector ? "Hide inspector ›" : "‹ Inspector"}
        </button>
      </header>

      {/* Body: palette | canvas+drawer | inspector */}
      <div className="flex-1 flex min-h-0">
        <Palette onAdd={(t) => addElement(t)} expanded={paletteExpanded} onToggle={() => setPaletteExpanded((v) => !v)} />

        <div className="flex-1 flex flex-col min-w-0 relative">
          <div className="flex-1 min-h-0 relative">
            <ArchCanvas
              elements={elements}
              state={canvasState}
              onStateChange={setCanvasState}
              activeEdgeKeys={activeEdgeKeys}
              failedEdgeKeys={failedEdgeKeys}
              selectedId={selectedId}
              onSelect={(id) => { setSelectedId(id); if (id) setShowInspector(true); }}
              managedEdges={managedEdges}
              onDropType={(type, pos) => addElement(type, pos)}
              onAddDlq={(id) => setElements((es) => addDlqFor(es, id))}
              onAddRetry={(id) => setElements((es) => addRetryFor(es, id))}
            />
            {/* Floating playback HUD */}
            <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-surface/90 backdrop-blur border border-border rounded-full px-3 py-1.5 shadow-lg z-10">
              <button onClick={() => { setCurrentStep(null); setPlaying(false); }} title="reset"
                className="text-xs text-muted-foreground hover:text-foreground">⏮</button>
              <button onClick={() => setCurrentStep((s) => Math.max(0, (s ?? 0) - 1))} title="prev"
                className="text-xs text-muted-foreground hover:text-foreground">◀</button>
              <button onClick={() => { if (currentStep == null) setCurrentStep(0); setPlaying((p) => !p); }}
                className={`text-sm px-2 py-0.5 rounded ${playing ? "bg-destructive/20 text-destructive" : "bg-primary/20 text-primary"}`}>
                {playing ? "⏸" : "▶"}
              </button>
              <button onClick={() => setCurrentStep((s) => Math.min(parsed.steps.length - 1, (s ?? -1) + 1))} title="next"
                className="text-xs text-muted-foreground hover:text-foreground">▶</button>
              <span className="mono text-[10px] text-muted-foreground ml-1">
                {currentStep == null ? "—" : `${currentStep + 1}/${parsed.steps.length}`}
              </span>
              <input type="range" min={200} max={2000} step={100} value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                className="w-20 accent-primary" title={`${speed}ms / step`} />
            </div>
            {showLegend && <Legend />}
          </div>

          {/* Bottom drawer */}
          <div className={`border-t border-border bg-surface/70 backdrop-blur transition-all ${drawerOpen ? "h-[280px]" : "h-9"} shrink-0 flex flex-col`}>
            <div className="flex items-center gap-1 px-2 h-9 border-b border-border bg-surface-2/40 shrink-0">
              <DrawerTab active={drawerTab === "playback"} onClick={() => { setDrawerTab("playback"); setDrawerOpen(true); }}>
                ▶ Trace
              </DrawerTab>
              <DrawerTab active={drawerTab === "findings"} onClick={() => { setDrawerTab("findings"); setDrawerOpen(true); }}>
                ⚠ Findings · {result.events.length}
              </DrawerTab>
              <DrawerTab active={drawerTab === "sequence"} onClick={() => { setDrawerTab("sequence"); setDrawerOpen(true); }}>
                ⌥ Sequences · {scenarios.length}
              </DrawerTab>
              <DrawerTab active={drawerTab === "load"} onClick={() => { setDrawerTab("load"); setDrawerOpen(true); }}>
                ⚡ Load{load.errors + load.warnings ? ` · ${load.errors + load.warnings}` : ""}
              </DrawerTab>
              <div className="flex-1" />
              <button onClick={() => setDrawerOpen((v) => !v)}
                className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground px-2">
                {drawerOpen ? "▾ hide" : "▴ show"}
              </button>
            </div>
            {drawerOpen && (
              <div className="flex-1 overflow-auto">
                {drawerTab === "playback" && (
                  <TraceView
                    steps={parsed.steps}
                    currentStep={currentStep}
                    stepEvents={stepEvents}
                    onHover={setCurrentStep}
                    onApply={applyRemediation}
                    onToggleFault={toggleFault}
                    hasFault={hasFault}
                  />
                )}
                {drawerTab === "findings" && (
                  <FindingsView events={result.events} onApply={applyRemediation} onHover={setCurrentStep} currentStep={currentStep} />
                )}
                {drawerTab === "sequence" && (
                  <div className="flex flex-col h-full">
                    <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-surface-2/40 overflow-x-auto shrink-0">
                      {scenarios.map((s) => (
                        <div key={s.id}
                          className={`group flex items-center gap-1 px-2 py-1 rounded text-[11px] cursor-pointer whitespace-nowrap ${s.id === activeScenario ? "bg-primary/20 text-primary" : "bg-surface-2 text-muted-foreground hover:text-foreground"}`}
                          onClick={() => { setActiveScenario(s.id); setCurrentStep(null); setPlaying(false); }}
                        >
                          <input
                            value={s.name}
                            onChange={(e) => renameScenario(s.id, e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            className="bg-transparent outline-none w-24 cursor-text"
                          />
                          {scenarios.length > 1 && (
                            <button onClick={(e) => { e.stopPropagation(); removeScenario(s.id); }}
                              className="opacity-0 group-hover:opacity-100 text-destructive">×</button>
                          )}
                        </div>
                      ))}
                      <button onClick={addScenario}
                        className="px-2 py-1 rounded text-[11px] border border-border text-muted-foreground hover:text-primary hover:border-primary/40">
                        + new
                      </button>
                    </div>
                    <textarea
                      className="mono flex-1 w-full bg-surface-2 text-foreground text-[12px] leading-relaxed p-3 outline-none resize-none"
                      value={seqCode}
                      spellCheck={false}
                      onChange={(e) => setSeqCode(e.target.value)}
                    />
                  </div>
                )}
                {drawerTab === "load" && (
                  <LoadView load={load} />
                )}
              </div>
            )}
          </div>
        </div>

        {showInspector && (
          <Inspector
            element={selected}
            elements={elements}
            contracts={contracts}
            onChange={(p) => selected && patchEl(selected.id, p)}
            onRemove={() => selected && removeEl(selected.id)}
            onSetOutbox={(v) => selected && setElements((es) => setOutbox(es, selected.id, v))}
            onSetInbox={(v) => selected && setElements((es) => setInbox(es, selected.id, v))}
            onAddDlq={() => selected && setElements((es) => addDlqFor(es, selected.id))}
            onAddRetry={() => selected && setElements((es) => addRetryFor(es, selected.id))}
            onAddContract={addContract}
            onPatchContract={patchContract}
            onRemoveContract={removeContract}
            onClose={() => setShowInspector(false)}
          />
        )}
      </div>
      {showGuide && <GuideModal onClose={() => setShowGuide(false)} />}
    </div>
  );
}

/* ------- subcomponents ------- */

const GUIDE_STEPS: { title: string; body: string }[] = [
  { title: "1 · Modele a arquitetura", body: "Arraste componentes da paleta (clique em › para expandir os nomes) e conecte-os no canvas. Componentes órfãos mostram um X até serem ligados." },
  { title: "2 · Configure os detalhes", body: "Selecione um componente para abrir o inspector: brokers, DBs (réplicas/sharding), outbox/inbox, contratos e capacidade." },
  { title: "3 · Ajuste as linhas", body: "Arraste o ponto central de qualquer linha para roteá-la fora dos componentes. Dê duplo-clique para resetar. A legenda explica cores e estilos." },
  { title: "4 · Gere o diagrama de sequência", body: "Use 'Generate from canvas' para criar um diagrama Mermaid a partir dos componentes e conexões. Edite na aba Sequences." },
  { title: "5 · Rode múltiplos cenários", body: "Crie vários diagramas de sequência (+ new) para testar fluxos diferentes sobre a mesma arquitetura. Cada um roda de forma independente." },
  { title: "6 · Teste e valide", body: "Use o player (▶) para ver o dado trafegando passo a passo. Findings mostra riscos (dual-write, dedup, etc.) com remediações de 1 clique." },
  { title: "7 · Valide carga", body: "Na aba Load, defina RPS oferecido e capacidade por instância (ou drain rate de filas) para detectar sobrecarga e crescimento de backlog." },
];

function GuideModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg shadow-2xl max-w-lg w-full max-h-[80vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border sticky top-0 bg-surface">
          <h2 className="text-sm font-semibold">Como usar o Forge</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg leading-none">×</button>
        </div>
        <ol className="p-4 space-y-3">
          {GUIDE_STEPS.map((s) => (
            <li key={s.title}>
              <div className="text-xs font-semibold text-primary">{s.title}</div>
              <div className="text-[12px] text-muted-foreground leading-relaxed">{s.body}</div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}


function Palette({ onAdd, expanded, onToggle }: { onAdd: (t: ElementType) => void; expanded: boolean; onToggle: () => void }) {
  return (
    <aside className={`${expanded ? "w-44" : "w-16"} shrink-0 border-r border-border bg-surface/70 backdrop-blur flex flex-col py-2 gap-1.5 overflow-y-auto transition-all`}>
      <button
        onClick={onToggle}
        title={expanded ? "Collapse palette" : "Expand palette"}
        className={`mx-2 mb-1 h-7 rounded-md border border-border bg-surface-2 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-primary hover:border-primary/40 flex items-center ${expanded ? "justify-between px-2" : "justify-center"}`}
      >
        {expanded ? <><span>Components</span><span>‹</span></> : <span>›</span>}
      </button>
      {(Object.keys(TYPE_GLYPH) as ElementType[])
        .filter((t) => t !== "relay" && t !== "inbox-store")
        .map((t) => {
          const m = TYPE_GLYPH[t];
          return (
            <button
              key={t}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/arch-type", t);
                e.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => onAdd(t)}
              title={`Drag onto canvas or click to add ${m.label}`}
              className={`mx-2 h-11 rounded-md border border-border bg-surface hover:border-primary/60 hover:text-primary cursor-grab active:cursor-grabbing transition group relative flex items-center ${expanded ? "gap-2 px-3" : "justify-center"}`}
            >
              <span className="mono text-xl shrink-0" style={{ color: m.color }}>{m.glyph}</span>
              {expanded ? (
                <span className="text-[11px] truncate">{m.label}</span>
              ) : (
                <span className="absolute left-full ml-2 text-[10px] uppercase tracking-wider bg-surface border border-border rounded px-1.5 py-0.5 opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-30">
                  {m.label}
                </span>
              )}
            </button>
          );
        })}
    </aside>
  );
}

function Legend() {
  return (
    <div className="absolute bottom-3 left-3 z-10 bg-surface/90 backdrop-blur border border-border rounded-md px-3 py-2 shadow-lg max-h-[60%] overflow-auto w-[210px]">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1.5">Line legend</div>
      <ul className="space-y-1">
        {EDGE_LEGEND.map((l) => {
          const st = EDGE_STYLE[l.kind];
          return (
            <li key={l.kind} className="flex items-center gap-2">
              <svg width="26" height="8" className="shrink-0">
                <line x1="0" y1="4" x2="26" y2="4"
                  stroke={st?.stroke ?? "var(--color-primary)"}
                  strokeWidth={st?.width ?? 1.6}
                  strokeDasharray={st?.dasharray} />
              </svg>
              <span className="text-[10px] text-muted-foreground">{l.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LoadView({ load }: { load: LoadResult }) {
  if (load.rows.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground leading-relaxed">
        No load configured yet. Select a service / API / queue / topic and set its{" "}
        <span className="text-foreground">offered RPS</span> and{" "}
        <span className="text-foreground">capacity per instance</span> (or consumer drain rate for
        queues) below or in the inspector to validate capacity & backlog.
      </div>
    );
  }
  const tone: Record<LoadStatus, string> = {
    over: "text-destructive",
    warn: "text-amber-400",
    ok: "text-green-400",
    na: "text-muted-foreground",
  };
  return (
    <table className="w-full text-[11px]">
      <thead className="text-[9px] uppercase tracking-wider text-muted-foreground bg-surface-2/40 sticky top-0">
        <tr>
          <th className="text-left px-3 py-1.5">Component</th>
          <th className="text-right px-2">Offered</th>
          <th className="text-right px-2">Capacity</th>
          <th className="text-left px-2 w-28">Utilization</th>
          <th className="text-left px-3">Diagnosis</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {load.rows.map((r: LoadRow) => {
          const pct = r.utilization != null ? Math.round(r.utilization * 100) : null;
          return (
            <tr key={r.id}>
              <td className="px-3 py-1.5">
                <span className="text-foreground">{r.name}</span>
                <span className="text-muted-foreground ml-1">· {r.type}</span>
              </td>
              <td className="text-right px-2 mono">{r.offered != null ? fmtRate(r.offered) : "—"}</td>
              <td className="text-right px-2 mono">{r.capacity != null ? fmtRate(r.capacity) : "—"}</td>
              <td className="px-2">
                {pct != null ? (
                  <div className="flex items-center gap-1">
                    <div className="flex-1 h-1.5 rounded bg-surface-2 overflow-hidden">
                      <div className={`h-full ${r.status === "over" ? "bg-destructive" : r.status === "warn" ? "bg-amber-400" : "bg-green-500"}`}
                        style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                    <span className={`mono ${tone[r.status]}`}>{pct}%</span>
                  </div>
                ) : <span className="text-muted-foreground">—</span>}
              </td>
              <td className={`px-3 py-1.5 ${tone[r.status]}`}>{r.note ?? "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}


function DrawerTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`text-[10px] uppercase tracking-wider px-2.5 py-1 rounded border ${
        active ? "border-primary/50 bg-primary/10 text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
      }`}>
      {children}
    </button>
  );
}

function TraceView({
  steps, currentStep, stepEvents, onHover, onApply, onToggleFault, hasFault,
}: {
  steps: ReturnType<typeof parseSequence>["steps"];
  currentStep: number | null;
  stepEvents: Map<number, { severity: Severity; message: string; detail?: string; suggestions?: RemediationAction[] }[]>;
  onHover: (i: number | null) => void;
  onApply: (a: RemediationAction) => void;
  onToggleFault: (i: number, k: Fault["kind"]) => void;
  hasFault: (i: number, k: Fault["kind"]) => boolean;
}) {
  return (
    <ol className="divide-y divide-border">
      {steps.map((s) => {
        const isActive = currentStep === s.index;
        const evs = stepEvents.get(s.index) ?? [];
        const worst = evs.find((e) => e.severity === "error") ? "error"
          : evs.find((e) => e.severity === "warning") ? "warning" : null;
        return (
          <li key={s.index}
            onMouseEnter={() => onHover(s.index)}
            onMouseLeave={() => onHover(null)}
            className={`px-3 py-2 text-xs transition-colors cursor-pointer ${
              isActive ? "bg-primary/10"
                : worst === "error" ? "bg-destructive/5"
                : worst === "warning" ? "bg-warning/5"
                : "hover:bg-surface-2/50"
            }`}>
            <div className="flex items-start gap-2">
              <span className="mono w-6 text-muted-foreground">{s.index + 1}.</span>
              <div className="flex-1 min-w-0">
                <div className="mono text-[11.5px] truncate" title={s.raw}>{s.raw}</div>
                {s.kind !== "note" && (
                  <div className="mt-1 flex gap-1 flex-wrap">
                    {(["drop", "duplicate", "reorder", "latency"] as Fault["kind"][]).map((k) => (
                      <button key={k}
                        onClick={() => onToggleFault(s.index, k)}
                        className={`text-[9.5px] uppercase tracking-wider px-1.5 py-0.5 rounded border transition-colors ${
                          hasFault(s.index, k)
                            ? "bg-destructive/20 border-destructive/60 text-destructive"
                            : "border-border text-muted-foreground hover:text-foreground hover:bg-surface-2"
                        }`}>
                        {k}
                      </button>
                    ))}
                  </div>
                )}
                {evs.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {evs.map((ev, i) => (
                      <div key={i} className={`rounded border p-2 ${
                        ev.severity === "error" ? "border-destructive/40 bg-destructive/10"
                          : ev.severity === "warning" ? "border-warning/40 bg-warning/10"
                          : ev.severity === "success" ? "border-success/40 bg-success/10"
                          : "border-info/40 bg-info/10"
                      }`}>
                        <div className="flex items-start gap-1.5">
                          <SeverityDot s={ev.severity} />
                          <div className="flex-1 min-w-0">
                            <div className="text-[11px] font-medium leading-tight">{ev.message}</div>
                            {ev.detail && <div className="text-[10.5px] text-muted-foreground mt-0.5 leading-snug">{ev.detail}</div>}
                            {ev.suggestions && ev.suggestions.length > 0 && (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {ev.suggestions.map((a, j) => (
                                  <button key={j} onClick={(e) => { e.stopPropagation(); onApply(a); }}
                                    className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-primary/50 bg-primary/10 text-primary hover:bg-primary/20">
                                    ✦ {a.label}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <KindBadge kind={s.kind} />
            </div>
          </li>
        );
      })}
      {steps.length === 0 && (
        <li className="p-4 text-xs text-muted-foreground">No steps parsed yet. Edit the sequence on the Sequence tab.</li>
      )}
    </ol>
  );
}

function FindingsView({
  events, onApply, onHover, currentStep,
}: {
  events: { stepIndex: number; severity: Severity; message: string; detail?: string; suggestions?: RemediationAction[] }[];
  onApply: (a: RemediationAction) => void;
  onHover: (i: number | null) => void;
  currentStep: number | null;
}) {
  return (
    <ul className="divide-y divide-border">
      {events.map((ev, i) => (
        <li key={i}
          onMouseEnter={() => onHover(ev.stepIndex)}
          onMouseLeave={() => onHover(null)}
          className={`px-3 py-2 text-xs ${currentStep === ev.stepIndex ? "bg-surface-2" : ""}`}>
          <div className="flex items-start gap-2">
            <SeverityDot s={ev.severity} />
            <div className="flex-1 min-w-0">
              <div className="font-medium">{ev.message}</div>
              {ev.detail && <div className="text-muted-foreground mt-0.5">{ev.detail}</div>}
              <div className="text-[10px] text-muted-foreground mt-1 mono">step {ev.stepIndex + 1}</div>
              {ev.suggestions && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {ev.suggestions.map((a, j) => (
                    <button key={j} onClick={() => onApply(a)}
                      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-primary/50 bg-primary/10 text-primary hover:bg-primary/20">
                      ✦ {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </li>
      ))}
      {events.length === 0 && (
        <li className="p-4 text-xs text-muted-foreground">No issues detected. Try injecting a duplicate, drop, or latency.</li>
      )}
    </ul>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone: "info" | "success" | "warning" | "error" | "muted" }) {
  const map: Record<string, string> = {
    info: "border-info/40 text-info bg-info/10",
    success: "border-success/40 text-success bg-success/10",
    warning: "border-warning/40 text-warning bg-warning/10",
    error: "border-destructive/40 text-destructive bg-destructive/10",
    muted: "border-border text-muted-foreground bg-surface",
  };
  return (
    <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border ${map[tone]}`}>
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
    <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0 ${map[kind]}`}>
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
  return <span className={`inline-block w-2 h-2 rounded-full mt-1.5 shrink-0 ${map[s]}`} />;
}
