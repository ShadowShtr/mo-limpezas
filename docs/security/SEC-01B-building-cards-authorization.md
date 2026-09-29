# SEC-01B — correção da autorização de `building_cards`

Implementada localmente em 28/09/2026. Nenhum SQL foi executado na empresa.

## Resultado

A migration `107_building_cards_authorization.sql` substitui quatro policies permissivas por uma policy `FOR SELECT TO authenticated`. Ela mantém a leitura móvel por empresa e revoga todos os privilégios antes de devolver somente:

- `authenticated`: `SELECT`;
- `service_role`: `SELECT`, `INSERT`, `UPDATE` e `DELETE`;
- `anon` e `PUBLIC`: nenhum privilégio.

As Server Actions agora usam `requireProfile`. Perfis inativos são recusados, admin/gestor é exigido nas escritas e `created_by` recebe `profile.id`, inclusive quando `profiles.id != auth_user_id`.

## Prova PostgreSQL real

O teste aplica a cadeia real até a 106, reproduz primeiro a escrita indevida e então aplica a 107.

| Papel/estado | SELECT | Escrita direta |
|---|---:|---:|
| gestor ativo, mesma empresa | sim | não |
| colaborador ativo ligado por `auth_user_id` | sim | não |
| colaborador inativo | não | não |
| gestor ativo de outra empresa | não | não |
| anônimo | não | não |
| `service_role` | sim | sim |

A prova usa papéis e claims reais em PostgreSQL 17.11. O `service_role` comprova somente o caminho administrativo; não é usado para provar RLS.

## Compatibilidade e reversão

O código anterior já gravava com o cliente administrativo, portanto a migration pode preceder ou acompanhar esta versão sem interromper gravações. A leitura autenticada móvel permanece disponível.

O rollback é bloqueado porque restaurar `FOR ALL` ou CRUD a `authenticated` reabre a vulnerabilidade. Uma incompatibilidade deve ser corrigida por migration posterior que mantenha a escrita direta fechada.

O Supabase CLI não está instalado neste ambiente. O arquivo novo seguiu a sequência versionada do repositório e passou no runner e nos testes reais; nenhuma ferramenta foi instalada automaticamente.
