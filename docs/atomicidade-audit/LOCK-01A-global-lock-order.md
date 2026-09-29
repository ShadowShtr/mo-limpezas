# LOCK-01A — contrato global de bloqueios financeiros

## Decisão

Escritores que alteram linhas existentes devem adquirir recursos nesta ordem:

1. validar argumentos que não dependem de estado mutável;
2. adquirir locks de linha na ordem de tabelas abaixo e por UUID crescente dentro de cada tabela;
3. descobrir nessas linhas estabilizadas **todos** os períodos afetados;
4. adquirir os advisory locks de período, únicos e ordenados por `AAAAMM`;
5. confirmar que todos os períodos estão abertos;
6. escrever e auditar na mesma transação.

Ordem de tabelas antes dos períodos:

1. `bank_statement_imports`;
2. `bank_transactions`;
3. `bank_reconciliation_matches`;
4. linhas de origem económica: `payroll_records`, `fixed_variable_payments`, `manual_charges`, `invoices`, `services`;
5. `cash_flow_entries`;
6. linhas dependentes/proveniência e auditoria.

Criações sem linha preexistente são a exceção explícita: o período conhecido pelos parâmetros vem primeiro e a constraint única arbitra inserções concorrentes. Um `upsert` bloqueia primeiro, por UUID, as linhas que já existem; se nenhuma existir, bloqueia o período antes do `INSERT`. Isso mantém o contrato original da migration 090 e evita redefinir writers que já o cumprem.

## Contradição observada no HEAD 113caa2

A migration 090 declara `linha → período → escrita`. As migrations efetivas não seguem uma ordem única:

| Família | Ordem atual relevante | Situação |
|---|---|---|
| Fechar/reabrir período | período; leituras simples; escrita | compatível com período primeiro |
| Caixa: criar | período; insert | período primeiro |
| Caixa: editar/apagar | caixa; período | linha primeiro |
| Cobrança manual | cobrança; período; caixa | linha primeiro; criação é período primeiro |
| Pagamentos | pagamento/proveniência/caixa; período | linha primeiro; criação é período primeiro |
| Faturas | fatura/caixa; período | linha primeiro; criação é período primeiro |
| Conciliação | transação; match; caixa; período | linha primeiro |
| Apagar importação | importação; períodos; cascata nas filhas | pai primeiro, filhas só na cascata |
| Pagamento de serviço | serviço; caixa; período | linha primeiro |
| Folha efetiva (096/100) | período; folha; caixa | período primeiro |

O menor conjunto seguro é alinhar as quatro funções efetivas da folha ao contrato da 090 e fazer a exclusão da importação bloquear as filhas antes do período. Os demais writers de linhas existentes já seguem linha → período.

## Escritores e cobertura

RPCs versionadas: 090–100 cobrem fecho, caixa manual, cobranças manuais, pagamentos, faturas, conciliação, pagamento de serviços e folha. As assinaturas públicas podem ser preservadas por `CREATE OR REPLACE` numa migration append-only.

Escritores runtime ainda fora do protocolo:

- `src/lib/bank-import/reconcile-db.ts`: cria e atualiza `bank_statement_imports`, insere `bank_transactions`, cria sugestões em `bank_reconciliation_matches` e altera o estado das transações em várias viagens;
- `generateSuggestions`/`recalcSuggestions` também escreve matches e estado bancário diretamente;
- `src/lib/payments-month-materialization.ts` contém insert direto, mas está em quarentena e sem consumidor, protegido por teste. Não deve ser reativado;
- atualizações de anexos em `fixed_variable_payments` são metadata e não mudam período/valor/estado. Continuam fora do protocolo económico e apenas podem esperar pela linha, sem adquirir período.

O guard `fin-period-writer-guard.test.ts` procura `.from("tabela").write()` na mesma linha. As cadeias multilinha da importação não são detectadas. Isso fica inventariado para FIN-04A/IMP-01B: não participa dos dois ciclos corrigidos aqui porque essas escritas diretas não adquirem advisory locks.

## Casos especiais obrigatórios

