# LOCK-01A — contrato global de bloqueios financeiros

## Decisão

Todos os escritores financeiros devem adquirir recursos nesta ordem:

1. ler, sem bloqueio, uma fotografia dos IDs e de **todos** os períodos potencialmente afetados;
2. adquirir todos os advisory locks de período, únicos e ordenados por `AAAAMM`;
3. adquirir locks de linha na ordem de tabelas abaixo e por UUID crescente dentro de cada tabela;
4. reler e validar que IDs, datas, estado e conjunto de filhos continuam iguais à fotografia;
5. se a fotografia mudou, abortar com SQLSTATE `40001`; nunca acrescentar outro período depois do primeiro lock de linha;
6. confirmar que todos os períodos estão abertos;
7. escrever e auditar na mesma transação.

Ordem de tabelas depois dos períodos:

1. `bank_statement_imports`;
2. `bank_transactions`;
3. `bank_reconciliation_matches`;
4. linhas de origem económica: `payroll_records`, `fixed_variable_payments`, `manual_charges`, `invoices`, `services`;
5. `cash_flow_entries`;
6. linhas dependentes/proveniência e auditoria.

O lock de período vem primeiro porque é o único recurso comum a criações e `upsert`: uma linha ainda inexistente não admite `FOR UPDATE`. A fotografia e a revalidação resolvem o motivo pelo qual a migration 090 escolheu linha primeiro: a data pode mudar entre a leitura e o lock. Se mudar, a operação repete desde o início com o conjunto correto.

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

Assim, nenhuma escolha que altere apenas 095 ou 096 fecha o sistema. As funções que partilham linha de caixa e os caminhos de cascata precisam mudar no mesmo protocolo.

## Escritores e cobertura

RPCs versionadas: 090–100 cobrem fecho, caixa manual, cobranças manuais, pagamentos, faturas, conciliação, pagamento de serviços e folha. As assinaturas públicas podem ser preservadas por `CREATE OR REPLACE` numa migration append-only.

Escritores runtime ainda fora do protocolo:

- `src/lib/bank-import/reconcile-db.ts`: cria e atualiza `bank_statement_imports`, insere `bank_transactions`, cria sugestões em `bank_reconciliation_matches` e altera o estado das transações em várias viagens;
- a mesma função permite inserção de filha concorrente com `delete_bank_import_atomic`; a LOCK-01B deve mover a confirmação do import para uma RPC transacional que bloqueie períodos antes do pai e das filhas;
- `generateSuggestions`/`recalcSuggestions` escreve matches e estado bancário diretamente; deve entrar numa RPC ou ser explicitamente serializado pelo mesmo contrato;
- `src/lib/payments-month-materialization.ts` contém insert direto, mas está em quarentena e sem consumidor, protegido por teste. Não deve ser reativado;
- atualizações de anexos em `fixed_variable_payments` são metadata e não mudam período/valor/estado. Continuam fora do protocolo económico e apenas podem esperar pela linha, sem adquirir período.

O guard `fin-period-writer-guard.test.ts` procura `.from("tabela").write()` na mesma linha. As cadeias multilinha da importação não são detectadas. A LOCK-01B deve corrigir o detector e inventariar exceções por operação, não apenas por ficheiro.

## Casos especiais obrigatórios

### Linhas inexistentes

Criação e `upsert` bloqueiam primeiro os períodos conhecidos pelos parâmetros. A unicidade arbitra a linha concorrente. Depois do conflito, a função relê o estado e aplica as mesmas regras; não tenta bloquear uma linha inexistente antes do período.

### Mudança de período

A fotografia inclui origem e destino. Depois dos locks de período, a linha é bloqueada e a data original é comparada. Divergência gera `40001`. É proibido descobrir e adquirir um terceiro mês nessa fase.

### Importação e cascata

Confirmação: períodos do lote completos → importação pai → transações por UUID → matches. Exclusão: fotografia das datas/filhas → períodos → pai `FOR UPDATE` → filhas por UUID → matches por UUID → revalidação → delete. A inserção de filha deve participar da RPC do import e bloquear o pai depois dos períodos; sem isso, o conjunto de filhas não é fechável.

### Fecho concorrente

Fecho e writers disputam primeiro o mesmo período. Se o fecho vencer, o writer valida `closed` e recusa. Se o writer vencer, o fecho só calcula bloqueadores após o commit. O fecho não precisa de `FOR UPDATE` nas tabelas económicas.

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
2. corrigir o comentário/contrato da 090 por `COMMENT ON FUNCTION` e redefinir somente helpers necessários, sem editar migration histórica;
3. redefinir em conjunto as funções efetivas que misturam linha e período: caixa, cobranças, pagamentos, faturas, conciliação, serviço e folha;
4. criar RPC atómica de confirmação do import e RPC/lote de sugestões, preservando respostas do runtime;
5. manter assinaturas existentes; funções novas entram antes da alteração do runtime;
6. adicionar regressão cruzada PostgreSQL e fortalecer o inventário de writers multilinha;
7. executar diff check, typecheck, lint estrito, testes, ensaios aplicáveis e build.

Rollout: migration expansiva primeiro, runtime compatível depois. Reversão de código é possível enquanto as assinaturas antigas permanecerem. Migration aplicada não deve ser apagada; qualquer correção de schema exige migration posterior. Nenhuma alteração foi aplicada à base da empresa nesta preparação.

## Prova no HEAD atual

Em PostgreSQL 17.11 descartável, dados fictícios e sem `.env`:

- folha × conciliação: conciliação terminou em `40P01`; repetição da folha terminou sem duplicar, com uma saída e folha `pago`;
- apagar importação × ignorar filha: ignorar terminou em `40P01`; exclusão concluiu;
- o contentor foi removido e o disco ficou com 197,5 GB livres.

Limite: a prova demonstra interleavings válidos e reproduzíveis; não mede frequência em produção. Writers ainda não lidos: **nenhum dentro das tabelas e consumidores delimitados acima**. Escritores de domínios não financeiros permanecem fora desta ficha.
