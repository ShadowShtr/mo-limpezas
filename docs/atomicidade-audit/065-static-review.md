# Revisão estática do checkpoint 065

Status: evidência histórica consolidada. Não é runbook e não autoriza aplicação.

## Identidade preservada

- Caminho: `docs/atomicidade-audit/frozen/065_fix_domain_atomicity_outbox.sql`.
- SHA-256: `cb68199dce5ed90e0a1afde60cd47aef3891ad00c6033b23d8c8fff63a61383d`.
- Estado no ledger observado: ausente.
- Estado: congelado.

## Problemas que o checkpoint tentou resolver

- revisão obrigatória e idempotência de clientes/faturas;
- autorização antes de reutilizar recibo idempotente;
- proteção contra eliminação de cliente com histórico;
- sequência de eventos por empresa;
- outbox imutável;
- triggers de revisão consistentes;
- permissões de funções internas;
- publicação do outbox.

## Riscos confirmados na revisão

- mistura alterações aditivas e remoções incompatíveis;
- troca tipos em tabelas partilhadas;
- remove overloads que código anterior pode usar;
- transforma estruturas parciais existentes sem ledger correspondente;
- depende de índices, constraints e colunas específicas;
- testes estáticos não provam comportamento PostgreSQL, locks, RLS ou Realtime;
- ações locais passaram a depender de RPCs que ainda não pertencem ao baseline aprovado.

## Decisão atual

O checkpoint não será editado nem executado. Uma migration nova deve extrair somente alterações aditivas necessárias e seguir `docs/MIGRATIONS-RUNBOOK.md`.

Detalhes brutos da inspeção permanecem em:

- `schema-audit.json`;
- `schema-readonly-065-check.json`;
- `backup-restore-readiness.json`.
