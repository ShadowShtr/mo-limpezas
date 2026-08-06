# Inventário integral do repositório — Task T00

> Documento de **prova**, não de opinião. Nada aqui autoriza remover código.
> A remoção efetiva pertence à Task T17 e exige verificação manual item a item.

Fonte: [`../PLANO-MESTRE.md`](../PLANO-MESTRE.md), secção 21 (Task T00).

## Como reproduzir

```bash
npm run audit:code            # imprime o relatório em JSON
npm run audit:code:json       # grava em reports/code-audit.json
npm run audit:code:strict     # sai com código 1 se houver risco de confiança alta
```

Para confirmar o determinismo à mão:

```bash
npm run audit:code:json && cp reports/code-audit.json /tmp/first.json
npm run audit:code:json && diff /tmp/first.json reports/code-audit.json
```

O auditor **não** faz parte de `npm run quality`. É ferramenta de inventário; o
`audit:code:strict` só passa a gate depois de a Task T03 remover os artefactos
perigosos.

> ⚠️ Ao regenerar o relatório versionado, fazer `git add` **primeiro**. O
> inventário vem de `git ls-files --cached`, isto é, do índice — ficheiros
> novos ainda por adicionar não são contados, e o relatório sairia
> desatualizado em relação ao próprio commit que o acompanha:
>
> ```bash
> git add -A && npm run audit:code:json && git add -A
> ```

O auditor (`scripts/audit-codebase.mjs`) não instala dependências novas: usa o
compilador TypeScript já presente no projeto e o `git` para o inventário.

## Como o inventário é construído

| Etapa | Método | Porquê |
|---|---|---|
| Lista de ficheiros | `git ls-files` | O repositório é o que está versionado. Ficheiros ignorados (`backups/`, `.env*`, dados locais) não são código do projeto e distorciam contagens e duplicações. |
| Grafo de imports | TypeScript Compiler API | Cobre `import`, `export ... from`, `import()` dinâmico e `require()`. |
| Entradas de produção | Convenções do Next.js | `page/layout/route/loading/error/not-found/template/default` mais os ficheiros de metadata (`manifest`, `sitemap`, `robots`, ícones, imagens sociais), além de `proxy.ts`, `middleware.ts` e `instrumentation*.ts`. |
| Alcançabilidade | Travessia do grafo a partir das entradas | Um módulo não alcançado a partir de nenhuma entrada de produção é **candidato**, nunca conclusão. |
| Duplicações | SHA-256 do conteúdo | Só ficheiros com mais de 80 caracteres úteis; `package-lock.json` e mapas excluídos. |

## Resultado (2026-08-06)

`reports/code-audit.json` é **determinístico**: duas execuções seguidas sem
alterações no repositório produzem conteúdo idêntico, e o ficheiro versionado
tem de bater certo com a execução atual — há um teste que falha se não bater
(`src/__tests__/audit-codebase.test.ts`).

| Métrica | Commit base `11cdea7` | Atual |
|---|---:|---:|
| Ficheiros versionados | 446 | 456 |
| Ficheiros de texto analisados | 433 | 443 |
| Ficheiros TypeScript no programa | 297 | 298 |
| Linhas de texto | 88 058 | 95 575 |
| Entradas de produção Next.js | 71 | 71 |
| Diagnósticos TypeScript | 0 | 0 |
| Módulos de produção inalcançáveis | 4 | 4 |
| Grupos de ficheiros duplicados | 0 | 0 |
| Módulos de produção só alcançados por testes | 0 | 0 |

Os quatro candidatos a código morto e os quatro artefactos perigosos são
exatamente os mesmos nas duas medições: nada foi removido nem acrescentado.

`reports/` está fora do inventário — é saída gerada, não código. Contá-la
tornava o relatório entrada de si próprio.

## Categorias do relatório

`highConfidence` contém **apenas código de produção**. Uma chamada de risco
dentro de um teste vai para `reviewRequired`, com a sua própria categoria:

| Campo | Significado |
|---|---|
| `highConfidence.dangerousArtifacts` | Ficheiros capazes de destruir ou popular uma base real |
| `highConfidence.productionAdminClientInClientComponent` | `createAdminClient` num client component |
| `highConfidence.productionPublicSignupCalls` | `auth.signUp` em código de produção |
| `reviewRequired.testSignupCalls` | `auth.signUp` em testes — normalmente o **oposto** de um risco |

A distinção não é cosmética: `npm run audit:code:strict` falha com base em
`highConfidence`. Sem ela, o gate ficaria vermelho para sempre por causa de
`src/__tests__/tenant-isolation-hotfix.test.ts`, que é a suite a verificar que
o registo público está fechado.

