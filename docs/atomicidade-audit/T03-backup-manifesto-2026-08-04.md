# T03 — Backup e fingerprint do Supabase existente

Data: 2026-08-04. Executado por leitura direta ao projeto Supabase ligado
(via `SUPABASE_DB_URL` — ligação Postgres direta — e a service role key),
sem alterar nenhum dado nem schema. Nenhum `INSERT`/`UPDATE`/`DELETE`/DDL foi
executado nesta etapa.

## O que foi feito

1. `node scripts/schema-inventory.mjs` (novo, só `SELECT`) →
   `docs/atomicidade-audit/schema-inventory-2026-08-04.json` — snapshot
   estrutural: ledger de migrations, colunas/triggers de `revision`, funções
   `SECURITY DEFINER`, grants de funções, estado de RLS, policies, extensões,
   publicação Realtime, contagens por tabela, utilizadores Auth, buckets de
   Storage, contagem de foreign keys.
2. `node scripts/backup-all.mjs t03-2026-08-04` → `backups/t03-2026-08-04/`
   (pasta local, `.gitignore`d, **não commitada**) — export de dados
   aplicacionais em CSV+JSON por tabela, via service role (ignora RLS,
   apanha tudo).
3. `sha256sum` de cada ficheiro do backup →
   `docs/atomicidade-audit/backup-file-hashes-t03-2026-08-04.sha256`.
4. Comparação programática entre as contagens do inventário (passo 1) e do
   manifesto do backup (passo 2): **sem divergência** — as duas leituras
   bateram exatamente, apesar de terem sido feitas em momentos ligeiramente
   diferentes.

## Cobertura real vs. o que o T03 pede

| Item pedido pelo T03 | Estado |
| --- | --- |
| Dump de schema e dados | Dados: sim (CSV+JSON aplicacional). Schema: **parcial** — inventariado por SQL read-only (tabelas/colunas/constraints/funções/triggers/policies/extensões), não um `pg_dump` binário/SQL restaurável, porque não há `pg_dump`/`psql` instalados neste ambiente. |
| Inventário de Auth/Storage/policies/funções/triggers/extensões/Realtime | Feito — ver secção "Fingerprint" abaixo. |
| Confirmar retenção/PITR do plano Supabase | **Não feito por mim** — exige acesso ao painel Supabase (Settings → Billing / Database → Backups), que não tenho. Pedido em separado ao dono. |
| Confirmar como uma restauração/PITR seria pedida | Idem — depende do plano contratado, só visível no painel. |
| Validar o dump sem importar | Feito — checksums gerados por ficheiro; contagens do manifesto conferidas contra o inventário SQL independente. |
| Validar contagens/FKs/utilizadores/buckets/funções na origem | Feito — tudo por consulta `SELECT` direta (não a partir do próprio backup). |
| Manifesto com data/projeto/checksums | Este documento + `_MANIFEST.json` do backup + ficheiro de hashes. |

## Fingerprint (2026-08-04, ~16:10 UTC)

- **Ledger `public._migrations`**: 67 migrations registadas (001-063 numeradas
  + 4 legadas com prefixo de data) — coincide exatamente com
  `supabase/migration-policy.json.activeMigrations`.
- **Colunas `revision`**: `clients`, `contracts`, `invoice_items`, `invoices`,
  `locations`, `services`, `team_members`, `teams` (8 tabelas).
- **Triggers de `revision`**: 34 (mais que 1 por tabela nalguns casos — a
  auditoria anterior já tinha detetado isto; a 065 congelada endereça a
  normalização para 1 trigger canónico por tabela, mas não está aplicada).
- **Funções `SECURITY DEFINER`**: 14. Três delas estão concedidas a
  `anon`/`authenticated`/`PUBLIC` **em produção, agora**:
  `record_company_change_event`, `delete_client_atomic`,
  `set_invoice_status_atomic`. Confirma exatamente o achado da investigação
  anterior (não é suposição — foi lido diretamente do catálogo do Postgres).
  As restantes `SECURITY DEFINER` (`get_my_company_id`, `get_my_role`,
  `get_service_company_id`, `handle_new_user`, `fn_capture_history`,
  `fn_guard_location_rate`, `can_access_service`,
  `delete_calendar_service_safe`, `archive_expired_documents`,
  `get_documents_to_archive`, `detect_schedule_conflicts`) parecem
  intencionais (helpers de RLS/trigger de auth), mas não foram auditadas
  campo a campo nesta etapa.
- **RLS desativado**: só `_migrations` (tabela interna de tooling, esperado).
  Todas as tabelas de negócio têm RLS ativo.
- **Policies**: 84 no schema `public`.
- **Extensões**: `btree_gist`, `pg_stat_statements`, `pgcrypto`, `plpgsql`,
  `supabase_vault`, `uuid-ossp`.
- **Publicação Realtime (`supabase_realtime`)**: só `notifications` e
  `services`. `company_change_events` **não está publicada** — confirma que
  a sincronização por outbox está desligada, mesmo com a tabela já a existir
  parcialmente.
- **Auth**: 30 utilizadores.
- **Storage**: 3 buckets privados (`collaborator-documents`,
  `payment-attachments`, `service-photos`), nenhum público.
- **Foreign keys**: 94 no schema `public`.
- **Contagens por tabela**: ver `docs/atomicidade-audit/schema-inventory-2026-08-04.json`
  (`tableCounts`) — coincidem com `backups/t03-2026-08-04/_MANIFEST.json`.

## Achado corrigido nesta etapa

`scripts/backup-all.mjs` **não incluía `building_cards` (146 registos reais —
feature de Prédios) nem `data_history` (490 registos — a rede de segurança de
auditoria)** na lista de tabelas. Um backup "completo" anterior
(`atomicidade-pre-064`) tinha exatamente a mesma lacuna. Corrigido a lista de
tabelas do script; o backup `t03-2026-08-04` já inclui as duas (146 + 490
registos, confirmados contra o inventário SQL independente).

## Limitações assumidas (honestas, não maquiadas)

- Este backup **não é um dump operacional completo** — não inclui schema,
  funções, triggers, RLS nem histórico de migrations em formato restaurável;
  é um export de dados aplicacionais. O inventário SQL (passo 1) cobre a
  parte estrutural por leitura, mas não é um `pg_dump -s` reproduzível.
- **Não foi feito ensaio de restauro** — nem em base limpa (sem instância
  Postgres descartável disponível neste ambiente), nem confirmação de PITR
  no Supabase (sem acesso ao painel).
- Continua a não haver evidência local de qual ambiente aplicou
  originalmente os objetos parciais da 064 — a suspeita registada
  anteriormente (SQL corrido manualmente fora do fluxo `_migrations`)
  mantém-se sem confirmação adicional.

## Pendente — só o dono pode confirmar

- Confirmar no painel Supabase (Settings → Billing) qual o plano contratado
  e se inclui PITR (Point-in-Time Recovery), e por quantos dias.
- Confirmar em Database → Backups qual o procedimento exato para pedir uma
  restauração e qual o ponto de recuperação mais recente disponível.

## Ficheiros produzidos nesta etapa

```text
docs/atomicidade-audit/schema-inventory-2026-08-04.json
docs/atomicidade-audit/backup-file-hashes-t03-2026-08-04.sha256
docs/atomicidade-audit/T03-backup-manifesto-2026-08-04.md   (este ficheiro)
backups/t03-2026-08-04/                                      (local, não commitado)
scripts/schema-inventory.mjs                                 (novo, read-only)
scripts/backup-all.mjs                                        (corrigido: +building_cards +data_history)
```