### Linhas inexistentes

Criação bloqueia primeiro os períodos conhecidos pelos parâmetros. `Upsert` bloqueia por UUID as linhas existentes e depois o período; quando a linha não existe, o período e a unicidade arbitram a criação.

### Mudança de período

A linha é bloqueada antes de ler a origem. Origem e destino formam o conjunto completo, adquirido em ordem canónica. Nenhum período é descoberto depois disso.

### Importação e cascata

Exclusão: importação pai → transações filhas por UUID → períodos das filhas → delete. O lock do pai impede novas filhas pela FK, e o lock das transações impede que ignore/rejeite/confirme atravesse a cascata. Matches não precisam de um lock preliminar separado: qualquer função que os altera bloqueia primeiro a transação bancária.

### Fecho concorrente

O writer estabiliza linhas e depois disputa o período; o fecho disputa apenas o período e faz leituras simples. Se o fecho vencer, o writer valida `closed` e recusa. Se o writer vencer, o fecho só calcula bloqueadores após o commit. Como o fecho nunca espera por linha, não fecha ciclo.

### Lotes

Períodos são únicos e crescentes. IDs são únicos e crescentes por tabela. Lotes recebidos em ordem inversa devem produzir a mesma sequência de locks.

## Matriz de regressão da LOCK-01B

| Cruzamento | Barreira | Resultado exigido |
|---|---|---|
| pagar folha × confirmar match do caixa salarial | uma sessão retida depois dos períodos | ambas terminam; sem `40P01`; uma saída; estados coerentes |
| repetir pagamento × confirmar/manual match | caixa já existente | idempotência; sem duplicação ou deadlock |
| apagar import × ignorar/rejeitar/confirmar filha | pai, filha e período em sessões distintas | sem `40P01`; exclusão ou operação filha serializa integralmente |
| apagar import multimensal × inserir filha | lote com meses invertidos | conjunto fechado ou `40001`; nenhuma filha órfã |
| fechar período × cada família de writer | fecho retido antes/depois do advisory | writer conclui antes do fecho ou recusa fechado |
| mover caixa entre meses × movimento inverso | origens/destinos opostos | locks crescentes; sem `40P01` |
| folha/import em lote invertido | IDs e meses inversos | mesma ordem efetiva; sem `40P01` |
| timeout/retry | cancelar cliente após envio | efeito único por constraints/idempotência |

Os testes devem usar duas conexões PostgreSQL reais, barreiras por `pg_stat_activity`/locks e `deadlock_timeout` curto. Não usar sleeps como prova nem carregar `.env`.

## Implementação delimitada para LOCK-01B

1. criar `108_financial_global_lock_order.sql`;
2. redefinir `adjust`, `upsert`, `approve` e `mark paid` efetivos da folha;
3. redefinir `delete_bank_import_atomic` para bloquear filhas por UUID antes dos períodos;
4. manter todas as assinaturas e ACL existentes;
5. adicionar regressões cruzadas PostgreSQL;
6. executar diff check, typecheck, lint estrito, testes, ensaios aplicáveis e build.

Rollout: migration expansiva primeiro, runtime compatível depois. Reversão de código é possível enquanto as assinaturas antigas permanecerem. Migration aplicada não deve ser apagada; qualquer correção de schema exige migration posterior. Nenhuma alteração foi aplicada à base da empresa nesta preparação.

## Prova no HEAD atual

Em PostgreSQL 17.11 descartável, dados fictícios e sem `.env`:

- folha × conciliação: conciliação terminou em `40P01`; repetição da folha terminou sem duplicar, com uma saída e folha `pago`;
- apagar importação × ignorar filha: ignorar terminou em `40P01`; exclusão concluiu;
- o contentor foi removido e o disco ficou com 197,5 GB livres.

Limite: a prova demonstra interleavings válidos e reproduzíveis; não mede frequência em produção. Writers ainda não lidos: **nenhum dentro das tabelas e consumidores delimitados acima**. Escritores de domínios não financeiros permanecem fora desta ficha.
