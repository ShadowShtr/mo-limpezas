# AUDITORIA CONSOLIDADA — "Alterações que revertem / não aparecem"

**Repositório:** ShadowShtr/mo-limpezas
**Data:** 2026-07-22
**Fontes fundidas:**
- **Auditoria A** (Claude) — pipeline de deploy, migrações, cache/PWA, dados de produção, execução de diagnóstico read-only contra a base real.
- **Auditoria B** (auditor externo) — lógica de negócio: contratos → serviços, fontes de verdade, queries incompletas, cobranças.
- **Validação cruzada** — cada afirmação da Auditoria B verificada contra o código real, linha a linha.

---

## VEREDITO UNIFICADO

O problema tem **duas camadas que se alimentam uma à outra**:

**Camada 1 — Entrega (Auditoria A):** o site alterna entre versões. Fixes feitos
localmente nunca chegaram a produção (8 commits por publicar), deploys por dois
canais (Vercel CLI + GitHub) repõem versões antigas, e o runner de migrações
re-executava tudo + seed contra produção. Resultado: bugs "já corrigidos"
continuam a acontecer e parecem reversões.

**Camada 2 — Aplicação (Auditoria B, confirmada e ampliada):** o sistema tem
múltiplas fontes de verdade e processos automáticos que reescrevem dados depois
de alterações manuais. O contrato reescreve serviços futuros; edições manuais
nunca são marcadas como exceção; formulários gravam `null` por cima de campos
que não carregaram; escritas diretas do browser falham em silêncio com RLS.

Enquanto a Camada 1 não estiver fechada, qualquer correção da Camada 2 cai no
mesmo buraco — por isso o plano ataca primeiro a entrega, depois a aplicação.

---

## VALIDAÇÃO CRUZADA — o que cada auditoria acertou

| # | Afirmação (Auditoria B) | Veredito da verificação no código |
|---|---|---|
| B1 | `updateFutureServiceValuesForContract` pode sobrescrever intervenções editadas à mão se não estiverem `is_exception` | **CONFIRMADO — e PIOR**: `is_exception` **nunca é escrito em lado nenhum** do código; toda a edição manual é sobrescrevível |
| B2 | create/updateContrato fazem `locations.hourly_rate = input.hourly_rate ?? null` e podem apagar o valor/hora do local | **CONFIRMADO literalmente** (`contratos.ts:428` e `:554`) |
| B3 | Query incompleta já apagou avença/type/notes; fonte única `CONTRATO_SHEET_SELECT` criada | **CONFIRMADO**; fix existe localmente (+ `CLIENTE_SHEET_SELECT`) e há 12 testes-guarda a proteger — mas os fixes **não estão em produção** |
| B4 | Cobranças podem duplicar avenças (caso Parque Norte) | **DESATUALIZADO no local / VERDADE em produção**: a geração já **bloqueia** duplicados (`invoices.ts:163-175`) e o helper `hasOverlappingMonthlyContract` que a Auditoria B recomenda criar **já existe** e é chamado no create (`contratos.ts:412`) e update (`:537`) — tudo no commit 7eca98e, **por publicar** |
| B5 | `services_full` como ponto sensível de divergência de views | **VÁLIDO como classe de risco**; a view inclui `is_exception` e os campos usados; higiene coberta em parte pelos testes-guarda |
| B6 | Regra "avença → serviços a 0 e uma linha única na cobrança" | **APLICAR COM CUIDADO**: o `daily-billing` divide deliberadamente a avença pelo nº de serviços do mês (vista diária); há duas representações intencionais — não uniformizar às cegas |

**O que a Auditoria B não viu (achados exclusivos da A):**

