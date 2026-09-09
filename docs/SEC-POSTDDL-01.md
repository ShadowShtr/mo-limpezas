# SEC-POSTDDL-01 — caracterização dos advisors de segurança

Investigação **read-only** sobre produção (`ceqzxgiz`), master `45f502cf`.
Nenhuma escrita, nenhuma migration aplicada, nenhuma alteração de grants.

As migrations 090..097 não foram tocadas nem são causa de nenhum destes achados.

---

## Resumo

| # | Finding | Classificação | Prioridade |
|---|---|---|---|
| 1 | `teams_with_members` corre como dona (RLS ignorado) | **INTRODUCED_RECENTLY — regressão da 087** | **P1** |
| 2 | 8 SECURITY DEFINER executáveis por `anon`/`authenticated` | PREEXISTING · 7 mitigadas, 1 por caracterizar | P2 |
| 3 | `search_path` mutável | PREEXISTING · risco real limitado a **1** função | P3 |
| 4 | 4 tabelas com RLS sem policy | **INTENTIONAL / fail-closed** | — |
| 5 | `btree_gist` no schema `public` | ACCEPTED_RISK | P5 |
| 6 | Leaked password protection desligada | VÁLIDO · fora do alcance de SQL | P4 |

Uma nota que atravessa tudo: **existe uma só empresa em produção** (`companies = 1`).
Isso não torna nenhum destes achados aceitável, mas muda o impacto de vários de
«fuga entre empresas» para «superfície latente» — e essa distinção é feita
abaixo, caso a caso, em vez de ser usada para desvalorizar o conjunto.

---

## P1 — `teams_with_members`: a 087 desfez a correção da 085

### O que se passa

A view não tem `security_invoker`. Corre com os privilégios da dona (`postgres`)
e portanto **ignora o RLS** de `teams`, `team_members` e `profiles` — que existe
e está correcto. `authenticated` tem `SELECT`.

### Porque é que isto é uma regressão, e não um problema antigo

A 085 (aplicada 2026-08-30) tratou exactamente disto, e o ficheiro diz porquê:

> `SET ROLE anon → SELECT public.teams_with_members → devolve linhas`

Ela fez duas coisas que **só funcionam juntas**:

```sql
ALTER VIEW public.teams_with_members SET (security_invoker = true);
REVOKE ALL PRIVILEGES ON public.teams_with_members FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.teams_with_members TO authenticated;
```

O grant a `authenticated` foi uma decisão medida, e a 085 escreveu-a: a página de
contratos lê a view pelo **cliente de sessão**, e com o `security_invoker` ligado
quem filtra as linhas passa a ser o RLS company-scoped.

A 087 (aplicada 2026-09-01) acrescentou `revision` e `membership_snapshot` à view
com `CREATE OR REPLACE VIEW`. **`CREATE OR REPLACE VIEW` preserva o ACL mas apaga
as `reloptions`.** Caiu a metade que tornava o grant seguro; ficou a metade
permissiva.

`monthly_hours_summary`, que a 085 tratou no mesmo passo e que a 087 não tocou,
continua correcta — `security_invoker=true`, sem `anon` nem `authenticated`. É a
prova de que a 085 funcionou e de que o que se perdeu foi perdido depois.

### Impacto real, sem dramatizar nem desvalorizar

- **`anon` não tem acesso.** O `REVOKE` da 085 sobrevive ao `CREATE OR REPLACE`.
  O incidente original **não** reabriu.
- **Entre empresas:** a view não filtra `company_id`; com o RLS fora de jogo,
  devolveria equipas de todas as empresas. Hoje há **uma só**, logo não há nada
  para atravessar. É superfície latente, e passa a exposição real no dia em que
  existir uma segunda empresa.
- **Dentro da empresa:** `profiles_select` é `id = get_my_profile_id() OR
  company_id = get_my_company_id()` — já permite ver os colegas. Ignorar o RLS
  não dá aqui nada que o RLS não desse.

**Classificação: VULNERABLE (latente) · INTRODUCED_RECENTLY.** Não há exposição
de dados hoje; há a garantia perdida.

### A correção não é uma linha

O óbvio seria `ALTER VIEW ... SET (security_invoker = true)`. Sozinho, **parte a
página de contratos**:

A view chama `permanent_membership_snapshot(t.company_id)` no seu SELECT, e o ACL
dessa função é `{postgres, service_role}` — `authenticated` **não tem EXECUTE**.
Hoje isso não se nota porque a view corre como dona. Com o invoker ligado, um
utilizador autenticado apanha `permission denied for function`.

É provável que o planner elimine a coluna (contratos pede só
`id, name, color, members`), mas depender disso é depender do planner.

A correção com as duas metades:

```sql
GRANT EXECUTE ON FUNCTION public.permanent_membership_snapshot(uuid) TO authenticated;
ALTER VIEW public.teams_with_members SET (security_invoker = true);
```

