<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture Forge — guia para agentes

Web app para desenhar, simular e validar arquiteturas de sistemas distribuídos.
Veja `README.md` (visão geral) e `ARCHITECTURE.md` (modelo de domínio e módulos).

### Onde mexer

- **Lógica de domínio**: `src/lib/arch/` (types, helpers, parser, import, generate,
  simulator, load, layout). Mantenha puro/testável — sem React aqui.
- **Canvas**: `src/components/arch/ArchCanvas.tsx` (@xyflow/react).
- **Inspector**: `src/components/arch/Inspector.tsx` (edição de propriedades).
- **Sequências**: `src/components/arch/MermaidView.tsx` (render Mermaid).
- **Orquestração/estado**: `src/routes/index.tsx`.

### Regras

- TanStack Start: rotas em `src/routes/` (não criar `src/pages/`). Não editar
  `routeTree.gen.ts`.
- Tailwind v4 via `src/styles.css`; use tokens semânticos, sem cores hardcoded.
- Edge runtime: evite APIs Node-only em código de servidor.
- Use `bun` para scripts e instalação de dependências.
