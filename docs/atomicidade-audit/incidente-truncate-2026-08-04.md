# Investigação do incidente — grants perigosos expostos (TRUNCATE e outros)

Data: 2026-08-04. Leitura direta ao banco real (`SUPABASE_DB_URL`), sem
alterações. Pedido explícito do dono: tratar a exposição de `TRUNCATE`
encontrada no T03 como incidente de segurança já corrigido nas 2 tabelas do
outbox, mas potencialmente explorável no passado, e verificar se há outras
tabelas na mesma situação.

## 1. Evidência de exploração — não encontrada

- **`pg_stat_statements`** (ativo neste projeto): nenhum `TRUNCATE` registado
  contra `company_change_events`, `domain_mutations`, ou qualquer tabela de
  negócio. As únicas entradas de `TRUNCATE` encontradas são internas do
  Supabase (`TRUNCATE TABLE realtime.subscription` — manutenção normal do
  serviço Realtime, e a definição da função `realtime.apply_rls` que
  referencia a palavra `TRUNCATE` como um dos valores do enum
  `realtime.action`, não uma execução real).
- **`audit_logs`**: só 3 entradas relevantes, todas `client_deleted`, com
  `actor_id` de utilizadores reais, em `2026-06-26` e `2026-07-12` —
  consistente com uso normal da aplicação, nada suspeito.
- **`domain_mutations`/`company_change_events`**: confirmado (outra vez)
  `count(*) = 0` e `min(created_at)`/`max(created_at)` = `NULL` em ambas —
  nunca tiveram nenhuma linha, em nenhum momento capturado por nenhuma das
  auditorias desta investigação (incluindo a mais antiga, de antes desta
  sessão).
- **Conclusão**: não há evidência de que o `TRUNCATE` exposto tenha sido
  alguma vez executado, nem contra as tabelas do outbox nem contra
  qualquer outra tabela de negócio.

## 2. Por que a exploração via chave `anon` pública não era provável

Verificação direta ao catálogo do Postgres:

```text
anon           rolcanlogin=false
authenticated  rolcanlogin=false
authenticator  rolcanlogin=true   (role interna do PostgREST, sem exposição pública)
postgres       rolcanlogin=true, rolbypassrls=true
service_role   rolcanlogin=false, rolbypassrls=true
```

`anon` e `authenticated` **não conseguem abrir uma ligação direta ao
Postgres** — não têm `LOGIN`. O PostgREST autentica com a role interna
`authenticator` e faz `SET ROLE anon`/`SET ROLE authenticated` *depois* de
validar o JWT, dentro da própria ligação gerida pela Supabase. A API pública
(REST, cliente JS) nunca expõe um verbo `TRUNCATE` — só mapeia
GET/POST/PATCH/DELETE para SELECT/INSERT/UPDATE/DELETE. Não existe nenhuma
função neste schema que faça `TRUNCATE` dinâmico com privilégios do
chamador.

**Conclusão prática**: um utilizador com apenas a chave pública `anon` não
tinha, na prática, uma via direta para executar `TRUNCATE` através da
superfície pública normal da Supabase (REST/RPC). O grant era real e errado,
mas o vetor de exploração exigiria acesso direto à ligação Postgres com
credenciais que não são as da chave `anon` pública — um cenário de
comprometimento bem mais grave e não relacionado especificamente a este
grant. **Isto não substitui a correção já feita — só reduz a urgência de
tratar isto como "já fomos atacados" para "gap de defesa em profundidade
fechado a tempo".**

## 3. Achado novo, maior — grants perigosos em (quase) TODO o schema público

Pedido explícito: "pesquisar privilégios perigosos em todas as tabelas e
sequências, não apenas nessas duas." Resultado:

**528 linhas** de `information_schema.role_table_grants` com
`TRUNCATE`/`DELETE`/`INSERT`/`UPDATE`/`TRIGGER`/`REFERENCES` concedidos a
`anon` e/ou `authenticated`, cobrindo **essencialmente todas as tabelas do
schema `public`** — incluindo tabelas de negócio críticas
(`clients`, `contracts`, `services`, `invoices`, `payroll_records`,
`audit_logs`, `absences`, `timesheets`, `profiles`, `companies`,
`cash_flow_entries`, `bank_transactions`, etc.) e até **views** que nunca
deviam ter grants de escrita (`services_full`, `teams_with_members`,
`monthly_hours_summary`, `services_calendar_summary`,
`services_financial_private`, `services_mobile_collaborator`).

Sequências com `USAGE` concedido a `anon`/`authenticated`:
`company_change_events_sequence_seq`, `data_history_id_seq`,
`service_reference_seq`.

Isto é um padrão consistente com o comportamento por omissão do Postgres/
Supabase ao criar tabelas sem revogar explicitamente os privilégios
concedidos por omissão — **não é um erro isolado das migrations 064/065/066,
é sistémico em todo o histórico do projeto.**

### Risco real

- `SELECT`/`INSERT`/`UPDATE`/`DELETE`: mitigado por RLS **onde as policies
  estiverem corretas e completas** — não verificado tabela a tabela nesta
  investigação (é exatamente o que o plano de correção chama S01,
  "reescrever e testar matriz RLS").
- `TRUNCATE`: **nunca mitigado por RLS, em nenhuma tabela** — mas, pela
  mesma razão explicada na secção 2 (`anon`/`authenticated` sem `LOGIN`,
  API pública sem verbo TRUNCATE), não é diretamente explorável pela chave
  pública através da superfície normal da Supabase.
- Ainda assim, é uma violação clara do princípio de menor privilégio e deve
  ser corrigida — não é um problema "menor" só porque não encontrámos
  exploração.

### Isto está fora do escopo desta entrega (migration 066)

Corrigir isto exige uma auditoria e uma migration à parte, dedicada,
cobrindo todo o schema — não algo para misturar com a fundação do outbox.
Recomendo tratar como o próximo passo depois de resolvida a decisão sobre a
066, no mesmo padrão (escrever, rever, ensaiar com `BEGIN...ROLLBACK`,
autorização explícita antes de aplicar), mas como peça própria.

## 4. Chave `anon` pública

Confirmado: a chave `anon` ser pública é normal e esperado neste modelo
(está embutida em qualquer bundle de cliente). O problema nunca foi a chave
estar pública — foi o grant ao nível da tabela. Rodar a chave não substitui
a correção dos grants. Não há indício de abuso de credenciais mais
privilegiadas (`service_role`, `postgres`, `authenticator`) nesta
investigação — se algum dia houver essa suspeita, rotação dessas chaves
deve ser considerada nessa altura, não agora.

## 5. Resumo para decisão

- Sem evidência de exploração passada, nem nas 2 tabelas do outbox nem em
  mais nenhuma tabela.
- O vetor de exploração direto pela chave `anon` pública era pouco provável
  (sem `LOGIN`, sem verbo TRUNCATE na API pública).
- Mas o problema é muito maior do que as 2 tabelas corrigidas: praticamente
  todo o schema público tem os mesmos grants em excesso.
- Recomendação: tratar como item de segurança de prioridade alta, mas como
  entrega própria e separada — não misturar com a decisão sobre aplicar a
  066.
