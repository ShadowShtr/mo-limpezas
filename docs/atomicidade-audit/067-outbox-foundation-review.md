# Migration 067 — fundação do outbox — revisão completa

Data: 2026-08-04. Escrita, revista e ensaiada com `BEGIN...ROLLBACK`
diretamente na base real. **Não aplicada.** Escopo estritamente limitado à
fundação do outbox e às permissões relacionadas — nenhuma RPC de negócio
(`set_invoice_status_atomic`, `archive_client_atomic`,
`delete_empty_client_atomic`, `delete_client_atomic`) foi tocada.

## 0. Correção pós-revisão (2026-08-04, ronda 2)

Revisão externa encontrou uma corrida real em `record_company_change_event`:
duas chamadas concorrentes com o **mesmo** `mutation_id` podiam ambas passar
o `SELECT` sem encontrar nada (nenhuma tinha ainda cometido o `INSERT`),
ambas tentar `INSERT`, e a segunda falhar com violação de unicidade em vez
de devolver o evento idempotente da primeira — exatamente o cenário que
`lock_domain_mutation` (já existente na 067, mas sem chamador) foi desenhada
para prevenir. Corrigido: `record_company_change_event` agora chama
`PERFORM public.lock_domain_mutation(p_company_id, p_mutation_id)` **antes**
do `SELECT`, serializando chamadas com o mesmo `mutation_id`.

Revalidado: ensaio completo repetido (21/21, incluindo novo check estrutural
que confirma o lock vem antes do SELECT no corpo da função) e o rollback
(`067-rollback.sql`) re-testado com a versão corrigida — fingerprint
idêntico ao pré-067.

Ainda por fazer (só possível em staging, ver secção 4): prova empírica com
duas ligações reais simultâneas chamando `record_company_change_event` com
o mesmo `mutation_id`.

## 1. SQL final

`supabase/migrations/067_outbox_foundation.sql` (íntegro, committed). Resumo
por secção:

1. `company_sync_state` — nova tabela, RLS `FOR ALL USING (false)`, sem
   nenhum grant a `anon`/`authenticated`.
2. `next_company_sequence(company_id)` — `SECURITY DEFINER`,
   `SET search_path = public, pg_temp`, `SELECT ... FOR UPDATE` na linha da
   empresa, sem grants a `anon`/`authenticated`.
3. `domain_mutations` — acrescenta `operation`/`entity_id`/`request_hash`/
   `completed_at` (todas `NOT NULL` exceto `entity_id`), `CHECK (status IN
   ('succeeded','rejected'))`, `CHECK (operation ~ '^[a-z][a-z0-9_]*$')`.
   `REVOKE ALL` de `anon`/`authenticated` (mantém-se assim — já vinha da
   065).
4. `lock_domain_mutation`, `find_or_conflict_domain_mutation`,
   `complete_domain_mutation` — três funções novas, `SECURITY DEFINER`,
   sem grants a `anon`/`authenticated`. Nenhuma é chamada por código nesta
   fase — ficam prontas para a próxima fase (RPCs de negócio), não têm
   efeito nenhum sozinhas.
5. `company_change_events` — remove `IDENTITY` de `sequence`, adiciona
   `affected_from`/`affected_to` (`date`, com `CHECK` de coerência), remove
   `delivered_at` e `affected_range`, ajusta `UNIQUE` para
   `(company_id, sequence)` e `(company_id, mutation_id)`. `REVOKE ALL` de
   `anon`/`authenticated`, `GRANT SELECT` de volta só para `authenticated`.
6. `record_company_change_event` — recriada (assinatura muda:
   `p_affected_from date, p_affected_to date` em vez de
   `p_affected_range tstzrange`). Passa a devolver o evento existente tal
   como está em caso de replay — nunca `UPDATE`.
7. Publicação Realtime — `company_change_events` adicionada a
   `supabase_realtime`, condicionalmente (só se ainda não estiver lá),
   **depois** de todas as secções de RLS/grants acima, na mesma transação.

## 2. Diff estrutural (antes → depois, confirmado por leitura direta)

