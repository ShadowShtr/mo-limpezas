# Mapeamento do ledger `public._migrations` vs. EOL dos ficheiros — 2026-08-05

Evidência que motivou o bloqueio da PR #27 (`fix/gitattributes-migration-checksums`) e a
correção mínima aplicada ao runner (`scripts/run-migrations.mjs`, `scripts/lib/migration-checksum.mjs`).

Dados brutos em [`migration-checksum-map-2026-08-05.json`](./migration-checksum-map-2026-08-05.json).

## Contexto

A PR #27 assumia que o ledger de produção tinha os checksums de `001`–`063` calculados sobre
CRLF, com `064`/`065` como única exceção em LF. Ao correr o `--dry-run` num `git worktree` limpo
apontando ao mesmo commit (`19eef39`), em vez do working directory histórico desta máquina, o
resultado foi **46 divergências**, não zero. Essa discrepância foi a origem deste mapeamento.

## Método

Script read-only (só `SELECT` em `public._migrations`, nenhuma escrita), não commitado, correndo
contra a base de produção. Para cada entrada do ledger, calcula o SHA-256 do ficheiro
correspondente em três representações:

- **RAW** — bytes tal como estão em disco, sem alteração;
- **LF** — todas as quebras de linha normalizadas para `\n`;
- **CRLF** — todas as quebras de linha normalizadas para `\r\n`.

Corrido em dois ambientes apontando ao mesmo commit:

1. Working directory local (esta máquina, ficheiros nunca re-normalizados por checkout).
2. `git worktree` novo do mesmo commit (o que um clone novo, CI, ou outra máquina obtêm).

**A classificação por LF/CRLF é idêntica nos dois ambientes** — só a coluna RAW muda, porque
reflete o estado de bytes específico de cada checkout, não o conteúdo. É essa independência que
torna a classificação LF/CRLF fiável como base para uma correção estrutural.

## Resumo — 69 entradas no ledger

