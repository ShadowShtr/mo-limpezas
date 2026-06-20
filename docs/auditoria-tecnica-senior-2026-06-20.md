# Auditoria Técnica Sénior — Mó Limpezas

**Repositório:** `ShadowShtr/mo-limpezas`  
**Data:** 20/06/2026  
**Escopo:** checkup técnico, segurança, RLS, banco, APIs, crons, storage, backup e prontidão para produção.  
**Regra aplicada:** análise sem alteração de código, sem branch, sem commit e sem correções automáticas.

---

## 1. Veredito direto

**O sistema ainda não deve ir para produção com dados reais.**

O projeto tem boa base técnica, mas ainda existem bloqueadores de produção, principalmente em:

- RLS/policies permissivas;
- policies antigas potencialmente não removidas;
- `FOR ALL USING (true)` em tabelas sensíveis;
- risco de escalada de privilégios via CSV;
- crons sem locks/idempotência forte;
- rotina de arquivo com risco de inconsistência/perda de ficheiros;
- backup sensível via GET e `select("*")`;
- views com excesso de dados sensíveis.

---

## 2. Pontos positivos encontrados

- Projeto estruturado com Next.js, TypeScript, Supabase, Vercel, Resend e Web Push.
- TypeScript com `strict: true`.
- Scripts de `lint`, `test` e `build` no `package.json`.
- `prebuild` roda validações de ambiente e auditoria de segurança.
- Existe `auth-guard` reconhecendo corretamente que `createAdminClient` faz bypass de RLS.
- `next.config.ts` inclui headers de segurança como:
  - `X-Frame-Options`;
  - `Referrer-Policy`;
  - `Strict-Transport-Security`;
  - CSP.
- Helper de fotos valida MIME, tamanho e path por empresa/serviço/evento.
- Bucket de fotos aparentemente privado.

---

## 3. Bloqueadores P0

### P0-1 — `service_photos` com policy totalmente aberta

**Arquivo:** `supabase/migrations/027_service_photos.sql`  
**Tabela:** `service_photos`

Foi encontrada policy do tipo:

```sql
FOR ALL USING (true) WITH CHECK (true)
```

**Impacto:**  
Qualquer utilizador autenticado pode potencialmente inserir, alterar ou apagar metadata de fotos, dependendo das permissões aplicadas no Supabase.

**Correção recomendada:**

- remover a policy aberta;
- criar policies separadas por role;
- colaborador só deve inserir/ver fotos de serviços onde participa;
- gestor/admin podem gerir fotos da empresa;
- operações críticas devem passar pelo backend com validação.

---

### P0-2 — `background_jobs` com escrita aberta

**Arquivo:** `supabase/migrations/029_background_jobs.sql`  
**Tabela:** `background_jobs`

Foi encontrada policy aberta para escrita:

```sql
FOR ALL USING (true) WITH CHECK (true)
```

**Impacto:**  
Utilizadores podem adulterar estado de jobs, cursores e execuções.

**Correção recomendada:**

- remover escrita para utilizadores comuns;
- permitir escrita apenas por service role/backend;
- permitir leitura apenas para admin/gestor quando necessário.

---

### P0-3 — `cash_flow_entries`, `collaborator_documents` e `management_tasks` com gestão ampla demais

**Arquivo:** `supabase/migrations/20260608_new_features.sql`

Foram identificadas policies permitindo que membros da empresa possam gerir dados sensíveis.

**Impacto:**  
Colaborador comum pode potencialmente gerir:

- fluxo de caixa;
- documentos de colaboradores;
- tarefas administrativas.

**Correção recomendada:**

- separar permissões por role;
- colaborador só deve ver/editar o que é próprio;
- financeiro/documentos devem ser restritos a admin/gestor;
- criar testes cross-role.

---

### P0-4 — Policies antigas possivelmente não removidas

**Arquivo:** `supabase/migrations/014_fix_rls_recursion.sql`

A migration tenta remover algumas policies, mas os nomes não parecem bater com todas as policies criadas anteriormente.

**Impacto:**  
Em Supabase/Postgres, policies permissivas acumulam acesso. Uma policy antiga pode continuar ativa e anular uma policy nova mais restritiva.

**Correção recomendada:**

Executar inventário real:

```sql
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname in ('public', 'storage')
order by tablename, policyname;
```

Depois:

1. dropar todas as policies antigas por nome exato;
2. recriar matriz final;
3. testar com admin, gestor, colaborador e utilizador de outra empresa.

---

### P0-5 — `contracts`, `absences` e `vacation_requests` com policies amplas por empresa

**Arquivos:**