| # | Achado exclusivo (Auditoria A) | Gravidade |
|---|---|---|
| A1 | 8 commits locais nunca publicados; migrações 057/058 fora do git; WIP por commitar | CRÍTICO |
| A2 | Deploys por dois canais (`.vercel/output` presente) → site alterna versões | CRÍTICO |
| A3 | Runner de migrações sem controlo, re-executa tudo + seed em produção, password Postgres hardcoded no histórico do git | CRÍTICO |
| A4 | `service-detail-sheet.tsx` escreve direto na tabela do **browser** (anon+RLS): update bloqueado por RLS = 0 linhas **sem erro** → UI diz "sucesso", nada gravado; sem auditLog, sem revalidação | ALTO |
| A5 | Last-write-wins entre duas sessões de gestão (sem verificação `updated_at`); corrida no estado otimista do calendário | MÉDIO |
| A6 | PWA: SW novo fica em "waiting" até tocar "Atualizar" → colaboradoras correm app antiga no telemóvel | MÉDIO |
| A7 | `/api/health` não expunha versão → impossível provar que commit está no ar | MÉDIO (corrigido) |
| A8 | 141 pares de serviços sobrepostos na mesma equipa em produção (dados reais, janela -30/+60 dias) | DADOS |

---

## CAUSAS CONSOLIDADAS (ordem de gravidade)

### CAUSA 1 — Os fixes nunca chegaram a produção  [A · CRÍTICO]

Master local **8 commits à frente do GitHub desde 13–16 jul** (`git rev-list
--left-right --count master...origin/master → 8 0`):

```
4530361 fix(calendario): pagamento configura-se no painel, nao no card
a61b77a feat(calendario): botoes rapidos de estado de pagamento
e46301e fix(contratos): evita mensais/personalizados caindo em fim de semana
e6ac6d9 fix(seguranca): fecha achados da auditoria (RLS, validacao, restore)
c1a6701 fix(notificacoes): ativa Realtime na tabela notifications
8fd6fa9 feat(notificacoes): toast ao chegar notificação
1f0faea feat(financeiro): anexo de fatura + notificação ao atribuir tarefa
7eca98e feat(calendario): coluna Prédios + fix(cobrancas): avença duplicada
```

São precisamente os fixes das queixas atuais (type/notes, avença, cobrança
duplicada, fins de semana). Produção continua a produzir os bugs "já
corrigidos". Migrações 057/058 **nem estão no git**; 6+ ficheiros de WIP por
commitar — schema e código podem chegar a produção dessincronizados.

### CAUSA 2 — Deploys por dois canais  [A · CRÍTICO]

`.vercel/output/` prova deploys por CLI a partir do PC, misturados com deploys
automáticos do GitHub. Deploy CLI publica a versão local (com fixes); um push
posterior repõe a versão do GitHub (sem fixes) → **o site anda para trás**.

### CAUSA 3 — Runner de migrações inseguro  [A · CRÍTICO]

Versão original do `scripts/run-migrations.mjs`:

```js
password: "@vitortmf36978",     // password de produção HARDCODED (no histórico git!)
// re-executa TODAS as migrações em cada run, engolindo "already exists"
// e aplica SEMPRE o seed.sql — que diz "NÃO executar em produção"
```

Migrações com `UPDATE`/`DELETE` (021, 023, 025) re-aplicavam-se sobre dados
reais → valores "voltam atrás" na base. ⚠️ A password tem de ser **RODADA** no
dashboard do Supabase — removê-la do ficheiro não chega.

### CAUSA 4 — `is_exception` nunca é escrito  [B, ampliada pela validação · ALTO]

A reescrita de serviços futuros respeita exceções:

```ts
// contratos.ts:295 e :363
if (service.is_exception) continue;
```

Mas `grep -R "is_exception" src/` prova que **nenhum código grava
`is_exception = true`** — nem o drag & drop (`reschedule.ts`), nem o painel de
detalhe, nem nenhuma action. A coluna existe desde a migração 006 e só é lida.
**Toda a edição manual de serviço de contrato reverte na próxima edição do
contrato** — horário, equipa e valor voltam ao padrão. Mecanismo nº 1 de
"alterei a intervenção e voltou" dentro da aplicação.