| Objeto | Antes (T03, 2026-08-04 16h) | Depois (ensaiado) |
| --- | --- | --- |
| `company_sync_state` | não existe | existe, RLS bloqueada, 0 grants |
| `domain_mutations` colunas | 7 (sem `operation`/`entity_id`/`request_hash`/`completed_at`) | 11 |
| `domain_mutations` CHECK status | `status = 'completed'` (inútil, valor único) | `status IN ('succeeded','rejected')` |
| `domain_mutations` grants anon/authenticated | 0 (já revogado pela 065) | 0 (inalterado) |
| `company_change_events.sequence` | `bigint IDENTITY BY DEFAULT` (sequência **global**) | `bigint` simples, preenchida por `next_company_sequence` (sequência **por empresa**) |
| `company_change_events` colunas | 12 (`affected_range`, `delivered_at`) | 12 (`affected_from`, `affected_to` — trocadas) |
| `company_change_events` UNIQUE | `(company_id, mutation_id, domain, event_type)` + `(company_id, sequence)` | `(company_id, sequence)` + `(company_id, mutation_id)` |
| `company_change_events` grants anon | 0 (já revogado pela 065) | 0 (inalterado) |
| `company_change_events` grants authenticated | `SELECT` (da 065) | `SELECT` (inalterado) |
| `record_company_change_event` | `ON CONFLICT ... DO UPDATE SET payload` (mutável) | sem `ON CONFLICT` — replay devolve o existente sem tocar em nada (imutável) |
| Publicação Realtime | só `notifications`, `services` | `+ company_change_events` |
| Funções novas | — | `lock_domain_mutation`, `find_or_conflict_domain_mutation`, `complete_domain_mutation` (nenhuma chamada ainda) |

## 3. Resultados das verificações — 21/21 (ronda 2, com o fix do lock)

Script: `scripts/rehearse-067-outbox-foundation.mjs`. Tudo dentro de uma
única transação `BEGIN...ROLLBACK` na base real; nada persistido.

| # | Verificação | Resultado |
| - | --- | --- |
| 1 | Migration executa sem erro | ✅ |
| 2 | `company_change_events` tem RLS ativa | ✅ |
| 3 | `anon` sem SELECT/INSERT/UPDATE/DELETE/TRUNCATE nas 3 tabelas | ✅ |
| 4 | `authenticated` tem exatamente `SELECT` em `company_change_events`, nada mais | ✅ |
| 5 | `next_company_sequence` devolve 1,2,3 em chamadas sucessivas | ✅ |
| 6 | `next_company_sequence` usa `SELECT ... FOR UPDATE` | ✅ |
| 7 | `UNIQUE (company_id, sequence)` existe | ✅ |
| 7b | `record_company_change_event` chama `lock_domain_mutation` ANTES do `SELECT` de idempotência | ✅ (novo, ronda 2) |
| 8 | Replay do mesmo `mutation_id` devolve o evento ORIGINAL sem alterar payload | ✅ |
| 9 | Replay não cria segunda linha | ✅ |
| 10 | `find_or_conflict_domain_mutation` devolve `NULL` na 1ª vez | ✅ |
| 11 | Replay com mesmo `request_hash` devolve o resultado gravado | ✅ |
| 12 | Mesmo `mutation_id` com `request_hash` diferente → `MUTATION_REUSE_CONFLICT` | ✅ |
| 13 | `operation` fora do formato é rejeitado pelo CHECK | ✅ |
| 14 | `affected_from > affected_to` é rejeitado pelo CHECK | ✅ |
| 15 | `company_change_events` está na publicação `supabase_realtime` | ✅ |
| 16 | **Utilizador A (authenticated, RLS real) só vê o evento da SUA empresa** | ✅ |
| 17 | **Utilizador B (authenticated, RLS real) só vê o evento da SUA empresa** | ✅ |
| 18 | **`anon` (sem sessão) recebe permission denied ao tentar SELECT** | ✅ |
| 19 | `authenticated` nem consegue SELECT em `domain_mutations` | ✅ |
| 20 | Fingerprint de grants idêntico antes/depois do `ROLLBACK` | ✅ |

