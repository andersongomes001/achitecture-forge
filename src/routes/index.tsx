import { useMemo, useState } from "react";
import { MermaidView } from "@/components/arch/MermaidView";
import { ArchCanvas, type CanvasState } from "@/components/arch/ArchCanvas";
import { parseSequence } from "@/lib/arch/parser";
import { simulate } from "@/lib/arch/simulator";
import type { ArchElement, ElementType, Fault, Severity } from "@/lib/arch/types";
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


  function addElement(type: ElementType) {
    const id = uid();
    setElements((es) => [
      ...es,
      { id, name: `${TYPE_META[type].label} ${id}`, type, hasInbox: false, hasOutbox: false, idempotent: false },
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

        {/* Center: architecture + sequence */}
        <section className="col-span-12 lg:col-span-6 space-y-4">
          <Panel title="Architecture map">
            <div className="p-3">
              <MermaidView code={archDiagram} />
            </div>
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
  onChange,
  onRemove,
}: {
  el: ArchElement;
  onChange: (p: Partial<ArchElement>) => void;
  onRemove: () => void;
}) {
  const meta = TYPE_META[el.type];
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
    </div>
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
