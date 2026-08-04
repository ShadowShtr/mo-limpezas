# Atomicidade e sincronização - estado de implementação

Última consolidação: 4 de agosto de 2026.

## Decisão vigente

Os SQL 064/065 auditados são checkpoints, não migrations aprovadas. Foram movidos para `docs/atomicidade-audit/frozen/` e protegidos por hash em `supabase/migration-policy.json`.

Não alterar, aplicar, registrar nem publicar esses checkpoints.

## Por que foram congelados

O banco contém parte da estrutura descrita pelo 064, mas não contém registo 064 no ledger. A 065 tenta corrigir esse estado e, ao mesmo tempo:

- transforma tabelas de idempotência/outbox;
- troca tipos de revisão;
- remove overloads antigos;
- cria RPCs novas;
- muda permissões;
- ativa Realtime;
- recria triggers.

Esse conjunto é grande demais para ser aplicado como uma unidade sem reconciliação explícita.

## Estado comprovado

| Item | Estado observado |
|---|---|
| `_migrations` | 67 registos: 001-063 e quatro legadas |
| `schema_migrations` | vazio |
| 064 no ledger | ausente |
| 065 no ledger | ausente |
| `domain_mutations` | existe, estrutura parcial, sem linhas na captura |
| `company_change_events` | existe, estrutura parcial, sem linhas na captura |
| `company_sync_state` | ausente |
| outbox no Realtime | não publicado |
| `revision` | integer nas oito tabelas auditadas |
| RPCs cliente/fatura | versões parciais do estado 064 |

A evidência detalhada permanece nos JSONs de `docs/atomicidade-audit/`.

## Compatibilidade do código local

O trabalho local de clientes e faturas chama capacidades que só existem no checkpoint 065. Portanto:

- testes estáticos podem passar;
- TypeScript e build podem passar;
- o código não é compatível com o schema operacional aprovado;
- a branch não pode ser publicada nesse estado.

Erros devem permanecer visíveis e nunca usar a antiga exclusão destrutiva como fallback.

## Caminho de implementação

### A. Reconciliação read-only

1. capturar novamente tabelas, colunas, índices, constraints, triggers, funções, grants, policies e publicação;
2. comparar com `schema-readonly-065-check.json` e explicar qualquer diferença;
3. confirmar que tabelas de mutação/outbox continuam sem dados;
4. confirmar 064/065 ausentes do ledger;
5. gerar fingerprint pré-mudança.

### B. Nova migration aditiva

Criar um novo ficheiro classificado explicitamente em `activeMigrations`. Ele deve:

- adicionar estrutura necessária sem remover assinaturas usadas pelo código publicado;
- corrigir permissões de funções internas;
- criar sequência transacional por empresa;
- criar recibos idempotentes com hash da requisição;
- manter revisão esperada obrigatória;
- devolver resultados estruturados;
- não ativar funcionalidade até o código compatível estar pronto.

O novo SQL não deve ser cópia integral do checkpoint 065.

### C. Ensaio reversível

1. confirmar backup e recuperação;
2. pausar jobs;
3. abrir transação;
4. executar a migration aditiva;
5. validar funções, RLS, grants, triggers, contagens e locks;
6. terminar com rollback;
7. confirmar fingerprint inicial restaurado.

### D. Aplicação em ondas

1. aplicar fundação aditiva;
2. publicar código que reconhece schema antigo e novo;
3. testar com contas controladas;
4. ativar RPCs por domínio;
5. ativar outbox e sincronização;
6. monitorizar;
7. criar migration posterior para remoções, somente quando nenhum código antigo depender delas.

## Contratos e serviços

Ainda falta uma RPC transacional para criar/atualizar/arquivar contrato e reconciliar ocorrências. Ela deve incluir:

- `mutation_id` e hash;
- `expected_revision`;
- bloqueio da linha;
- identidade única de ocorrência;
- alocação de referência no banco;
- preservação de exceções;
- auditoria e outbox na mesma transação;
- snapshot autoritativo no retorno.

A compensação atual de apagar contrato após falha de geração reduz órfãos, mas não substitui transação real.

## Serviços e calendário

Reagendamento precisa verificar conflito e atualizar sob a mesma transação. Todas as mutações de serviço devem usar revisão e identidade de mutação. Escritas diretas no browser devem ser removidas.

## Realtime

O desenho aprovado usa outbox ordenado por empresa. O cliente deve:

- manter uma subscrição por empresa;
- detectar lacunas de sequência;
- recuperar eventos após reconexão;
- agrupar refreshes por escopo;
- descartar respostas de revisão inferior;
- limpar subscrição no logout/troca de empresa.

O simples facto de `company_change_events` existir não significa que Realtime esteja concluído.

## Critérios de conclusão

- migration nova classificada e aprovada;
- checkpoint 064/065 intacto e fora da pasta executável;
- preflight e ensaio reversível aprovados;
- branch compatível com o baseline real;
- testes de duas sessões para revisão e idempotência;
- RLS por papel e empresa;
- outbox ordenado e recuperação de lacunas;
- contratos/serviços transacionais;
- jobs idempotentes;
- nenhuma instrução histórica concorrente.

---

## Errata (2026-08-04)

`docs/atomicidade-audit/065-errata-explorabilidade-truncate.md` corrige uma
afirmação excessiva no comentário da migration 065 já aplicada (dizia que
"qualquer cliente com a chave anon podia apagar as duas tabelas" — a
investigação posterior confirmou que `anon`/`authenticated` não têm `LOGIN`
e a API pública não expõe `TRUNCATE`, logo não há via prática de exploração
conhecida). O ficheiro `065_revoke_public_grants_outbox_tables.sql`
**não foi editado** (já aplicado, com checksum no ledger) — a correção
fica só na errata.