## Matriz de classificação

Estados possíveis: **manter**, **centralizar**, **substituir**, **remover**,
**arquivar**, **standby**.

### Confiança alta — risco confirmado

| Item | Estado | Task | Nota |
|---|---|---|---|
| `supabase/APPLY_ALL.sql` | remover | T03 | Capaz de `DROP ... CASCADE` sobre uma base real. |
| `scripts/build-combined-sql.mjs` | remover | T03 | Reconstrói o `APPLY_ALL.sql`. |
| `CRIAR_PAGAMENTOS.sql` | remover | T03 | UUIDs fixos e lançamentos financeiros operacionais dentro do repositório. |
| `src/app/api/seed-demo/route.ts` | remover | T03 | Cria utilizadores Auth, clientes, faturas e salários com service role. |
| `src/__tests__/tenant-isolation-hotfix.test.ts` (`auth.signUp`) | manter | — | Não é risco: é um teste de isolamento que verifica precisamente que o registo público está fechado. Deixou de aparecer em `highConfidence` — passou para `reviewRequired.testSignupCalls`. |

### Candidatos a código morto — exigem verificação antes de remover

| Ficheiro | Estado | Verificação feita | Task |
|---|---|---|---|
| `src/lib/bank-import/xlsx.ts` | remover | Confirmado: `src/lib/bank-import/index.ts` documenta em comentário que deixou de ser chamado. Zero referências. | T17 |
| `src/lib/bank-import/pdf.ts` | remover | Mesma situação do `xlsx.ts`. Zero referências. | T17 |
| `src/app/actions/whatsapp.ts` | standby | Implementação da Meta Cloud API nunca ativada (decisão registada: usar `wa.me`). Remover só com decisão explícita do dono. | T17 |
| `src/types/supabase.ts` | standby | Tipos gerados. Podem ser necessários para reconciliar `src/types/database.ts` com o schema real (secção 11 do plano). Não remover antes da Task de tipos. | T17 |

### Centralizar — duplicação de regra, não de ficheiro

| Categoria | Ocorrências | Estado | Task |
|---|---:|---|---|
| `revalidatePath` chamado fora de um helper central | 24 actions | centralizar | T06 (`src/lib/revalidate-business.ts`) |
| Datas de negócio por `toISOString().slice(0,10)` / `.split("T")[0]` | 8 ficheiros | centralizar | T07 / T11 (`src/lib/lisbon-time.ts`) |

Ficheiros com risco de data, para registo:

```text
src/app/(app)/app/escala/page.tsx
src/app/actions/contratos.ts
src/app/actions/invoices.ts
src/app/actions/payroll.ts
src/app/api/cron/generate-services/route.ts
src/app/api/seed-demo/route.ts          (desaparece com a Task T03)
src/lib/bank-import/reconcile-db.ts
src/lib/payroll-calc.ts
```

O detetor sinaliza o **padrão**, não a incorreção. Alguns destes casos podem
já estar corretos (data em UTC deliberada). Cada um exige leitura individual —
é exatamente esse o ponto do inventário.

## Limites desta execução

O que este inventário **prova**:

- todos os ficheiros versionados foram lidos e contabilizados;
- o grafo de imports estáticos e dinâmicos foi construído a partir do AST real;
- o projeto compila sem diagnósticos TypeScript;
- não existem ficheiros duplicados byte a byte.

O que este inventário **não prova** (secção 3.2 do plano mestre):

- que os módulos inalcançáveis não são carregados por um script externo ao
  repositório, por CI/CD ou por um processo de produção;
- que os objetos de base de dados referidos pelo código existem no schema real;
- que os testes existentes provam comportamento (muitos são estáticos);
- qualquer conclusão sobre migrations, policies, triggers ou funções PostgreSQL.

## O que foi removido nesta task

Nada. T00 é inventário.

## Falsos positivos corrigidos no próprio auditor

A primeira execução produziu três resultados que eram defeitos do auditor, não
do código. Ficam registados para não voltarem:

1. `backups/` (ignorado pelo git, com dados reais de produção) entrava no
   inventário e gerava 18 grupos de duplicados e ~511 000 linhas fantasma →
   inventário passou a usar `git ls-files`.
2. `src/app/manifest.ts` aparecia como código morto → os ficheiros de metadata
   do Next.js passaram a contar como entradas por convenção.
3. Um diagnóstico `TS5074` sobre a opção `--incremental` era gerado pela forma
   como o auditor cria o programa, não pelo projeto → `incremental` é desligado
   nas opções passadas à API.