O grant é seguro: a função é `SECURITY INVOKER` (o RLS do chamador aplica-se),
`STABLE`, tem `search_path` fixo, e devolve um `md5` — não devolve PII.

Coerência do snapshot: é um token de concorrência, e o hash tem de bater entre
quem o calcula e quem o valida. As policies em jogo são todas company-scoped e
iguais para todos os papéis, por isso o conjunto lido é o mesmo e o hash bate.
Ainda assim, isto deve ser **provado contra PostgreSQL real com `SET ROLE`**
antes de qualquer aplicação, não deduzido daqui.

### Como impedir que volte

O modo de falha não é a view: é `CREATE OR REPLACE VIEW` apagar `reloptions`
sem aviso. Qualquer migration futura que recrie uma view repete isto.

`src/__tests__/public-surface-guard.test.ts` (nesta PR) fixa o estado esperado
de cada view do schema `public` e das funções expostas. A view entra lá com a
sua excepção declarada — e o teste falha no dia em que a excepção deixar de
corresponder ao código, tal como no `fin-period-writer-guard`.

---

## P2 — 8 SECURITY DEFINER executáveis por `anon`/`authenticated`

| Função | `search_path` | Notas |
|---|---|---|
| `get_my_company_id()` | `public` | usada dentro de policies |
| `get_my_role()` | `public` | usada dentro de policies |
| `get_my_profile_id()` | `public` | usada dentro de policies |
| `get_service_company_id(uuid)` | `public` | usada dentro de policies |
| `fn_capture_history()` | `public` | trigger |
| `fn_guard_location_rate()` | `public` | trigger |
| `handle_new_user()` | `pg_catalog, public` | trigger de auth |
| **`can_access_service(uuid)`** | **nenhum** | usada em policies de `services` |

As sete primeiras têm `search_path` fixo — o vector clássico de *hijacking* está
fechado. O `EXECUTE` a `authenticated` é **necessário**: são chamadas de dentro
de policies RLS, avaliadas com o papel do utilizador. Revogar partia o RLS.

`can_access_service` é a única sem `search_path`, e a 085 já a tinha adiado por
escrito, com a razão certa: *«revogar EXECUTE às cegas pode partir a avaliação de
RLS»*. Continua a ser esse o caso — a policy de `services` é
`USING (can_access_service(id))`.

**Classificação: PREEXISTING · 7 INTENTIONAL/mitigadas, 1 (`can_access_service`)
por caracterizar.** A correção dela é acrescentar `search_path`, nunca revogar o
EXECUTE.

---

## P3 — `search_path` mutável

O advisor reporta 32. A leitura directa dá **220** funções em `public` sem
`search_path` fixo — mas o número que importa é outro:

- SECURITY **DEFINER** sem `search_path`: **1** (`can_access_service`)
- destas, expostas a `anon`/`authenticated`: **1** (a mesma)

As restantes 219 são `SECURITY INVOKER`: correm com os privilégios de quem
chama, e um `search_path` manipulado não escala privilégio nenhum. É higiene, não
vulnerabilidade.

**Classificação: PREEXISTING · risco real reduzido a um único caso, que é o
mesmo do P2.**

---

## P4 — 4 tabelas com RLS activo e nenhuma policy

`app_notices` · `app_notice_targets` · `company_sync_state` · `data_history`

RLS ligado sem policies significa que `anon` e `authenticated` **não lêem nada**.
`service_role` faz bypass. Auditoria de callers: as quatro são acedidas
exclusivamente pelo cliente `admin` (service-role), nunca pelo cliente de sessão.

Isto é o comportamento pretendido, e é fail-closed. O advisor sinaliza o padrão
sem saber quem chama.

**Classificação: INTENTIONAL / ACCEPTED. Nenhuma acção.**

---

## P5 — `btree_gist` no schema `public`

A única extensão fora de `extensions` (`pgcrypto`, `uuid-ossp` e
`pg_stat_statements` estão lá; `supabase_vault` em `vault`).

Mover uma extensão de schema quebra objectos que dependem dela por nome
qualificado, e o ganho de segurança é marginal. O custo é maior do que o risco.

**Classificação: ACCEPTED_RISK.** Rever se alguma vez houver reinstalação limpa.

---

## P6 — Leaked password protection desligada

Definição do painel de Auth. Não é observável nem alterável por SQL, e mexer em
configuração de Auth de Production é gate de autorização próprio (AGENTS.md §1).

**Classificação: VÁLIDO · acção fora do alcance desta investigação.** Recomendo
ligar — protege contra credenciais já expostas em fugas conhecidas, sem custo
para quem usa palavras-passe próprias.

---

## O que esta investigação NÃO fez

Nenhuma escrita em produção. Nenhuma migration criada ou aplicada. Nenhum grant
alterado. Nenhum `SET ROLE` executado contra a base viva — a caracterização foi
feita por leitura de catálogo, e onde seria preciso exercer comportamento
(P1) isso está marcado como prova que **falta** fazer, em PostgreSQL descartável.