- `supabase/migrations/005_contracts.sql`
- `supabase/migrations/007_timesheets_absences.sql`

**Impacto:**  
Colaborador pode potencialmente criar/alterar contratos, ausências ou férias de outros utilizadores da empresa.

**Correção recomendada:**

- contratos: apenas admin/gestor;
- férias/ausências: colaborador só pode criar/ver pedidos próprios;
- gestor/admin podem gerir todos da empresa.

---

### P0-6 — CSV permite escalada de privilégio para `admin`

**Arquivo:** `src/app/actions/csv-import.ts`  
**Função:** `importColaboradorasCSV`

A importação aceita `funcao` como:

- `admin`;
- `gestor`;
- `colaborador`.

E a função permite acesso a `admin` e `gestor`.

**Impacto:**  
Um gestor pode importar CSV criando um novo utilizador como `admin`.

**Correção recomendada:**

- gestor só pode criar `colaborador`;
- apenas admin pode criar gestor;
- criação de admin deve ser fluxo separado e auditado.

---

### P0-7 — Cron de arquivo pode causar perda/inconsistência

**Arquivo:** `src/app/api/cron/archive-documents/route.ts`

O fluxo aparenta:

1. gerar manifesto;
2. apagar ficheiros do storage;
3. depois marcar registos como arquivados.

**Impacto:**  
Se a remoção do ficheiro acontecer e a atualização da base falhar, o sistema fica com metadata apontando para ficheiro inexistente.

**Correção recomendada:**

- nunca apagar original diretamente;
- marcar como `archive_pending`;
- copiar para arquivo;
- validar cópia;
- marcar como `archived`;
- apagar físico apenas em job separado, idempotente e auditado.

---

## 4. Problemas P1

### P1-1 — View `services_full` expõe dados demais

**Arquivo:** `supabase/migrations/010_views.sql`  
**View:** `services_full`

A view mistura:

- dados do serviço;
- dados do cliente;
- localização;
- códigos/instruções de acesso;
- valores financeiros.

**Impacto:**  
Telas simples podem receber dados sensíveis desnecessários.

**Correção recomendada:**

Criar views separadas:

- `services_calendar_summary`;
- `services_detail_manager`;
- `services_mobile_collaborator`;
- `services_financial_private`.

---

### P1-2 — Backup sensível via GET e `select("*")`

**Arquivo:** `src/app/api/dashboard/backups/export/route.ts`

**Problemas:**

- endpoint via GET;
- exportação de várias tabelas com `select("*")`;
- ZIP gerado em memória;
- sem auditoria forte;
- não exporta ficheiros reais, apenas metadata.

**Correção recomendada:**

- mudar para POST;
- exigir confirmação;
- auditar quem exportou;
- selecionar colunas explicitamente;
- paginar dados;
- avisar que não substitui backup real da infraestrutura.

---

### P1-3 — Rate limit pode cair para memória em produção

**Arquivo:** `src/lib/rate-limit.ts`

Se Upstash não estiver configurado, o sistema usa fallback em memória.

**Impacto:**  
Em Vercel/serverless, fallback em memória não é fiável entre instâncias.

**Correção recomendada:**

- Upstash obrigatório em produção;
- fallback apenas em desenvolvimento.

---

### P1-4 — Crons sem lock forte/idempotência completa

**Arquivos relevantes:**

- `src/app/api/cron/generate-services/route.ts`
- `vercel.json`

**Impacto:**  
Execuções simultâneas podem gerar duplicidade de serviços, referências repetidas ou estados inconsistentes.

**Correção recomendada:**

- advisory lock por empresa/mês;
- unique index por `company_id`, `contract_id`, `scheduled_start`;
- usar `upsert`;
- transação por lote.

---

### P1-5 — `adminCreateTimesheet` não valida empresa do colaborador

**Arquivo:** `src/app/actions/timesheets.ts`

A action valida o serviço, mas precisa confirmar que o `collaborator_id` também pertence à mesma empresa.

**Impacto:**  
Com UUID conhecido, pode haver ligação indevida entre serviço de uma empresa e colaborador de outra.

**Correção recomendada:**

Antes do insert:

```sql
profiles.id = collaboratorId
and profiles.company_id = currentCompanyId
```

---

### P1-6 — Login redireciona com base em `user_metadata`

**Arquivo:** `src/app/actions/auth.ts`

O redirect usa `user_metadata.role`, mas a fonte confiável deve ser `profiles.role`.

**Impacto:**  
Fluxo errado caso metadata esteja desatualizada.

**Correção recomendada:**

Após login, consultar `profiles.role` e redirecionar com base no banco.

