import { useState } from "react";
import type {
  ArchElement,
  BrokerKind,
  Contract,
  DbEngine,
  ElementType,
  TopicBinding,
  TopicKind,
} from "@/lib/arch/types";
import { TYPE_GLYPH } from "./ArchCanvas";

interface Props {
  element: ArchElement | null;
  elements: ArchElement[];
  contracts: Contract[];
  onChange: (patch: Partial<ArchElement>) => void;
  onRemove: () => void;
  onSetOutbox: (on: boolean) => void;
  onSetInbox: (on: boolean) => void;
  onAddDlq: () => void;
  onAddRetry: () => void;
  onAddContract: () => void;
  onPatchContract: (id: string, patch: Partial<Contract>) => void;
  onRemoveContract: (id: string) => void;
  onClose: () => void;
}

export function Inspector(props: Props) {
  const { element, elements, contracts } = props;
  const [tab, setTab] = useState<"element" | "contracts">("element");
  if (!element) {
    return (
      <Shell onClose={props.onClose} title="Inspector">
        <div className="p-4 text-xs text-muted-foreground">
          Select a component on the canvas to edit it. Use the palette to drop new ones.
        </div>
        <ContractsSection
          contracts={contracts}
          elements={elements}
          onAdd={props.onAddContract}
          onPatch={props.onPatchContract}
          onRemove={props.onRemoveContract}
        />
      </Shell>
    );
  }
  const meta = TYPE_GLYPH[element.type];
  const queues = elements.filter((e) => e.type === "queue" && e.id !== element.id);
  const dbs = elements.filter((e) => e.type === "database" || e.type === "cache");
  // messaging destinations the outbox can publish to / the inbox can consume from
  const destinations = elements.filter(
    (e) => (e.type === "topic" || e.type === "queue" || e.type === "broker") && e.id !== element.id,
  );
  // databases owned by this service (preferred host for the inbox dedup table)
  const ownedDbs = (element.dataStores ?? [])
    .map((id) => elements.find((e) => e.id === id))
    .filter((e): e is ArchElement => !!e && (e.type === "database" || e.type === "cache"));

  return (
    <Shell
      onClose={props.onClose}
      title={
        <span className="flex items-center gap-2">
          <span className="mono" style={{ color: meta.color }}>{meta.glyph}</span>
          <span>{element.name}</span>
          <span className="text-[10px] text-muted-foreground mono">· {meta.label}</span>
        </span>
      }
    >
      <div className="flex border-b border-border bg-surface-2/40">
        <TabBtn active={tab === "element"} onClick={() => setTab("element")}>Element</TabBtn>
        <TabBtn active={tab === "contracts"} onClick={() => setTab("contracts")}>
          Contracts ({contracts.length})
        </TabBtn>
      </div>
      {tab === "element" && (
        <div className="p-3 space-y-3 overflow-y-auto">
          <Row label="name">
            <input
              value={element.name}
              onChange={(e) => props.onChange({ name: e.target.value })}
              className="flex-1 bg-surface border border-border rounded px-2 py-1 text-xs outline-none"
            />
          </Row>
          <Row label="id">
            <input
              value={element.id}
              onChange={(e) => props.onChange({ id: e.target.value.replace(/\s+/g, "_").toUpperCase() })}
              className="mono text-[11px] bg-surface border border-border rounded px-2 py-1 outline-none flex-1"
            />
          </Row>
          <Row label="type">
            <select
              value={element.type}
              onChange={(e) => props.onChange({ type: e.target.value as ElementType })}
              className="text-[11px] bg-surface border border-border rounded px-2 py-1 flex-1 outline-none"
            >
              {Object.entries(TYPE_GLYPH).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </Row>

          {(element.type === "service" || element.type === "lambda" || element.type === "saga" || element.type === "stream") && (
            <Section title="Patterns">
              <ToggleRow
                on={!!element.idempotent}
                onChange={(v) => props.onChange({ idempotent: v })}
                label="Idempotent"
                hint="Safe to receive the same message multiple times"
              />
              <ToggleRow
                on={!!element.hasOutbox}
                onChange={(v) => props.onSetOutbox(v)}
                label="Outbox pattern"
                hint="Auto-creates an Outbox Relay sibling"
              />
              {element.hasOutbox && (
                <div className="ml-1 pl-2 border-l border-accent/40 space-y-1.5">
                  <Row label="publishes to">
                    <select
                      value={element.outboxTargetId ?? ""}
                      onChange={(e) => props.onChange({ outboxTargetId: e.target.value || undefined })}
                      className="text-[11px] bg-surface border border-border rounded px-2 py-1 flex-1 outline-none"
                    >
                      <option value="">— pick topic / queue / broker —</option>
                      {destinations.map((d) => (
                        <option key={d.id} value={d.id}>{d.id} · {d.type}</option>
                      ))}
                    </select>
                  </Row>
                  {!element.outboxTargetId && (
                    <p className="text-[9.5px] text-warning">Relay has no destination — pick where events are published.</p>
                  )}
                </div>
              )}
              <ToggleRow
                on={!!element.hasInbox}
                onChange={(v) => props.onSetInbox(v)}
                label="Inbox / dedup"
                hint="Auto-creates an Inbox Store sibling"
              />
              {element.hasInbox && (
                <div className="ml-1 pl-2 border-l border-success/40 space-y-1.5">
                  <Row label="consumes from">
                    <select
                      value={element.inboxSourceId ?? ""}
                      onChange={(e) => props.onChange({ inboxSourceId: e.target.value || undefined })}
                      className="text-[11px] bg-surface border border-border rounded px-2 py-1 flex-1 outline-none"
                    >
                      <option value="">— pick topic / queue / broker —</option>
                      {destinations.map((d) => (
                        <option key={d.id} value={d.id}>{d.id} · {d.type}</option>
                      ))}
                    </select>
                  </Row>
                  <Row label="dedup db">
                    <select
                      value={element.inboxDbId ?? ""}
                      onChange={(e) => props.onChange({ inboxDbId: e.target.value || undefined })}
                      className="text-[11px] bg-surface border border-border rounded px-2 py-1 flex-1 outline-none"
                    >
                      <option value="">— same db, distinct table —</option>
                      {(ownedDbs.length ? ownedDbs : dbs).map((d) => (
                        <option key={d.id} value={d.id}>{d.id} · {d.dbEngine ?? d.type}</option>
                      ))}
                    </select>
                  </Row>
                  <p className="text-[9.5px] text-muted-foreground">Inbox table can live in the same database bound to the outbox — just a separate table.</p>
                  {!element.inboxSourceId && (
                    <p className="text-[9.5px] text-warning">Inbox has no source — pick where messages arrive.</p>
                  )}
                </div>
              )}
              <ToggleRow
                on={!!element.circuitBreaker}
                onChange={(v) => props.onChange({ circuitBreaker: v })}
                label="Circuit breaker"
                hint="Fails fast on sync downstream errors"
              />
              <Row label="retry">
                <select
                  value={element.retryPolicy ?? "none"}
                  onChange={(e) => props.onChange({ retryPolicy: e.target.value as ArchElement["retryPolicy"] })}
                  className="text-[11px] bg-surface border border-border rounded px-2 py-1 flex-1 outline-none"
                >
                  <option value="none">none</option>
                  <option value="linear">linear</option>
                  <option value="exponential">exponential backoff</option>
                </select>
              </Row>
            </Section>
          )}

          {element.type === "database" && (
            <Section title="Database">
              <Row label="engine">
                <select
                  value={element.dbEngine ?? "generic"}
                  onChange={(e) => props.onChange({ dbEngine: e.target.value as DbEngine })}
                  className="text-[11px] bg-surface border border-border rounded px-2 py-1 flex-1 outline-none"
                >
                  {(["generic", "postgres", "mysql", "mongodb", "dynamodb", "cassandra", "redis", "elasticsearch", "clickhouse"] as DbEngine[]).map((e) => (
                    <option key={e} value={e}>{e}</option>
                  ))}
                </select>
              </Row>
              <Row label="replicas">
                <input
                  type="number"
                  min={0}
                  value={element.dbReplicas ?? 0}
                  onChange={(e) => props.onChange({ dbReplicas: Number(e.target.value) || 0 })}
                  className="mono text-[11px] bg-surface border border-border rounded px-2 py-1 outline-none w-24"
                />
              </Row>
              {(element.dbEngine === "postgres" || element.dbEngine === "mysql") && (
                <Row label="isolation">
                  <select
                    value={element.dbIsolation ?? "read-committed"}
                    onChange={(e) => props.onChange({ dbIsolation: e.target.value })}
                    className="text-[11px] bg-surface border border-border rounded px-2 py-1 flex-1 outline-none"
                  >
                    <option>read-committed</option>
                    <option>repeatable-read</option>
                    <option>serializable</option>
                  </select>
                </Row>
              )}
              {element.dbEngine === "mongodb" && (
                <>
                  <Row label="writeConcern">
                    <input
                      value={element.dbWriteConcern ?? "majority"}
                      onChange={(e) => props.onChange({ dbWriteConcern: e.target.value })}
                      className="mono text-[11px] bg-surface border border-border rounded px-2 py-1 outline-none flex-1"
                    />
                  </Row>
                  <Row label="readPref">
                    <select
                      value={element.dbReadPreference ?? "primary"}
                      onChange={(e) => props.onChange({ dbReadPreference: e.target.value })}
                      className="text-[11px] bg-surface border border-border rounded px-2 py-1 flex-1 outline-none"
                    >
                      <option>primary</option>
                      <option>primaryPreferred</option>
                      <option>secondary</option>
                      <option>nearest</option>
                    </select>
                  </Row>
                </>
              )}
              {element.dbEngine === "dynamodb" && (
                <>
                  <Row label="partKey">
                    <input
                      value={element.dbPartitionKey ?? ""}
                      onChange={(e) => props.onChange({ dbPartitionKey: e.target.value })}
                      placeholder="userId"
                      className="mono text-[11px] bg-surface border border-border rounded px-2 py-1 outline-none flex-1"
                    />
                  </Row>
                  <Row label="consistency">
                    <select
                      value={element.dbConsistency ?? "eventual"}
                      onChange={(e) => props.onChange({ dbConsistency: e.target.value as ArchElement["dbConsistency"] })}
                      className="text-[11px] bg-surface border border-border rounded px-2 py-1 flex-1 outline-none"
                    >
                      <option value="eventual">eventual</option>
                      <option value="strong">strong</option>
                    </select>
                  </Row>
                </>
              )}
              {element.dbEngine === "cassandra" && (
                <Row label="consistency">
                  <select
                    value={element.dbConsistency ?? "quorum"}
                    onChange={(e) => props.onChange({ dbConsistency: e.target.value as ArchElement["dbConsistency"] })}
                    className="text-[11px] bg-surface border border-border rounded px-2 py-1 flex-1 outline-none"
                  >
                    <option value="one">ONE</option>
                    <option value="quorum">QUORUM</option>
                    <option value="all">ALL</option>
                  </select>
                </Row>
              )}
              {element.dbEngine === "redis" && (
                <>
                  <Row label="mode">
                    <select
                      value={element.dbMode ?? "standalone"}
                      onChange={(e) => props.onChange({ dbMode: e.target.value })}
                      className="text-[11px] bg-surface border border-border rounded px-2 py-1 flex-1 outline-none"
                    >
                      <option>standalone</option>
                      <option>cluster</option>
                      <option>sentinel</option>
                    </select>
                  </Row>
                  <Row label="persistence">
                    <select
                      value={element.dbPersistence ?? "AOF"}
                      onChange={(e) => props.onChange({ dbPersistence: e.target.value })}
                      className="text-[11px] bg-surface border border-border rounded px-2 py-1 flex-1 outline-none"
                    >
                      <option>none</option>
                      <option>AOF</option>
                      <option>RDB</option>
                    </select>
                  </Row>
                </>
              )}
              {element.dbEngine === "elasticsearch" && (
                <Row label="shards">
                  <input
                    type="number"
                    min={1}
                    value={element.dbShards ?? 1}
                    onChange={(e) => props.onChange({ dbShards: Number(e.target.value) || 1 })}
                    className="mono text-[11px] bg-surface border border-border rounded px-2 py-1 outline-none w-24"
                  />
                </Row>
              )}
            </Section>
          )}

          {(element.type === "queue" || element.type === "topic") && (
            <Section title="Broker">
              <Row label="broker">
                <select
                  value={element.broker ?? "generic"}
                  onChange={(e) => props.onChange({ broker: e.target.value as BrokerKind })}
                  className="text-[11px] bg-surface border border-border rounded px-2 py-1 flex-1 outline-none"
                >
                  {(["generic", "rabbitmq", "sqs", "sns", "kafka", "eventbridge", "redis-streams", "gcp-pubsub"] as BrokerKind[]).map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </Row>
              {element.type === "queue" && (
                <>
                  {(element.broker === "sqs" || element.broker === "rabbitmq") && (
                    <ToggleRow on={!!element.fifo} onChange={(v) => props.onChange({ fifo: v })} label="FIFO ordering" />
                  )}
                  {element.broker === "kafka" && (
                    <>
                      <Row label="partitions">
                        <input type="number" min={1} value={element.partitions ?? 1}
                          onChange={(e) => props.onChange({ partitions: Number(e.target.value) || 1 })}
                          className="mono text-[11px] bg-surface border border-border rounded px-2 py-1 outline-none w-24" />
                      </Row>
                      <Row label="cg">
                        <input value={element.consumerGroup ?? ""}
                          onChange={(e) => props.onChange({ consumerGroup: e.target.value })}
                          placeholder="processors"
                          className="mono text-[11px] bg-surface border border-border rounded px-2 py-1 outline-none flex-1" />
                      </Row>
                    </>
                  )}
                  {element.broker === "sqs" && (
                    <>
                      <Row label="visibility">
                        <input type="number" value={element.visibilityTimeoutSec ?? 30}
                          onChange={(e) => props.onChange({ visibilityTimeoutSec: Number(e.target.value) })}
                          className="mono text-[11px] bg-surface border border-border rounded px-2 py-1 outline-none w-24" />
                        <span className="text-[10px] text-muted-foreground ml-1">sec</span>
                      </Row>
                      <Row label="maxReceives">
                        <input type="number" value={element.maxReceives ?? 5}
                          onChange={(e) => props.onChange({ maxReceives: Number(e.target.value) })}
                          className="mono text-[11px] bg-surface border border-border rounded px-2 py-1 outline-none w-24" />
                      </Row>
                    </>
                  )}
                  {element.broker === "rabbitmq" && (
                    <>
                      <ToggleRow on={element.rabbitDurable !== false} onChange={(v) => props.onChange({ rabbitDurable: v })} label="durable" />
                      <Row label="ttl(ms)">
                        <input type="number" value={element.rabbitTtlMs ?? ""}
                          onChange={(e) => props.onChange({ rabbitTtlMs: e.target.value ? Number(e.target.value) : undefined })}
                          className="mono text-[11px] bg-surface border border-border rounded px-2 py-1 outline-none flex-1" />
                      </Row>
                      <Row label="maxLen">
                        <input type="number" value={element.rabbitMaxLength ?? ""}
                          onChange={(e) => props.onChange({ rabbitMaxLength: e.target.value ? Number(e.target.value) : undefined })}
                          className="mono text-[11px] bg-surface border border-border rounded px-2 py-1 outline-none flex-1" />
                      </Row>
                      <Row label="DLX">
                        <input value={element.rabbitDlx ?? ""}
                          onChange={(e) => props.onChange({ rabbitDlx: e.target.value })}
                          placeholder="dlx.exchange"
                          className="mono text-[11px] bg-surface border border-border rounded px-2 py-1 outline-none flex-1" />
                      </Row>
                      <Row label="DLRK">
                        <input value={element.rabbitDlrk ?? ""}
                          onChange={(e) => props.onChange({ rabbitDlrk: e.target.value })}
                          placeholder="dlq.routing.key"
                          className="mono text-[11px] bg-surface border border-border rounded px-2 py-1 outline-none flex-1" />
                      </Row>
                      <Row label="prefetch">
                        <input type="number" value={element.prefetch ?? 10}
                          onChange={(e) => props.onChange({ prefetch: Number(e.target.value) })}
                          className="mono text-[11px] bg-surface border border-border rounded px-2 py-1 outline-none w-24" />
                      </Row>
                    </>
                  )}
                  <Row label="retain(h)">
                    <input type="number" value={element.retentionHours ?? ""}
                      onChange={(e) => props.onChange({ retentionHours: e.target.value ? Number(e.target.value) : undefined })}
                      className="mono text-[11px] bg-surface border border-border rounded px-2 py-1 outline-none w-24" />
                  </Row>
                  <div className="flex gap-2 pt-1">
                    {!element.dlqId && (
                      <button onClick={props.onAddDlq}
                        className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20">
                        + DLQ
                      </button>
                    )}
                    {!element.retryQueueId && (
                      <button onClick={props.onAddRetry}
                        className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-warning/50 bg-warning/10 text-warning hover:bg-warning/20">
                        + Retry Queue
                      </button>
                    )}
                  </div>
                  {(element.dlqId || element.retryQueueId) && (
                    <div className="text-[10px] text-muted-foreground mono space-y-0.5">
                      {element.dlqId && <div>DLQ → {element.dlqId} (max receives: {element.maxReceives ?? 5})</div>}
                      {element.retryQueueId && <div>Retry → {element.retryQueueId} (delay: {element.retryDelayMs}ms)</div>}
                    </div>
                  )}
                </>
              )}
              {element.type === "topic" && (
                <>
                  <Row label="exchange">
                    <select
                      value={element.topicKind ?? "fanout"}
                      onChange={(e) => props.onChange({ topicKind: e.target.value as TopicKind })}
                      className="text-[11px] bg-surface border border-border rounded px-2 py-1 flex-1 outline-none"
                    >
                      {(["fanout", "direct", "topic", "headers", "pubsub"] as TopicKind[]).map((k) => (
                        <option key={k} value={k}>{k}</option>
                      ))}
                    </select>
                  </Row>
                  {element.broker === "kafka" && (
                    <>
                      <Row label="partitions">
                        <input type="number" min={1} value={element.partitions ?? 1}
                          onChange={(e) => props.onChange({ partitions: Number(e.target.value) || 1 })}
                          className="mono text-[11px] bg-surface border border-border rounded px-2 py-1 outline-none w-24" />
                      </Row>
                      <Row label="rep factor">
                        <input type="number" min={1} value={element.replicationFactor ?? 3}
                          onChange={(e) => props.onChange({ replicationFactor: Number(e.target.value) || 1 })}
                          className="mono text-[11px] bg-surface border border-border rounded px-2 py-1 outline-none w-24" />
                      </Row>
                      <Row label="cleanup">
                        <select value={element.cleanupPolicy ?? "delete"}
                          onChange={(e) => props.onChange({ cleanupPolicy: e.target.value as ArchElement["cleanupPolicy"] })}
                          className="text-[11px] bg-surface border border-border rounded px-2 py-1 flex-1 outline-none">
                          <option value="delete">delete</option>
                          <option value="compact">compact</option>
                        </select>
                      </Row>
                      <ToggleRow on={!!element.schemaContract} onChange={(v) => props.onChange({ schemaContract: v })} label="Schema registry" />
                    </>
                  )}
                  {(element.broker === "sns" || element.broker === "eventbridge") && (
                    <Row label="filter">
                      <input value={element.filterPolicy ?? ""}
                        onChange={(e) => props.onChange({ filterPolicy: e.target.value })}
                        placeholder='{"eventType":["OrderPlaced"]}'
                        className="mono text-[11px] bg-surface border border-border rounded px-2 py-1 outline-none flex-1" />
                    </Row>
                  )}
                  <BindingsEditor
                    el={element}
                    queues={queues}
                    onChange={(b) => props.onChange({ bindings: b })}
                  />
                </>
              )}
            </Section>
          )}

          {(element.type === "service" || element.type === "lambda" || element.type === "saga" || element.type === "stream") && (
            <Section title="Owns data stores">
              <DataStoresEditor el={element} dbs={dbs} onChange={(ids) => props.onChange({ dataStores: ids })} />
            </Section>
          )}

          <Section title="Contract">
            <Row label="contract">
              <select
                value={element.contractId ?? ""}
                onChange={(e) => props.onChange({ contractId: e.target.value || undefined })}
                className="text-[11px] bg-surface border border-border rounded px-2 py-1 flex-1 outline-none"
              >
                <option value="">— none —</option>
                {contracts.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} v{c.version}</option>
                ))}
              </select>
            </Row>
          </Section>

          <div className="pt-2 border-t border-border">
            <button onClick={props.onRemove}
              className="text-[11px] text-destructive hover:underline">
              Delete element
            </button>
          </div>
        </div>
      )}
      {tab === "contracts" && (
        <ContractsSection
          contracts={contracts}
          elements={elements}
          onAdd={props.onAddContract}
          onPatch={props.onPatchContract}
          onRemove={props.onRemoveContract}
        />
      )}
    </Shell>
  );
}