Os itens 16-18 são o teste que realmente prova o isolamento pedido: dentro
da própria transação, cria-se 2 empresas e 2 utilizadores sintéticos
(`auth.users` + `profiles`), grava-se um evento por empresa via
`record_company_change_event`, depois assume-se `SET LOCAL ROLE
authenticated` + `set_config('request.jwt.claim.sub', <user_id>, true)` —
exatamente o mecanismo que `auth.uid()` lê — e corre-se a query **como esse
utilizador a correria de facto**, RLS incluído. Não é uma leitura da
definição da policy; é a policy a ser exercida a sério.

## 4. Riscos e limitações — honestos, não maquiados

- **Concorrência real entre duas ligações não foi testada
  empiricamente — exige staging.** Duas transações verdadeiramente
  simultâneas só conseguem ver o novo `next_company_sequence`/
  `record_company_change_event` depois de a migration estar committed —
  dentro de uma transação de ensaio (`BEGIN...ROLLBACK`), uma segunda
  ligação não vê o DDL ainda não confirmado. Testei a correção
  *sequencial* (3 chamadas seguidas devolvem 1,2,3) e confirmei
  estruturalmente `SELECT ... FOR UPDATE` e a ordem do
  `lock_domain_mutation` — mas não uma corrida real de duas ligações.
  Matriz de teste concreta (empresa nova com 2 ligações simultâneas,
  empresa existente com 20, empresas diferentes sem bloqueio cruzado,
  rollback não deixa estado órfão, mesmo `mutation_id` concorrente,
  `mutation_id` diferentes concorrentes, falha a meio reverte tudo) fica
  para o staging — ver `docs/ESTADO-ATUAL.md`, secção do portão de
  autorização.
- **A publicação Realtime só foi confirmada ao nível da base de dados.**
  Confirmei RLS + grants corretos e que `company_change_events` está na
  publicação `pg_publication_tables`. Não consegui confirmar o
  comportamento do *serviço* Realtime da Supabase (a camada fora do
  Postgres que lê o WAL e decide o que reenviar a cada subscritor) — isso
  exigiria uma ligação WebSocket real autenticada como dois utilizadores
  diferentes, fora do alcance de uma transação SQL. É um risco residual
  pequeno (o comportamento documentado da Supabase é respeitar RLS em
  `postgres_changes`), mas não é uma prova direta minha.
- **`domain_mutations`/`company_change_events` continuam vazias em
  produção.** As transformações de coluna foram seguras precisamente por
  isso (sem backfill). Se alguma escrita externa acontecer entre agora e
  a aplicação real, a migration tem um guarda explícito (`DO $$ ... RAISE
  EXCEPTION ... NOT_EMPTY ...`) que aborta tudo em vez de silenciosamente
  continuar — mas vale a pena confirmar de novo mesmo antes do `--apply`.
- **`lock_domain_mutation`, `find_or_conflict_domain_mutation`,
  `complete_domain_mutation` ficam sem nenhum chamador** até à próxima
  fase (RPCs de negócio a adotá-las). Isto é intencional — o pedido foi
  limitar esta entrega à fundação — mas significa que esta migration, por
  si só, não muda nenhum comportamento observável da aplicação. O valor
  dela é permitir a próxima fase sem mexer em schema outra vez.
- **`operation` usa um CHECK de formato (snake_case), não um enum
  fechado de operações de negócio conhecidas.** Decisão deliberada: como
  nenhuma RPC escreve aqui ainda, um enum fechado seria inventar nomes de
  operações que não existem como código. Cada RPC futura que passe a usar
  `domain_mutations` traz a sua própria migration — é o momento certo
  para decidir se vale a pena apertar para um enum fechado.

## 5. Só depois disto é que a aplicação em produção deve ser considerada

Conforme pedido — este documento existe precisamente para essa decisão
poder ser tomada com toda a informação em cima da mesa, não durante a
aplicação.