---

## 5. Problemas P2

### P2-1 — `.env.example` referido no README não foi encontrado

O README orienta copiar `.env.example`, mas o ficheiro não foi encontrado.

**Correção recomendada:**  
Criar `.env.example` sanitizado.

---

### P2-2 — Types manuais de banco

`src/types/database.ts` indica que os types são manuais.

**Correção recomendada:**  
Gerar types automaticamente pelo Supabase em CI.

---

### P2-3 — `allowJs` e `skipLibCheck`

O projeto tem `strict: true`, mas também `allowJs: true` e `skipLibCheck: true`.

**Correção recomendada:**  
Reduzir gradualmente uso de JS e remover `skipLibCheck` quando possível.

---

### P2-4 — Server Actions com limite alto

`serverActions.bodySizeLimit` está em cerca de 52 MB.

**Correção recomendada:**  
Validar por rota/action e proteger endpoints sensíveis.

---

## 6. Checklist técnico obrigatório antes de produção

### Segurança/RLS

- [ ] Fazer dump real de `pg_policies`.
- [ ] Dropar policies antigas por nome exato.
- [ ] Remover todos os `FOR ALL USING (true)` indevidos.
- [ ] Criar policies separadas por tabela, role e operação.
- [ ] Testar admin, gestor, colaborador e utilizador de outra empresa.
- [ ] Criar testes automatizados de isolamento multiempresa.

### Banco

- [ ] Corrigir FK contraditória em `service_photos.collaborator_id`.
- [ ] Criar constraints para evitar duplicação de serviços.
- [ ] Validar JSONB crítico com constraints ou funções.
- [ ] Separar dados sensíveis por acesso.

### APIs/actions

- [ ] Corrigir CSV para impedir gestor de criar admin.
- [ ] Validar empresa do colaborador em `adminCreateTimesheet`.
- [ ] Substituir redirect baseado em metadata por `profiles.role`.
- [ ] Remover `select("*")` de actions e páginas.
- [ ] Adicionar auditoria em operações críticas.

### Views

- [ ] Dividir `services_full` em views menores.
- [ ] Remover códigos de acesso/instruções de views genéricas.
- [ ] Criar DTOs específicos por tela.

### Crons

- [ ] Adicionar advisory locks.
- [ ] Tornar geração de serviços idempotente.
- [ ] Adicionar constraints de unicidade.
- [ ] Criar retries seguros.
- [ ] Auditar execuções críticas.

### Storage

- [ ] Corrigir policy de `service_photos`.
- [ ] Guardar `storage_path` em vez de depender de URL.
- [ ] Arquivar sem apagar original antes de validar cópia.
- [ ] Criar reconciliação storage/banco.

### Backup

- [ ] Alterar export de GET para POST.
- [ ] Auditar exportações.
- [ ] Paginar dados.
- [ ] Evitar `select("*")`.
- [ ] Documentar que o backup não inclui ficheiros reais.
- [ ] Criar plano de restore testado.

### CI/CD

- [ ] Criar `.env.example`.
- [ ] Tornar Upstash obrigatório em produção.
- [ ] Rodar `npm run lint`.
- [ ] Rodar `npm run test`.
- [ ] Rodar `npm run build`.
- [ ] Gerar Supabase types automaticamente.

---

## 7. Branches sugeridas

1. `fix/p0-rls-lockdown`
2. `fix/p0-storage-policies`
3. `fix/p0-csv-role-escalation`
4. `fix/p0-safe-document-archive`
5. `fix/p1-cron-idempotency-locks`
6. `fix/p1-backup-hardening`
7. `refactor/server-data-access-layer`
8. `chore/ci-security-checks`

---

## 8. Ordem recomendada de execução

1. Criar migration de inventário e limpeza de RLS.
2. Corrigir policies P0.
3. Corrigir CSV e permissões de roles.
4. Corrigir storage/fotos/documentos.
5. Corrigir crons com locks e idempotência.
6. Corrigir backup.
7. Dividir views sensíveis.
8. Criar `.env.example`.
9. Rodar lint/test/build.
10. Testar multiempresa com utilizadores reais de teste.
11. Só depois considerar produção com dados reais.

---

## 9. Conclusão

O projeto tem boa base, mas ainda está em fase pré-produção.

**Status final:** bloqueado para produção com dados reais.

**Motivo:** riscos P0 em RLS, permissões, storage, CSV, crons e arquivo de documentos.

A prioridade deve ser corrigir primeiro a segurança do banco e as permissões. Depois disso, avançar para crons, backup e redução de dados expostos no frontend.
