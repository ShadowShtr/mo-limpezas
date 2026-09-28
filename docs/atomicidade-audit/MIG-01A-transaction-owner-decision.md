# MIG-01A — dono da transação do runner

Estado: decisão pronta para implementação. Esta etapa não muda o comportamento do runner.

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
- `legacy-outer-wrapper`: exatamente um `BEGIN` inicial e um `COMMIT` final; MIG-01B deve remover somente esses dois statements da cópia em memória, com o analisador léxico testado, antes de enviar ao PostgreSQL.
- `unsupported-control`: qualquer outro `BEGIN`, `START TRANSACTION`, `COMMIT`, `ROLLBACK`, `SAVEPOINT` ou `RELEASE` de topo; recusar antes da primeira escrita.

Não usar regex: corpos PL/pgSQL, strings e comentários contêm palavras iguais. O analisador distingue delimitadores SQL e preserva o conteúdo entre eles.

## Preflight obrigatório de MIG-01B

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

## Provas exigidas em MIG-01B

1. unidade: strings, comentários, identificadores e dollar quotes não geram falsos positivos;
2. unidade: wrappers 071, 072, 073, 075 e 076 são reconhecidos sem editar esses ficheiros;
3. PostgreSQL descartável: forçar falha exclusiva do `INSERT public._migrations` após executar a 075; schema e ledger permanecem no estado anterior;
4. PostgreSQL descartável: caminho feliz da 075 grava schema e checksum juntos;
5. preflight: controlo transacional intermédio recusa sem `CREATE`, `ALTER`, `UPDATE`, `BEGIN` ou ledger;
6. resultado incerto: cliente simulado perde a ligação no `COMMIT` e o runner não anuncia rollback confirmado.

Usar `src/__tests__/helpers/pg-container.ts`, PostgreSQL fixo e contentor descartável. Nunca carregar `.env` nem ligar à base da empresa.

## Reversão desta preparação

Remover o analisador, o gerador, os testes, este documento e o relatório. Nenhum schema, dado ou comportamento produtivo foi alterado.
