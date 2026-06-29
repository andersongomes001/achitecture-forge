# Architecture Forge

**Architecture Forge** é um web app para *desenhar, simular e validar arquiteturas de
sistemas distribuídos*. Você monta a topologia num canvas estilo draw.io/Miro, descreve
fluxos como diagramas de sequência (Mermaid) e roda simulações que apontam riscos
(dual-write, falta de deduplicação, acoplamento síncrono, gargalos de carga, etc.).

## Principais recursos

- **Canvas híbrido (draw.io/Miro)**: arraste componentes, conecte em tempo real, linhas
  animadas (sólidas = síncrono, tracejadas = assíncrono). Componentes órfãos ficam com um
  ✕ até serem conectados.
- **Catálogo de componentes**: serviços, API Gateway, Lambda, scheduler, stream, saga,
  bancos de dados, brokers, tópicos e filas.
- **Mensageria realista**: RabbitMQ, SQS, SNS, Kafka, EventBridge — com particularidades
  (FIFO, DLQ, partições, schema registry, routing keys, exchange types, filtros).
- **Padrões prontos**: Transactional Outbox, Inbox, CQRS, Choreography Saga, Fan-out.
- **Bancos de dados**: engine (Postgres, Mongo, etc.), réplicas, write concern, isolamento.
- **Outbox/Inbox**: relays automáticos, destino de publicação e origem de consumo
  configuráveis; Inbox idempotente por padrão.
- **Diagramas de sequência**: gere a partir do canvas, edite em Mermaid, renderize e rode
  múltiplos cenários sobre a mesma infraestrutura.
- **Construtor visual**: monte a sequência clicando nos elementos ou inferindo a partir de
  um entry-point.
- **Simulação animada**: veja o dado trafegando; em caso de falha, o ponto é destacado com
  sugestões de correção.
- **Análise de carga**: estime RPS de APIs e taxas de mensagens; identifique gargalos.
- **Auto-layout (Beautify)**, legenda de cores/linhas, import/export JSON.

## Stack

- **TanStack Start** (React 19 + Vite 7), roteamento baseado em arquivos em `src/routes/`.
- **Tailwind CSS v4** via `src/styles.css`.
- **@xyflow/react** para o canvas.
- **mermaid** para diagramas de sequência.
- **shadcn/ui** (Radix) para componentes de interface.

## Desenvolvimento

### Local (requer Bun)

```bash
bun install
bun run dev      # servidor de desenvolvimento (Vite)
bun run build    # build de produção
bun run lint     # ESLint
```

### Docker (sem instalar nada na máquina)

```bash
# Dev com hot-reload
docker compose up -d

# Produção
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

# Parar
docker compose down
```

Acesse em `http://localhost:3000`. Para usar outra porta: `PORT=8080 docker compose up -d`.

## Estrutura

```text
src/
  routes/index.tsx          # app principal (canvas, inspector, cenários)
  components/arch/          # ArchCanvas, Inspector, MermaidView
  lib/arch/                 # núcleo do domínio (ver ARCHITECTURE.md)
  components/ui/            # shadcn/ui
```

Veja [ARCHITECTURE.md](./ARCHITECTURE.md) para detalhes do modelo de domínio e dos módulos.
