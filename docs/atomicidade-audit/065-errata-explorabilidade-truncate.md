# Errata — migration 065, comentário sobre explorabilidade do TRUNCATE

Data: 2026-08-04. Este documento existe porque `65_revoke_public_grants_outbox_tables.sql`
**já foi aplicada em produção** (2026-08-04 16:47 UTC) e está registada em
`public._migrations` com checksum. Corrigir o ficheiro — mesmo só um
comentário — faria o SQL divergir do checksum aplicado, e enfraqueceria
exatamente a regra criada para detetar alterações posteriores a migrations
já executadas (ver `docs/MIGRATIONS-RUNBOOK.md`, regra 1: "não editar
migration já registada"). Por isso o ficheiro `065_revoke_public_grants_outbox_tables.sql`
**não foi alterado** — fica como registo histórico imutável do que se
sabia/pensava no momento em que foi escrito, com esta errata a
acompanhá-lo.

## O que o comentário original diz

```text
-- Ou seja: qualquer cliente com a chave anon podia apagar as duas tabelas
-- por completo, de todas as empresas, com um unico TRUNCATE.
```

## Correção

A concessão desse privilégio era real, incorreta, e precisava mesmo de ser
removida — RLS não protege `TRUNCATE`, isso continua verdade e é a razão
de a migration existir. **O SQL e a necessidade da correção continuam
válidos.**

O que estava excessivo foi a descrição do vetor de exploração. A
investigação posterior (`docs/atomicidade-audit/incidente-truncate-2026-08-04.md`)
confirmou, por leitura direta ao catálogo do Postgres:

- as roles `anon` e `authenticated` não têm `LOGIN` — não é possível abrir
  uma ligação direta ao Postgres com elas;
- a superfície REST normal da Supabase (PostgREST) não expõe nenhuma
  operação `TRUNCATE`;
- não existe, neste schema, nenhuma função que faça `TRUNCATE` dinâmico
  com os privilégios do chamador.

Portanto, **não foi identificada uma via prática de exploração usando
apenas a chave pública `anon`** através da superfície normal da Supabase.
A frase "qualquer cliente com a chave anon podia apagar as duas tabelas"
descreve um vetor que a investigação posterior concluiu não existir na
prática — deveria ter dito algo como "o grant permitia `TRUNCATE`, uma
operação que o RLS nunca cobre, embora não tenhamos identificado uma via
de exploração prática através da API pública normal."

## Onde isto está referenciado

- `docs/ESTADO-ATUAL.md` — secção "Achado adicional".
- `docs/ATOMICIDADE-IMPLEMENTACAO.md` — nota curta apontando para aqui.
- `docs/atomicidade-audit/incidente-truncate-2026-08-04.md` — já continha
  a investigação que fundamenta esta errata.
- `docs/MIGRATIONS-RUNBOOK.md` — nota curta sobre o precedente (correções
  a migrations aplicadas ficam sempre em errata separada, nunca editando
  o ficheiro).