| Classificação | Nº | Significado |
|---|---|---|
| `LF_MATCH` | 48 | Ledger calculado sobre LF (inclui `064`/`065`, cobertas pela PR #27) |
| `CRLF_MATCH` | 20 | Ledger calculado sobre CRLF |
| `NO_MATCH` | 1 | `022` — divergência real de conteúdo, não de EOL |
| `AMBIGUOUS` | 0 | — |
| `FILE_MISSING` | 0 | — |
| `LEDGER_NO_CHECKSUM` | 0 | — |

Ficheiros em disco sem entrada no ledger (pendentes, esperado): `066_secure_migrations_ledger.sql`,
`067_outbox_foundation.sql`.

**Não há padrão por intervalo de números.** LF e CRLF alternam ficheiro a ficheiro (ex.: `013` LF,
`014` CRLF, `018` LF, `026` CRLF, lado a lado) — resultado de anos de checkouts em
máquinas/sistemas diferentes antes de existir qualquer `.gitattributes` no repositório. Uma regra
`.gitattributes` por-ficheiro replicando este mapa foi considerada e rejeitada: fixaria no Git uma
mistura histórica acidental, difícil de manter e sem valor para o futuro.

## Conclusão sobre a PR #27

**A premissa da PR #27 estava incorreta.** A regra `eol=lf` restrita a `064`/`065` só "funciona"
no working directory desta máquina porque esses ficheiros nunca foram re-normalizados desde a
aplicação original — não por efeito do `.gitattributes`. Num checkout novo, as 46 migrations
`LF_MATCH` (fora de `064`/`065`) seriam convertidas para CRLF por `core.autocrlf=true` e
divergiriam do ledger. A PR #27 é substituída pela correção no runner descrita abaixo, não
mesclada.

## Tabela completa

| Migration | Checksum (ledger, truncado) | RAW | LF | CRLF | Classificação |
|---|---|---|---|---|---|
| 001_companies.sql | 1327a0cf37f9… | sim | sim | não | LF_MATCH |
| 002_profiles.sql | 56ddec368e18… | sim | sim | não | LF_MATCH |
| 003_clients_locations.sql | bf8c04b5300b… | sim | sim | não | LF_MATCH |
| 004_teams.sql | 65d61185df00… | sim | sim | não | LF_MATCH |
| 005_contracts.sql | 3cde109bf359… | sim | sim | não | LF_MATCH |
| 006_services.sql | 26b51d11211b… | sim | sim | não | LF_MATCH |
| 007_timesheets_absences.sql | d4ac43949f3e… | sim | sim | não | LF_MATCH |
| 008_financial.sql | df4108037c3c… | sim | sim | não | LF_MATCH |
| 009_notifications.sql | b911886aed23… | sim | sim | não | LF_MATCH |
| 010_views.sql | 47466e22c718… | sim | sim | não | LF_MATCH |
| 011_conflict_detection.sql | 730081f43025… | sim | sim | não | LF_MATCH |
| 012_teams_vehicle.sql | 43785a3573f9… | sim | sim | não | LF_MATCH |
| 013_client_notifications.sql | b64b69c094de… | sim | sim | não | LF_MATCH |
| 014_fix_rls_recursion.sql | a34e8fa3e6e9… | sim | não | sim | CRLF_MATCH |
| 015_fix_trigger_resilient.sql | 63c580badb8a… | sim | não | sim | CRLF_MATCH |
| 016_vehicles.sql | 50fee2a5a97d… | sim | não | sim | CRLF_MATCH |
| 017_fix_contracts_rls.sql | 6d33c39323e6… | sim | não | sim | CRLF_MATCH |
| 018_fix_services_rls_recursion.sql | 36ed92e01f2b… | sim | sim | não | LF_MATCH |
| 019_cancellation_fields.sql | ca51216eb1eb… | sim | sim | não | LF_MATCH |
| 020_services_full_client_phone.sql | 5557fe9b6e64… | sim | sim | não | LF_MATCH |
| 021_documents_enhanced.sql | 828e92d507f3… | sim | sim | não | LF_MATCH |
| **022_storage_bucket_collaborator_documents.sql** | 63f34214405a… | **não** | **não** | **não** | **NO_MATCH** |
| 023_fix_collaborator_documents_upload.sql | e4881a669b80… | sim | sim | não | LF_MATCH |
| 024_cash_flow_reference_integrity.sql | 43ae916aff66… | sim | sim | não | LF_MATCH |
| 025_timesheet_hardening.sql | 6fbdf487c37e… | sim | sim | não | LF_MATCH |
| 026_location_key_fields.sql | 38bbe0fa4f2a… | sim | não | sim | CRLF_MATCH |
| 027_service_photos.sql | c409484eaac2… | sim | não | sim | CRLF_MATCH |
| 028_growth_indexes.sql | 65f6abe5924c… | sim | não | sim | CRLF_MATCH |
| 029_background_jobs.sql | c2ac9f24a046… | sim | não | sim | CRLF_MATCH |
| 030_rls_tighten.sql | 04fd0256b384… | sim | não | sim | CRLF_MATCH |
| 031_reference_number_unique.sql | 8a12f4843b75… | sim | não | sim | CRLF_MATCH |
| 032_manual_checkout_fields.sql | a22491d92a18… | sim | sim | não | LF_MATCH |
| 033_rls_blindagem.sql | bbb4c8f32402… | sim | não | sim | CRLF_MATCH |
| 034_rls_servicos_clientes_locais.sql | 439313eba1b7… | sim | não | sim | CRLF_MATCH |
| 035_split_views.sql | a031862c35d6… | sim | sim | não | LF_MATCH |
| 036_background_jobs_lock.sql | 8f9fbd17786c… | sim | sim | não | LF_MATCH |
| 037_fixed_variable_payments.sql | 7f8278dbd8db… | sim | sim | não | LF_MATCH |
| 038_service_contract_fields.sql | 1b8986175c89… | sim | não | sim | CRLF_MATCH |
| 039_upholstery_units.sql | d25ab2da2e26… | sim | não | sim | CRLF_MATCH |
| 040_collaborator_day_team.sql | 23fc02b989dc… | sim | não | sim | CRLF_MATCH |
| 041_num_people.sql | 4adcfc29b40f… | sim | não | sim | CRLF_MATCH |
| 042_daily_clocks.sql | b4d45cc1cd11… | sim | não | sim | CRLF_MATCH |
| 043_bank_reconciliation.sql | 1e14937403eb… | sim | não | sim | CRLF_MATCH |
| 044_contract_fixed_price.sql | e9404b5cd07c… | sim | sim | não | LF_MATCH |
| 045_service_apply_vat.sql | 71042494bd83… | sim | sim | não | LF_MATCH |
| 046_contract_vat_monthly.sql | 47298a04ed0d… | sim | sim | não | LF_MATCH |
| 047_contract_excluded_dates.sql | c5d90c40f7b7… | sim | sim | não | LF_MATCH |
| 048_service_payment_tracking.sql | dbe905dab39e… | sim | sim | não | LF_MATCH |
| 049_cash_flow_service_payment_reference.sql | e22c1eaf80e0… | sim | sim | não | LF_MATCH |
| 050_bank_tx_source_order_and_dedup.sql | fb2941b9ca0a… | sim | sim | não | LF_MATCH |
| 051_building_cards.sql | ff694f760ef7… | sim | sim | não | LF_MATCH |
| 052_payment_attachments.sql | 534a28eb9f90… | sim | sim | não | LF_MATCH |
| 053_enable_realtime_notifications.sql | 3b5adb5dd91e… | sim | sim | não | LF_MATCH |
| 054_harden_service_only_policies.sql | 81e6fc6a8fb0… | sim | sim | não | LF_MATCH |
| 055_triweekly_frequency.sql | 35299253d7f4… | sim | sim | não | LF_MATCH |
| 056_services_full_payment_status.sql | 174527666c29… | sim | sim | não | LF_MATCH |
| 057_task_category_client.sql | 27aafb530d57… | sim | sim | não | LF_MATCH |
| 058_task_attachment.sql | b82f971b3321… | sim | sim | não | LF_MATCH |
| 059_rede_seguranca.sql | 95c48a5acf04… | sim | sim | não | LF_MATCH |
| 060_guardas_adicionais.sql | a73eea6545d3… | sim | sim | não | LF_MATCH |
| 061_guardas_campos_criticos.sql | a906d574ec4d… | sim | sim | não | LF_MATCH |
| 062_delete_atomico_e_actor.sql | b865c2ffbfb3… | sim | sim | não | LF_MATCH |
| 063_services_full_apply_vat.sql | 4c08f5c6a8e2… | sim | sim | não | LF_MATCH |
| 064_revoke_public_grants_atomic_functions.sql | b4dfdecfe9ca… | sim | sim | não | LF_MATCH |
| 065_revoke_public_grants_outbox_tables.sql | 6c462ffefc5a… | sim | sim | não | LF_MATCH |
| 20260608_new_features.sql | 29d8df71b3f8… | sim | não | sim | CRLF_MATCH |
| 20260609_kanban_columns.sql | c56eed655611… | sim | sim | não | LF_MATCH |
| 20260609_profiles_hourly_rate.sql | b1c5a699b6ae… | sim | sim | não | LF_MATCH |
| 20260609_timesheet_limits.sql | cf4171dd5ff7… | sim | não | sim | CRLF_MATCH |

(Pendentes, fora do ledger: `066_secure_migrations_ledger.sql`, `067_outbox_foundation.sql`.)

## Investigação da 022 — `022_storage_bucket_collaborator_documents.sql`

### Histórico do ficheiro

| Commit | Data | Alteração |
|---|---|---|
| `055c337` | 2026-06-16 09:59 | Cria o ficheiro. Bucket público, `allowed_mime_types` array, policy com `role = 'colaborador'`. |
| `d0febb5` | 2026-06-16 16:54 | "Migrations 021 e 022 aplicadas ao Supabase" — corrige `role` para `'colaboradora'`. |
| `8f924b4` | 2026-06-16 18:33 | Edita o ficheiro **já aplicado**: bucket passa a privado, `allowed_mime_types` para `NULL`, `role` volta a `'colaborador'`. Viola a regra de nunca editar migração histórica. |

`applied_at` no ledger para `021`/`022`/`023` está agrupado em `2026-07-23T10:14:11.1xx` — um
evento de baseline em bloco, não as datas de commit de junho. Isso por si só é normal (é como o
ledger foi semeado para migrations antigas), mas implica que o checksum gravado reflete o que
estava em disco nesse evento de baseline, não necessariamente o commit "correto" por inspeção do
histórico.

### O que já estava certo

A produção está funcionalmente correta: `023_fix_collaborator_documents_upload.sql` — migration
**nova e legítima**, não editada — já faz `DROP POLICY` da policy antiga, recria com
`role = 'colaborador'` e `UPDATE storage.buckets SET public=false, allowed_mime_types=NULL`.
Confirmado por leitura direta (`storage.buckets`, `pg_policies`) que a produção corresponde
exatamente ao que a `023` aplicou. Isto é o padrão certo: nunca editar `022`, corrigir através de
`023`.

### Tentativa de restauro e resultado

A hipótese inicial era que o checksum do ledger correspondesse ao conteúdo de `d0febb5` (a versão
"aplicada" segundo a mensagem de commit). **Testado e refutado.** Testei sistematicamente:

- Os três blobs git existentes para este caminho (`055c337`, `d0febb5`, `8f924b4`) — únicos em
  todo o histórico (`git log --all`, sem branches paralelas com outra versão;
- Cada um nas três representações RAW/LF/CRLF;
- As 8 combinações possíveis dos 3 campos que mudam entre versões (`public` true/false,
  `allowed_mime_types` array/`NULL`, `role` colaborador/colaboradora) aplicadas sobre a estrutura
  de `d0febb5`, nas três representações de EOL;
- Variantes de nova linha final (com/sem/dupla).

**Nenhuma combinação bateu com o checksum do ledger.** O conteúdo exato que foi hasheado no
evento de baseline de 2026-07-23 não existe em nenhum commit do repositório — não é apenas uma
questão de EOL nem de uma combinação simples dos campos conhecidos. Por não haver forma de
reconstruir esse byte a byte sem inventar conteúdo, **o ficheiro `022` não foi alterado** — o
restauro para `d0febb5` foi tentado, validado como insuficiente (dry-run continuou a acusar
`022`), e revertido. Manteve-se o conteúdo atual (pós-`8f924b4`), que é o que já estava commitado
e é o que reflete a realidade funcional da produção.

### Classificação final

**Divergência real, causa não totalmente reconstruível a partir do histórico Git — não é um
problema de EOL.** Produção funcionalmente correta (via `023`). O ficheiro `022` no repositório
não corresponde byte a byte ao que gerou o checksum do ledger, e essa correspondência exata não
pôde ser recuperada.

Decisão: não investigar mais fundo (backups antigos do baseline de 2026-07-23 não valem o custo
para um caso já funcionalmente resolvido pela `023`). Em vez de deixar isto como exceção informal
("o runner ignora silenciosamente"), foi criada uma **exceção formal, estreita e verificável** em
`supabase/migration-policy.json` → `knownChecksumExceptions`. Ver secção "Exceção formal" abaixo.

## Exceção formal para a 022

`supabase/migration-policy.json` → `knownChecksumExceptions`:

```json
{
  "migration": "022_storage_bucket_collaborator_documents.sql",
  "ledgerChecksum": "63f34214405a7ae2f5423d4c903e07993eac02eb4117a2aef7328c7bbf7ad5e1",
  "acceptedNormalizedLfChecksum": "444dd49eb07ec2beef6aeb775b6cc57d05799dc0781815306644f3e90685b4a0",
  "reason": "divergência histórica documentada; estado final garantido pela 023.",
  "evidence": "docs/atomicidade-audit/migration-checksum-map-2026-08-05.md"
}
```

Validação em `scripts/lib/migration-checksum.mjs` (`assertNoDuplicateExceptions`,
`findKnownException`, `knownExceptionMatches`) — a exceção só é aceite quando, simultaneamente:

- o nome bate exatamente com `022_storage_bucket_collaborator_documents.sql`;
- o checksum do ledger bate exatamente com `ledgerChecksum`;
- o checksum LF-normalizado do ficheiro atual bate exatamente com `acceptedNormalizedLfChecksum`;
- não existe uma segunda entrada em `knownChecksumExceptions` para o mesmo `migration` (rejeitado
  logo no arranque do runner, antes de qualquer ligação à base).

Se o ficheiro `022` for alterado de novo, o `acceptedNormalizedLfChecksum` deixa de bater e o
`--dry-run` volta a falhar como divergência normal — a exceção não é um "sempre aceitar este
ficheiro", é um par de valores pinados a um estado exato.

Saída quando a exceção é aplicada (não silenciosa):

```
⚠ CHECKSUM EXCEPTION ACEITE:
   022_storage_bucket_collaborator_documents.sql
   Motivo: divergência histórica documentada; estado final garantido pela 023.
```

Nada mais foi alterado para chegar aqui: `public._migrations`, o SQL da `022`, a `023`, checksums
históricos, `066`/`067` e `.gitattributes` ficaram intocados.

## Correção aplicada ao runner (`scripts/run-migrations.mjs`)

- Novo módulo `scripts/lib/migration-checksum.mjs`: uma migração histórica é aceite se o checksum
  do ledger corresponder ao RAW, ao LF-normalizado ou ao CRLF-normalizado do ficheiro atual;
  qualquer outra coisa continua a falhar como alteração real.
- Migrações **novas** (a partir da próxima ainda não aplicada) gravam sempre o checksum sobre o
  conteúdo normalizado para LF, independente do sistema operativo do checkout.
- A mesma flexibilidade foi aplicada à verificação de rascunhos congelados
  (`docs/atomicidade-audit/frozen/*.sql`), que sofria do mesmo problema e bloqueava o `--dry-run`
  num checkout novo antes mesmo de chegar à base de dados.
- Não foi alterada a estrutura de `public._migrations`, não foi introduzido
  `checksum_algorithm`, e nenhum checksum antigo no ledger foi reescrito.

### Validação

`--dry-run` corrido no working directory local e num `git worktree` limpo do mesmo commit:
resultado idêntico nos dois — `001`–`065` reconhecidas (a `022` como exceção formal aceite, aviso
`⚠ CHECKSUM EXCEPTION ACEITE` explícito, não silencioso), zero divergências não reconhecidas.
`066`/`067` continuam pendentes, fora do ledger, em ambos os ambientes. `npm test` (571/571),
`tsc --noEmit`, `lint` e `build` verdes.

## Estado da PR #27

Fica **substituída, não mesclada**. A correção real está no runner (`scripts/run-migrations.mjs` +
`scripts/lib/migration-checksum.mjs`), não num `.gitattributes` por-ficheiro.