function Shell({ onClose, title, children }: { onClose: () => void; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <aside className="h-full w-[320px] shrink-0 border-l border-border bg-surface/70 backdrop-blur flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface-2/40">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground truncate">
          {title}
        </h2>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xs">✕</button>
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`text-[10px] uppercase tracking-wider px-3 py-2 border-b-2 transition-colors ${
        active ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5 pt-2 border-t border-border/60 first:border-t-0 first:pt-0">
      <div className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground">{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-[10px] uppercase tracking-wider text-muted-foreground w-20 shrink-0">{label}</label>
      <div className="flex-1 flex items-center gap-1 min-w-0">{children}</div>
    </div>
  );
}

function ToggleRow({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`w-full flex items-start gap-2 text-left p-1.5 rounded border transition-colors ${
        on ? "border-primary/50 bg-primary/10" : "border-border hover:border-border/80 bg-surface"
      }`}
    >
      <span className={`mt-0.5 w-3 h-3 rounded border ${on ? "bg-primary border-primary" : "border-muted-foreground"}`} />
      <span className="flex-1">
        <span className={`text-[11px] block ${on ? "text-primary" : "text-foreground"}`}>{label}</span>
        {hint && <span className="text-[9.5px] text-muted-foreground block leading-tight">{hint}</span>}
      </span>
    </button>
  );
}

function BindingsEditor({
  el, queues, onChange,
}: {
  el: ArchElement;
  queues: ArchElement[];
  onChange: (b: TopicBinding[]) => void;
}) {
  const bindings = el.bindings ?? [];
  function set(i: number, p: Partial<TopicBinding>) {
    onChange(bindings.map((b, idx) => idx === i ? { ...b, ...p } : b));
  }
  return (
    <div className="space-y-1 pt-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">bindings ({bindings.length})</span>
        <button onClick={() => onChange([...bindings, { queueId: queues[0]?.id ?? "", routingKey: "" }])}
          disabled={queues.length === 0}
          className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-border hover:border-primary/60 hover:text-primary disabled:opacity-40">
          + bind queue
        </button>
      </div>
      {bindings.map((b, i) => (
        <div key={i} className="flex items-center gap-1">
          <select value={b.queueId} onChange={(e) => set(i, { queueId: e.target.value })}
            className="mono text-[10px] bg-surface border border-border rounded px-1 py-0.5 outline-none flex-1 min-w-0">
            {queues.map((q) => (
              <option key={q.id} value={q.id}>{q.id}</option>
            ))}
          </select>
          {(el.topicKind === "direct" || el.topicKind === "topic" || el.topicKind === "headers" || !el.topicKind) && (
            <input value={b.routingKey ?? ""} onChange={(e) => set(i, { routingKey: e.target.value })}
              placeholder={el.topicKind === "topic" ? "order.*" : "key"}
              className="mono text-[10px] bg-surface border border-border rounded px-1 py-0.5 outline-none w-24" />
          )}
          <button onClick={() => onChange(bindings.filter((_, idx) => idx !== i))}
            className="text-muted-foreground hover:text-destructive text-[10px] px-1">✕</button>
        </div>
      ))}
    </div>
  );
}

function DataStoresEditor({
  el, dbs, onChange,
}: { el: ArchElement; dbs: ArchElement[]; onChange: (ids: string[]) => void }) {
  const list = el.dataStores ?? [];
  return (
    <div className="space-y-1">
      <button onClick={() => {
        const first = dbs.find((d) => !list.includes(d.id));
        if (first) onChange([...list, first.id]);
      }}
        disabled={dbs.length === 0 || list.length >= dbs.length}
        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-border hover:text-info hover:border-info/60 disabled:opacity-40">
        + bind store
      </button>
      {list.map((dsId, i) => (
        <div key={i} className="flex items-center gap-1">
          <select value={dsId} onChange={(e) => {
            const next = [...list]; next[i] = e.target.value; onChange(next);
          }}
            className="mono text-[10px] bg-surface border border-border rounded px-1 py-0.5 outline-none flex-1 min-w-0">
            {dbs.map((d) => <option key={d.id} value={d.id}>{d.id} · {d.dbEngine ?? d.type}</option>)}
          </select>
          <button onClick={() => onChange(list.filter((_, idx) => idx !== i))}
            className="text-muted-foreground hover:text-destructive text-[10px] px-1">✕</button>
        </div>
      ))}
    </div>
  );
}

function ContractsSection({
  contracts, elements, onAdd, onPatch, onRemove,
}: {
  contracts: Contract[];
  elements: ArchElement[];
  onAdd: () => void;
  onPatch: (id: string, p: Partial<Contract>) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="p-3 space-y-2">
      <button onClick={onAdd}
        className="w-full text-[11px] uppercase tracking-wider px-2 py-1.5 rounded border border-info/50 bg-info/10 text-info hover:bg-info/20">
        + New contract
      </button>
      {contracts.length === 0 && (
        <p className="text-[11px] text-muted-foreground italic">
          Contracts describe a message's schema, producer and consumers. Attach one to a topic, queue, or service to validate the flow.
        </p>
      )}
      {contracts.map((c) => (
        <div key={c.id} className="rounded border border-border bg-surface-2/50 p-2 space-y-1.5">
          <div className="flex items-center gap-1">
            <input value={c.name} onChange={(e) => onPatch(c.id, { name: e.target.value })}
              className="flex-1 bg-surface border border-border rounded px-1.5 py-0.5 text-[11px] outline-none" />
            <input value={c.version} onChange={(e) => onPatch(c.id, { version: e.target.value })}
              className="mono w-14 bg-surface border border-border rounded px-1.5 py-0.5 text-[10px] outline-none" />
            <button onClick={() => onRemove(c.id)} className="text-muted-foreground hover:text-destructive text-xs">✕</button>
          </div>
          <Row label="producer">
            <select value={c.producerId ?? ""} onChange={(e) => onPatch(c.id, { producerId: e.target.value || undefined })}
              className="mono text-[10px] bg-surface border border-border rounded px-1 py-0.5 outline-none flex-1">
              <option value="">— any —</option>
              {elements.filter((e) => e.type === "service" || e.type === "lambda" || e.type === "saga").map((e) => (
                <option key={e.id} value={e.id}>{e.id}</option>
              ))}
            </select>
          </Row>
          <textarea
            value={c.schema ?? ""}
            onChange={(e) => onPatch(c.id, { schema: e.target.value })}
            placeholder='{ "orderId": "string", "amount": "number" }'
            spellCheck={false}
            className="mono w-full bg-surface border border-border rounded px-1.5 py-1 text-[10px] outline-none resize-y min-h-[64px]"
          />
        </div>
      ))}
    </div>
  );
}
