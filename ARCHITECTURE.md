# Architecture — Architecture Forge

Este documento descreve o modelo de domínio e os módulos principais do Architecture Forge.
A lógica de domínio vive em `src/lib/arch/`, separada da camada de apresentação
(`src/routes/index.tsx` e `src/components/arch/`).

## Visão geral

```text
┌─────────────────────────────────────────────────────────┐
│  src/routes/index.tsx  (orquestração / estado da app)     │
│   ├── components/arch/ArchCanvas.tsx   (canvas @xyflow)    │
│   ├── components/arch/Inspector.tsx    (edição de props)   │
│   └── components/arch/MermaidView.tsx  (render sequência)  │
└───────────────────────────┬─────────────────────────────┘
                            │ usa
┌───────────────────────────▼─────────────────────────────┐
│                     src/lib/arch/                         │
│  types · helpers · parser · import · generate             │
│  simulator · load · layout                                │
└─────────────────────────────────────────────────────────┘
```

## Modelo de domínio (`types.ts`)

Define o vocabulário da arquitetura:

- **ArchElement** — nó do canvas. Tipos incluem `service`, `api-gateway`, `lambda`,
  `scheduler`, `stream`, `saga`, `database`, `broker`, `topic`, `queue`, `outbox`, `inbox`,
  `relay`.
- **Propriedades de confiabilidade** — `idempotent`, `hasInbox`, `hasOutbox`,
  `outboxTargetIds`, `inboxSourceIds`, `publishesTo`, `consumesFrom`.
- **Mensageria** — `BrokerKind` (RabbitMQ, SQS, SNS, Kafka, EventBridge), `TopicKind`
  (fanout, direct, topic, etc.), `TopicBinding`, routing keys, FIFO, DLQ, partições, schema.
- **Banco de dados** — `dbEngine`, réplicas, write concern, nível de isolamento.
- **Carga** — `loadRps`, `capacityRps`.
- **Conexões/edges** — tipo de comunicação (sync, async, response, publish, subscribe,
  managed) usado para estilo e simulação.

## Módulos

| Módulo | Responsabilidade |
| --- | --- |
| `helpers.ts` | Criação/mutação de elementos e arestas gerenciadas (relay, inbox-store, DLQ/retry); regras derivadas (Inbox ⇒ idempotente). |
| `parser.ts` | Lê código Mermaid `sequenceDiagram` → identifica chamadas síncronas (`->>`), assíncronas (`-)`), respostas e notas. |
| `import.ts` | Infere componentes e conexões do canvas a partir de código Mermaid. |
| `generate.ts` | Converte o estado do canvas em código Mermaid `sequenceDiagram`. |
| `simulator.ts` | Valida o fluxo: dual-write, falta de deduplicação, acoplamento síncrono, falhas injetáveis, circuit breaker, contratos/schemas. |
| `load.ts` | Análise de capacidade: compara `loadRps` × `capacityRps` para apontar gargalos. |
| `layout.ts` | Auto-layout em camadas (longest-path por coluna + sweep barycenter) para o "Beautify". |

## Fluxo de uso

1. **Montar a topologia** no canvas (paleta → arraste → conecte).
2. **Configurar componentes** no Inspector (idempotência, outbox/inbox, broker, banco,
   carga, contratos).
3. **Definir cenários** — escreva/edite Mermaid, gere a partir do canvas, ou use o
   construtor visual (clicar passos ou inferir de um entry-point).
4. **Simular** — playback animado do dado; falhas destacadas com remediações sugeridas.
5. **Validar carga** — estimar RPS e detectar gargalos.
6. **Exportar/Importar** — JSON com elementos, arestas, cenários e Mermaid.

## Convenções

- Lógica de domínio é pura e testável em `src/lib/arch/`; nada de React lá.
- Tokens semânticos de cor/estilo vivem no design system (`src/styles.css`); componentes
  não usam cores hardcoded.
- Edge runtime (TanStack Start): evite APIs Node-only em código de servidor.