### CAUSA 5 — Escritas do browser com RLS silencioso  [A · ALTO]

`service-detail-sheet.tsx:352-355, 383-386, 400-403` — componente de browser a
escrever direto na tabela:

```ts
const { error } = await supabase.from("services").update(update).eq("id", svc.id);
// RLS bloqueia → 0 linhas afetadas SEM erro → UI mostra "Horário atualizado ✓"
```

Sem auditLog, sem `is_exception`, sem `revalidatePath`. Com a migração 054
(`harden_service_only_policies`) e o commit e6ac6d9 a mexer em RLS fora de
sincronia com o código deployado, é o mecanismo perfeito de "gravo e não
aparece".

### CAUSA 6 — Partial update nos formulários  [B, confirmada · ALTO]

Queries com listas de colunas à mão alimentam formulários; colunas não
carregadas vão a `null` ao gravar. Casos reais: type/notes de clientes (fix
2eb8154) e valor da avença (fix e999852) — ambos por publicar. Fontes únicas
`CLIENTE_SHEET_SELECT`/`CONTRATO_SHEET_SELECT` criadas + testes-guarda.
Variante ainda ativa:

```ts
// contratos.ts:428 e :554
.update({ hourly_rate: input.hourly_rate ?? null })   // apaga o valor/hora do local
```

Num contrato de avença/estofos sem valor/hora no formulário, isto **anula o
`hourly_rate` do local** e os cálculos por hora passam a 0/errado.

### CAUSA 7 — Cobranças duplicadas de avença  [B · corrigida localmente, ativa em produção]

Dois contratos `fixed_monthly` ativos no mesmo local/período geravam duas
linhas iguais (caso Parque Norte). Estado atual do código local: geração
**bloqueia** com mensagem nominal (`findDuplicateMonthlyContractsByLocation`) e
o create/update de contrato valida com `hasOverlappingMonthlyContract`
(`src/lib/contract-overlap`). **Só falta publicar** (commit 7eca98e).

### CAUSA 8 — Fatores agravantes  [A+B · MÉDIO]

- **Concorrência**: last-write-wins sem verificação `updated_at` entre sessões;
  estado otimista do calendário sobreposto por props obsoletas.
- **PWA**: SW novo espera toque em "Atualizar" → app antiga nos telemóveis de
  quem nunca toca (decisão consciente para não recarregar a meio do ponto —
  manter, mas tornar o aviso mais visível).
- **Cálculo de valor duplicado em 4+ sítios** (reschedule, detail-sheet,
  reescrita de contratos, cron) — falta o helper central `calculateServiceValue`
  proposto pela Auditoria B. Recomendação validada.
- **`revalidatePath` incompleto** — alterações financeiras de contrato não
  revalidam `/dashboard/cobrancas`.
- **Views/selects divergentes** (`services` vs `services_full`) — classe de
  risco a vigiar; parcialmente coberta pelos testes-guarda.

---

## RESULTADOS DA EXECUÇÃO REAL (produção, read-only, 2026-07-22)

`node scripts/audit-reversoes.mjs`:

```
❌ 2 críticos:  8 commits por publicar | migrações 057/058 fora do git
⚠️ 6 avisos:   18 ficheiros por commitar | .vercel/output presente |
               AUDIT_APP_URL por configurar | auditoria type/notes inativa em prod |
               141 pares de serviços SOBREPOSTOS na mesma equipa (-30/+60 dias) |
               SW espera toque em "Atualizar"
✅ 10 ok:      62/62 migrações aplicadas em produção (sondagem automática de
               tabelas/colunas/views/buckets derivada dos próprios .sql) |
               sem clientes fictícios do seed | sem avenças ativas a 0€ |
               fuso horário consistente | sem edições em corrida (14 dias) |
               HTML nunca servido da cache
informativo:   35 serviços a sáb/dom na janela; 930 clientes ativos sem notas
```

