# MIG-01A — dono da transação do runner

Estado: implementada localmente pela MIG-01B. Nenhuma migration histórica foi editada.

## Decisão

O runner é o único dono da transação que aplica uma migration:

```text
preflight completo → BEGIN → SQL normalizado em memória → INSERT no ledger → COMMIT
```

O checksum continua calculado sobre o ficheiro original. O SQL guardado não é alterado.

## Compatibilidade histórica

O inventário `reports/migration-transaction-control.json` cobre todos os ficheiros diretamente elegíveis em `supabase/migrations/*.sql`. `draft/` e `rollback/` não são percorridos pelo runner.

Regenerar com `npm run audit:migration-transactions -- --output reports/migration-transaction-control.json`.

- `runner-owned`: nenhum comando transacional de topo; executar sem transformação.
- `legacy-outer-wrapper`: exatamente um `BEGIN` inicial e um `COMMIT` final; o runner remove somente esses dois statements da cópia em memória, com o analisador léxico testado, antes de enviar ao PostgreSQL.
- `unsupported-control`: qualquer outro `BEGIN`, `START TRANSACTION`, `COMMIT`, `ROLLBACK`, `SAVEPOINT` ou `RELEASE` de topo; recusar antes da primeira escrita.

Não usar regex: corpos PL/pgSQL, strings e comentários contêm palavras iguais. O analisador distingue delimitadores SQL e preserva o conteúdo entre eles.

## Preflight implementado

Antes de `ensureTracking`, backfill ou qualquer migration:

1. ler e classificar todas as migrations selecionadas;
2. recusar `unsupported-control`, ficheiro ilegível e wrapper incompleto;
3. validar checksums, bloqueios, `--only`, estado do ledger e drift;
4. só então iniciar mutações;
5. em falha antes da confirmação de `COMMIT`, tentar `ROLLBACK` e informar falha;
6. se a conexão cair durante `COMMIT`, devolver resultado incerto: não afirmar rollback nem repetir automaticamente. A reconciliação deve consultar ledger e assinatura de schema numa nova conexão.

`ensureTracking` e backfill também devem ocorrer depois do preflight. A frase “nada ficou a meio” só é válida quando o rollback foi confirmado.

## Bases existentes e backfill

- Linha com checksum presente: comparar com o ficheiro original, incluindo as exceções históricas já nomeadas.
- Linha com checksum nulo: calcular a partir do ficheiro original e atualizar somente depois de todo o preflight passar.
- Migration já aplicada: não executar nem normalizar; apenas validar o checksum.
- Schema materializado sem ledger: continuar bloqueado pelo mecanismo de drift/baseline; não inserir proveniência automaticamente.
- Base nova ou migration histórica pendente com wrapper exterior: usar a cópia normalizada em memória, mantendo o checksum do original.

## Provas executadas

1. strings, comentários, identificadores e dollar quotes não geram falsos positivos;
2. wrappers 071, 072, 073, 075 e 076 são reconhecidos sem editar esses ficheiros;
3. PostgreSQL 17.11 descartável: falha exclusiva do `INSERT public._migrations` na 075 preserva schema e ledger anteriores;
4. caminho feliz da 075 grava schema e checksum original juntos;
5. retry da 075 já aplicada consulta o ledger e não duplica;
6. controlo transacional intermédio é recusado antes de `ensureTracking`, backfill ou `BEGIN`;
7. cliente simulado que falha no `COMMIT` recebe `transactionState: UNKNOWN`, sem anúncio de rollback confirmado;
8. migration moderna 088 continua atómica no PostgreSQL real.

Usar `src/__tests__/helpers/pg-container.ts`, PostgreSQL fixo e contentor descartável. Nunca carregar `.env` nem ligar à base da empresa.

## Reversão desta preparação

Remover o analisador, o gerador, os testes, este documento e o relatório. Nenhum schema, dado ou comportamento produtivo foi alterado.
