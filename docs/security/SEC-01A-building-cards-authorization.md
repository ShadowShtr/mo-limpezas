# SEC-01A — matriz de autorização de `building_cards`

Estado: preparação concluída em 28/09/2026. Nenhuma policy, grant ou base externa foi alterada.

## Origem da prova

O ensaio usa PostgreSQL 17.11 descartável, dados fictícios, o baseline de produção versionado e a cadeia real `101 → 101a → 101b → 106`. As consultas correm como `anon` ou `authenticated`, com `request.jwt.claim.sub`; não correm como `postgres` para decidir RLS.

O baseline foi capturado em 27/08/2026. As migrations posteriores são aplicadas explicitamente. Isto reproduz o schema versionado atual, mas não confirma quais migrations ou grants estão aplicados hoje na empresa.

## Grants e policies observados

No palco versionado, `anon`, `authenticated` e `service_role` têm `SELECT`, `INSERT`, `UPDATE` e `DELETE` na tabela. RLS continua habilitada.

| Policy | Comando | Tipo | Regra efetiva após 101b/106 |
|---|---|---|---|
| `building_cards_company_isolation` | `ALL` | permissiva | membro ativo da mesma empresa |
| `building_cards_insert` | `INSERT` | permissiva | admin/gestor da mesma empresa |
| `building_cards_update` | `UPDATE` | permissiva | admin/gestor da mesma empresa |
| `building_cards_delete` | `DELETE` | permissiva | admin/gestor da mesma empresa |

A 101b trocou `auth.uid()` pelo resolvedor canónico e a 106 passou a exigir `profiles.status = 'ativo'`. Elas preservaram o comando `ALL`. Como policies permissivas se combinam por `OR`, a primeira policy autoriza sozinha as quatro operações para qualquer membro ativo da empresa. As três policies de gestor não restringem essa permissão geral.

## Matriz esperado versus observado

Alvo: um prédio da Empresa A.

| Perfil e claim | SELECT esperado/observado | INSERT esperado/observado | UPDATE esperado/observado | DELETE esperado/observado |
|---|---:|---:|---:|---:|
| gestor ativo da Empresa A | sim / sim | sim / sim | sim / sim | sim / sim |
| colaborador ativo da Empresa A, `profiles.id != auth_user_id` | sim / sim | **não / sim** | **não / sim** | **não / sim** |
| colaborador inativo da Empresa A | não / não | não / não | não / não | não / não |
| gestor ativo de outra empresa | não / não | não / não | não / não | não / não |
| `anon`, sem claim | não / não | não / não | não / não | não / não |

O exploit está reproduzido: uma colaboradora ativa consegue inserir, editar e apagar diretamente pela API se os grants atuais estiverem presentes. O isolamento por empresa, a ligação por `auth_user_id` e o bloqueio por estado funcionaram no ensaio.

## Acesso legítimo a preservar

`src/app/(app)/app/page.tsx` lê `building_cards` pelo cliente autenticado para mostrar os prédios da equipa no telemóvel. Esse `SELECT` deve continuar para membros ativos da mesma empresa.

As gravações atuais passam por `src/app/actions/building-cards.ts` e pelo cliente administrativo. Não foi encontrado consumidor atual que precise de `INSERT`, `UPDATE` ou `DELETE` direto como `authenticated`.

A action ainda procura `profiles.id = auth.uid()` e não verifica `status`. Isso diverge do contrato canónico da 101b/106: uma conta nova ligada por `auth_user_id` falha, enquanto uma gestora legada inativa com token válido pode passar pela via `service_role`.

## Implementação delimitada para SEC-01B

1. Criar migration append-only posterior à 106; não editar a 051.
2. Validar no pré-estado que a policy geral ainda é permissiva e `FOR ALL`; abortar diante de drift.
3. Substituí-la por policy `FOR SELECT TO authenticated`, usando `get_my_company_id()`, que já herda identidade canónica e estado ativo.
4. Revogar todos os privilégios de `anon` em `building_cards`.
5. Revogar `INSERT`, `UPDATE` e `DELETE` de `authenticated`; manter somente `SELECT`. `service_role` conserva o caminho das Server Actions.
6. Remover as três policies de escrita que ficam sem consumidor direto, ou registrar explicitamente a decisão de mantê-las apenas como defesa futura. Não voltar a conceder escrita para tornar testes verdes.
7. Migrar `getCompanyId` e `requireManager` de `building-cards.ts` para `requireProfile`, retornando `profile.id` como `created_by` e recusando perfil inativo.
8. Converter a matriz de evidência: a colaboradora deve passar apenas em `SELECT`; repetir gestor, inativo, outra empresa e `anon`.
9. Confirmar o fluxo móvel e as quatro Server Actions. Não misturar nesta correção a atomicidade da ordenação nem validações de equipa, que pertencem a outras fichas.

## Compatibilidade e reversão

O código antigo continua a gravar por `service_role`, portanto a redução dos grants de `authenticated` é compatível com a versão atual. O `SELECT` autenticado precisa existir antes ou na mesma transação para não interromper a app móvel.

Depois de publicada, uma reversão que restaure `FOR ALL` ou CRUD a `authenticated` reabre a falha. Em caso de problema, usar nova migration corretiva que preserve o bloqueio de escrita e ajuste somente o acesso legítimo comprovadamente afetado.

## Validação

`npx vitest run src/__tests__/crm-106-status-autorizacao.pg.test.ts`: 63/63 testes passaram, incluindo inventário de grants/policies e a matriz SEC-01A.

Referências: documentação atual de [RLS do Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security) e [Row Security do PostgreSQL](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).