---

## FERRAMENTAS JÁ ENTREGUES (no repo, por commitar)

```
scripts/audit-reversoes.mjs            Diagnóstico read-only, 9 secções, exit 1
                                       se críticos (para CI). Correr após cada
                                       deploy e sempre que "algo voltou atrás".
scripts/run-migrations.mjs             REESCRITO: SUPABASE_DB_URL do env, tabela
                                       _migrations (só pendentes, em transação,
                                       pára ao 1º erro), --baseline para bases
                                       existentes, seed só com --seed em base vazia.
src/app/api/health/route.ts            Devolve version (commit) + branch.
src/__tests__/reversao-guards.test.ts  12 testes-guarda (todos verdes): fontes
                                       únicas dos sheets, runner seguro, SW nunca
                                       cacheia HTML, versão rastreável.
```

---

## ROTEIRO UNIFICADO DE CORREÇÃO

```
================================================================================
FASE 0 — SEGURANÇA (fazer JÁ)
================================================================================
1. RODAR a password do Postgres no dashboard do Supabase
   (a antiga @vitortmf36978 está no histórico do GitHub).
2. .env.local:
   SUPABASE_DB_URL=postgres://...        (connection string nova)
   AUDIT_APP_URL=https://<dominio-producao>

================================================================================
FASE 1 — PARAR A ALTERNÂNCIA DE VERSÕES (Camada 1)
================================================================================
3. Commitar o WIP; migrações 057/058 SEMPRE no mesmo commit que o código.
4. git push origin master → publica os 8 fixes (fecha na prática as causas
   6-parcial e 7 em produção).
5. NUNCA MAIS `vercel --prod` manual — canal único: deploy automático via push.
6. Uma vez: node scripts/run-migrations.mjs --baseline

================================================================================
FASE 2 — FECHAR OS MECANISMOS DE REVERSÃO NA APLICAÇÃO (Camada 2)
================================================================================
7. is_exception = true em TODA a edição manual de serviço de contrato:
   - reschedule.ts (drag & drop): contract_id != null → is_exception: true
   - edição de horário/equipa/valor no painel de detalhe: idem
   - alteração de equipa via modal de alocação, se toca em serviços de contrato
8. Migrar as escritas do service-detail-sheet para server actions:
   - fecha RLS silencioso, auditLog em falta e revalidação em falta de uma vez;
   - regra: update de services devolve linhas afetadas; 0 linhas = ERRO visível.
9. locations.hourly_rate: só atualizar quando o contrato é por hora OU houve
   alteração explícita do campo. Nunca `input.hourly_rate ?? null` cego.

================================================================================
FASE 3 — HIGIENE ESTRUTURAL (recomendações B validadas + A)
================================================================================
10. Helper central calculateServiceValue(input) usado por TODAS as fontes:
    criação manual, contratos, cron, drag, detail-sheet, reescrita futura,
    cobranças. Regras:
    A. fixed_monthly=true  → serviços 0/null; fatura = 1 linha por contrato/mês
       (manter o split deliberado do daily-billing na vista diária);
    B. fixed_price>0, fixed_monthly=false → calculated_value = fixed_price,
       sem multiplicar por horas/pessoas;
    C. por hora → duração × hourly_rate × num_people (recalcular ao mudar
       equipa, EXCETO se is_exception);
    D. estofos → upholstery_units × upholstery_unit_price, com prioridade.
11. Regra de ouro dos formulários: campo crítico undefined → BLOQUEAR gravação
    ("Não foi possível carregar todos os dados. Guardar agora poderia apagar
    informações. Atualize a página."). Nunca converter undefined em null.
    Campos críticos: contracts.fixed_price/fixed_monthly/apply_vat/schedule_days/
    starts_on/ends_on/status/num_people; locations.hourly_rate/fixed_price/
    pricing_type; services.scheduled_start/scheduled_end/team_id/
    calculated_value/manual_value/apply_vat/num_people.
12. revalidatePath: acrescentar /dashboard/cobrancas às alterações financeiras;
    avaliar helper revalidateBusinessEntity({clientId, locationId, ...}).
13. Verificação de concorrência (updated_at) nas server actions de services e
    contracts — elimina last-write-wins entre duas sessões abertas.

================================================================================
FASE 4 — DADOS EXISTENTES EM PRODUÇÃO
================================================================================
14. Triagem dos 141 pares de serviços sobrepostos (lista no relatório da
    auditoria; maioria nasce de drags forçados/agendamento simultâneo).
15. Confirmar os 35 serviços de sáb/dom na janela -30/+60 dias.
16. Recuperar perdas antigas de type/notes/avença via audit_log (campo before).
17. Acrescentar ao audit-reversoes.mjs as queries de diagnóstico da Auditoria B
    ainda não cobertas: serviços de contrato "diferentes do padrão" sem
    is_exception; serviços apagados que podem voltar (excluded_dates); faturas
    rascunho com linhas duplicadas.

================================================================================
ROTINA PERMANENTE
================================================================================
- Após cada deploy:  node scripts/audit-reversoes.mjs
- "Voltou atrás?":   abrir <site>/api/health e comparar version com git log —
                     em segundos distingue-se código antigo de problema de dados.
- npm run test sempre verde (inclui os testes-guarda).
```

