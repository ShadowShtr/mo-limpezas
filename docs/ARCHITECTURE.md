# Arquitetura — Mó Limpezas

Descreve como uma alteração atravessa o sistema, do clique do utilizador até ao
ecrã de outro utilizador. Complementa o
[padrão de engenharia](ENGINEERING-STANDARD.md), que diz **como** escrever;
este documento diz **onde** cada coisa vive.

Origem: Task T01 e secção 17 do [plano mestre](PLANO-MESTRE.md).

---

## Fluxo de uma mutação

```text
Interface
  ↓
Server Action fina
  ↓
Autenticação central          (src/lib/auth-guard.ts)
  ↓
Validação                     (Zod)
  ↓
Caso de uso                   (src/application/*)
  ↓
Regra de domínio              (src/domain/*)
  ↓
RPC transacional              (supabase/migrations)
  ou repositório de leitura   (src/infrastructure/supabase)
  ↓
Auditoria + Outbox            (dentro da mesma transação)
  ↓
Snapshot autoritativo
  ↓
Revalidação de cache          (src/lib/revalidate-business.ts)
  ↓
Realtime
  ↓
Outros utilizadores
```

Cada seta é uma fronteira. Saltar uma fronteira — por exemplo, uma action que
calcula recorrência, ou um componente que divide uma avença — é o defeito que o
plano mestre existe para eliminar.

## Camadas

| Camada | Sabe sobre | Não sabe sobre |
|---|---|---|
| `src/domain` | Regras de negócio puras | Supabase, React, HTTP, relógio do sistema |
| `src/application` | Casos de uso, orquestração | JSX, detalhes de SQL |
| `src/infrastructure` | Supabase, storage, serviços externos | Regras de negócio |
| `src/app/actions` | Adaptação entre interface e caso de uso | Cálculo, recorrência, compensação |
| `src/components` | Apresentação e interação | Fórmulas de negócio |

## Estrutura de diretórios

```text
src/
├── app/
│   ├── actions/          adaptadores finos
│   ├── (dashboard)/      interface de gestão
│   ├── (app)/            PWA das colaboradoras
│   └── api/              rotas HTTP e crons
├── domain/
│   ├── scheduling/       recorrência e ocorrências
│   ├── billing/          avenças, IVA, alocação mensal
│   ├── contracts/
│   ├── finance/
│   └── shared/
├── application/
│   ├── contracts/
│   ├── billing/
│   ├── clients/
│   └── finance/
├── infrastructure/
│   └── supabase/
├── lib/
│   ├── action-result.ts       formato único de resultado das actions
│   ├── auth-guard.ts          autenticação e autorização central
│   ├── critical-fields.ts
│   ├── lisbon-time.ts         datas de negócio em Europe/Lisbon
│   └── revalidate-business.ts revalidação de cache por escopo
└── types/
```

> Estado atual: `src/domain`, `src/application` e `src/infrastructure` ainda não
> existem por completo. São criados **por área**, à medida que cada task do plano
> mestre toca essa área. Não há uma migração em bloco — ver secção 17 do plano.

## Regras de fronteira

1. Uma regra vive num módulo só. Duplicá-la é um defeito, mesmo que os dois
   sítios estejam corretos hoje.
2. Escrita em mais de uma tabela é transação na base, não sequência de queries
   na action.
3. Quem apresenta não calcula; quem calcula não apresenta.
4. Nenhuma camada confia em `company_id` ou `role` vindos do cliente.
5. Datas de negócio nascem em Lisboa, não no fuso do processo.

## Módulos centrais e o que cada um resolve

| Módulo | Regra única |
|---|---|
| `src/domain/scheduling/recurrence-engine.ts` | Que datas um contrato gera |
| `src/lib/service-value.ts` | Quanto vale um serviço |
| `src/domain/billing/monthly-allocation.ts` | Como se distribui uma avença mensal |
| `src/lib/lisbon-time.ts` | O que é "hoje" e "este mês" |
| `src/lib/auth-guard.ts` | Quem é o ator e o que pode fazer |
| `src/lib/revalidate-business.ts` | Que páginas invalidar após uma mutação |
| `src/lib/action-result.ts` | Que forma tem o resultado de uma action |

Antes de escrever uma regra nova, procurar nesta tabela. Se já existe, reutiliza,
corrige e centraliza — não cria uma segunda versão.

## Base de dados

- migrations em `supabase/migrations`, **append-only**, numeradas;
- aplicadas pelo runner seguro (`scripts/run-migrations.mjs`): sem argumentos é
  dry-run, escrita exige `--apply` e confirmação explícita do projeto;
- RLS por `company_id` em todas as tabelas;
- mutações que tocam várias tabelas passam por RPC com `mutation_id` e
  `expected_revision`;
- auditoria e outbox gravam dentro da transação da mutação.

Procedimento operacional de deploy, rollback e resposta a incidentes:
[`PRODUCTION-RUNBOOK.md`](PRODUCTION-RUNBOOK.md).

## Hierarquia documental

Por ordem de precedência:

1. [`../AGENTS.md`](../AGENTS.md) — REGRA ZERO, segurança de produção;
2. [`PRODUCTION-RUNBOOK.md`](PRODUCTION-RUNBOOK.md) — operação de produção;
3. [`ARCHITECTURE.md`](ARCHITECTURE.md) — este documento, onde vive cada coisa;
4. [`ENGINEERING-STANDARD.md`](ENGINEERING-STANDARD.md) — como implementar;
5. [`PLANO-MESTRE.md`](PLANO-MESTRE.md) — o trabalho planeado e a sua ordem;
6. [`../CLAUDE.md`](../CLAUDE.md) — estado atual e histórico de sessões;
7. restantes documentos — histórico e consulta.

Uma regra ativa não deve aparecer em mais do que um destes documentos. Quando
aparecer, o documento de precedência mais alta é o verdadeiro e o outro passa a
remeter para ele.