---

## TESTES OBRIGATÓRIOS (lista B fundida com o estado real)

```
JÁ EXISTEM (verdes):
✅ Fontes únicas dos sheets (cliente + contrato) — reversao-guards.test.ts
✅ Runner de migrações seguro — reversao-guards.test.ts
✅ SW nunca cacheia HTML / api — reversao-guards.test.ts
✅ Versão do deploy rastreável — reversao-guards.test.ts
✅ Ocorrências de contrato — contract-occurrences.test.ts (excluded_dates)

A CRIAR (Fase 2/3):
1. Editar serviço de contrato no calendário → is_exception=true.
2. Editar contrato → NÃO altera serviços com is_exception nem intervenções
   manuais (contract_id null); altera serviços padrão.
3. Excluir intervenção de contrato → excluded_dates; cron não a recria.
4. Contrato por hora / fixed_price / fixed_monthly / estofos → valores corretos
   via calculateServiceValue (4 cenários).
5. Criar/editar contrato não apaga hourly_rate do local sem intenção explícita.
6. Gravação com campo crítico undefined → bloqueada com erro claro.
7. Update de services com RLS a filtrar → erro visível (0 linhas ≠ sucesso).
8. Cobrança: uma avença = uma linha; duplicado = bloqueio nominal (já no código,
   falta o teste).
9. Concorrência: update com updated_at desatualizado → rejeitado.
```

---

## CRITÉRIO DE ACEITE CONSOLIDADO

- `/api/health` em produção devolve o mesmo commit do GitHub;
- `node scripts/audit-reversoes.mjs` termina com 0 críticos;
- editar manualmente um serviço de contrato e depois editar o contrato NÃO
  reverte a edição (teste automático);
- update bloqueado por RLS aparece como ERRO, nunca "sucesso";
- nenhum formulário grava null por cima de campo que não carregou;
- contrato mensal duplicado bloqueado na origem e na cobrança (já no código);
- calendário, ficha do cliente e contratos mostram o mesmo estado após gravar;
- npm run lint, npm run build e npm run test passam;
- password antiga da base rodada;
- relatório final com: causas, ficheiros alterados, queries de diagnóstico,
  testes criados e dados corrigidos manualmente em produção.

## FORA DO ÂMBITO

Conciliação bancária; SMS/TextBee/WhatsApp; design geral; autenticação; RLS não
relacionada; refatoração visual.
