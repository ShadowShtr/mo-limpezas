# Estado de execução — 2026-08-24

> **Isto não é uma fonte de regras.** As regras ativas vivem em `AGENTS.md`,
> `docs/PRODUCTION-RUNBOOK.md`, `docs/ARCHITECTURE.md` e
> `docs/ENGINEERING-STANDARD.md`, por essa ordem. O roadmap canónico continua a
> ser `docs/PLANO-MESTRE.md`. Este documento é **inventário e fila** — diz o que
> existe, o que falta e por que ordem se ataca.

Ponto de leitura do repositório no momento desta reconciliação:

```text
REMOTE_MASTER_HEAD = 5e42b13f43e748e0a776b38a7b35e497afeec353
WORKTREE_CLEAN     = sim
FETCH              = git fetch origin --prune (2026-08-24)
```

Nenhum SHA aqui deve ser reutilizado de memória numa sessão futura. Voltar a
fazer `git fetch` e reconfirmar antes de qualquer decisão.

---

## 1. O achado principal desta reconciliação

A pergunta de partida era: *«há PRs antigas abertas, logo há trabalho por
integrar?»*

**Não.** A medição contradiz a suposição:

```bash
git rev-list --count origin/master..<branch>
```

Para **48 das 55 branches remotas** o resultado é **0** — todos os commits
dessas branches já são ancestrais de `origin/master`. Estão integradas. O que
resta em `git diff origin/master <branch>` é apenas o `master` ter avançado
depois delas.

Isto inclui **toda a pilha de PRs Draft abertas**, de #47 a #61.

| PR | Título | Branch | Commits fora do master |
|---|---|---|---|
| #47 | T08 + T09 — identidade de ocorrência e reconciliação | `feat/t08-identidade-ocorrencia` | **0** |
| #50 | T11 — modelo financeiro, IVA e avenças | `feat/t11-modelo-financeiro-canonico` | **0** |
| #51 | T14 — relatórios operacionais e financeiros | `feat/t14-relatorios-read-model` | **0** |
| #52 | T15 — dashboard financeiro canónico | `feat/t15-dashboard-financeiro-canonico` | **0** |
| #53 | T17-A — auditar e classificar 100% dos ficheiros | `chore/t17-auditoria-global` | **0** |
| #54 | T17-B1 — limpeza comprovada não-runtime | `chore/t17b-limpeza-comprovada` | **0** |
| #55 | T17-B2 — endurecer scripts administrativos | `chore/t17b2-endurecer-scripts` | **0** |
| #56 | T17-B3 — erros ignorados nas actions de escrita | `fix/t17b3-action-query-errors` | **0** |
| #57 | Financeiro V2 A — casca visual read-only | `feat/financeiro-v2-shell` | **0** |
| #58 | PR C — Pagamentos: ler deixa de escrever | `fix/payments-stop-implicit-materialization` | **0** |
| #59 | PR D — Financeiro V2: camada de apresentação | `feat/financeiro-v2-presentation` | **0** |
| #60 | PR B — Financeiro V2: motor de leitura por período | `feat/financeiro-v2-runtime-read-model` | **0** |
| #61 | R0 — motor de reconciliação do ledger (só leitura) | `chore/ledger-reconciliation-r0` | **0** |

**Consequência:** estas PRs são **arqueologia**, não integração pendente. Não há
nada para extrair delas — o conteúdo está no `master`. A ação correta é
**fechá-las** com nota de que foram absorvidas, não rebasear nem mesclar.

> ⚠️ Fechar PRs no GitHub é uma ação sobre o repositório partilhado. Fica a
> aguardar autorização explícita da dona — ver §6.

Confirmação estrutural do mesmo facto, no `master` de hoje:

```text
src/domain/billing/          src/domain/realtime/
src/domain/dashboard/        src/domain/reports/
src/domain/finance-v2/       src/domain/scheduling/
src/domain/update-notices/
```

`src/application/` e `src/infrastructure/` **não existem** no `master`. A
adoção continua a ser por área tocada (`ARCHITECTURE.md`, nota de estado atual),
não uma migração em bloco.

---

## 2. As 7 branches que ainda carregam algo

Só estas têm commits fora do `master`.

| Branch | Commits | O que traz | Classificação |
|---|---|---|---|
| `fix/atomic-contract-calendar-sync` | 27 | 84 ficheiros: recorrência, contratos, health, **migrations 066/067**, `planning/` | `KEEP_AS_HISTORICAL_REFERENCE` + `PORT_MINIMAL_CODE` |
| `handoff/2026-08-24` (PR #66) | 5 | 3 documentos novos + script de repair + teste | `PORT_DOC_ONLY` |
| `chore/repair-historical-cashflow` | 2 | `FINANCEIRO-PENDENTE.md`, script de repair, teste | `STANDBY` (frente própria) |
| `test/isolated-production-tenants` | 2 | provisionamento de tenants de teste + prova de isolamento | `PORT_TEST_ONLY` |
| `fix/pwa-update-single-prompt` | 1 | unificação da deteção de atualização do service worker | `PORT_MINIMAL_CODE` |
| `docs/ci-infra-nota-2026-08-07` | 2 | nota de incidente de infraestrutura do CI | `PORT_DOC_ONLY` |
| `fix/gitattributes-migration-checksums` | 1 | `.gitattributes` escopado a 064/065 | `PORT_MINIMAL_CODE` |

### 2.1 `fix/atomic-contract-calendar-sync` — congelada, e continua congelada

`AGENTS.md` §5 é explícito: esta branch **não pode ser mesclada nem implantada
como um todo**. Nada aqui altera isso.

Mas ela é a **única** fonte de duas migrations que nunca entraram:

```text
supabase/migrations/  … 065 … [066 AUSENTE] [067 AUSENTE] … 068 …
```

- `066_secure_migrations_ledger.sql`
- `067_outbox_foundation.sql`

O `master` de hoje não tem **nenhum** vestígio de outbox em runtime — a única
menção é a 065, que revoga grants de tabelas que a 067 criaria, e um teste de
consistência documental. Ou seja: **`ARCHITECTURE.md` e `ENGINEERING-STANDARD.md`
descrevem «auditoria e outbox dentro da transação» como regra, mas a fundação do
outbox não existe na base.**

Isto é uma lacuna real e fica registada como tal. Não é trabalho para agora —
ver §4, P9.

### 2.2 PR #66 — não mesclar

A base de #66 é `chore/repair-historical-cashflow`, não `master`. Mesclá-la
arrastaria a frente de repair para dentro do `master`. Se os documentos dela
forem precisos, copiam-se para uma branch documental criada do `master` atual —
exatamente o que este documento é.

---

## 3. Lacunas provadas no código real do `master`

Cada item abaixo foi lido no `origin/master`, não inferido. São a razão pela qual
a fila começa em correções e não em funcionalidades novas.

### 3.1 Folha de pagamento — `src/app/actions/payroll.ts`

| # | Defeito | Evidência |
|---|---|---|
| P0A-1 | Erro de query vira default silencioso | `const { data: settings } = await …` — sem `error`. `settings?.hourly_rate ?? 8`, `?? 9.6`, `?? 25`. Uma query falhada e uma configuração ausente são indistinguíveis. |
| P0A-2 | Ponto: erro vira 0 horas | `const { data: dailyClocks } = await …` — sem `error`; `(dailyClocks ?? [])`. |
| P0A-3 | Faltas: erro vira 0 faltas | `const { data: absences } = await …` — sem `error`. |
| P0A-4 | Registos existentes: erro vira «não há ajustes» | `const { data: existing } = await …` — sem `error`. Ajustes manuais e estado anterior perdem-se num recálculo. |
| P0A-5 | **Recálculo por cima de APROVADO/PAGO** | O `upsert` preserva `status` e `paid_at` mas reescreve `worked_hours`, `gross_salary`, `net_salary`, etc. Um registo pago com €1.200 em caixa pode passar a €1.250 na folha e continuar «pago» — caixa e folha divergem sem sinal. |
| P0A-6 | Ajuste sem máquina de estados | `adjustPayrollRecord` só valida período financeiro. Um registo `aprovado` ou `pago` pode ser alterado. |
| P0A-7 | Ajuste sobrescreve horas e taxa | `PayrollAdjust` aceita `worked_hours`, `hourly_rate`, `days_worked`. O ajuste manual reescreve a base do cálculo em vez de acrescentar uma linha. |
| P0A-8 | **25% de hora extra hardcoded** | `overtimeHours * hourlyRate * 0.25` em `adjustPayrollRecord`, enquanto `payroll-calc.ts` usa `settings.overtime_rate_pct`. Duas regras para a mesma coisa. |
| P0A-9 | Aprovação sem transição válida | `approvePayrollRecords` faz `update({ status: "aprovado" })` sobre os ids recebidos, sem ler o estado atual. Um registo **pago** volta a «aprovado» e o movimento de caixa fica órfão. |
| P0A-10 | Lote não prova identidade | Nem `approvePayrollRecords` nem `markPayrollPaid` comparam `ids.length` com o número de registos resolvidos no mesmo tenant. Ids inexistentes ou de outra empresa são silenciosamente ignorados. |
| P0A-11 | Auditoria conta história falsa | `before: { net_salary: rec.gross_salary, gross_salary: rec.gross_salary }` — o `net_salary` anterior é registado como sendo o `gross_salary`. |
| P0A-12 | Fórmula duplicada | `calcAdjustedNetSalary` existe em `payroll-calc.ts` e **não é usada** por `adjustPayrollRecord`, que reimplementa a soma. |

### 3.2 Pagar a folha — `markPayrollPaid`

| # | Defeito | Evidência |
|---|---|---|
| P0B-1 | **Não é transação** | `UPDATE payroll_records → SELECT cash_flow_entries → INSERT cash_flow_entries`, em três passos separados numa Server Action. Falha entre o 1.º e o 3.º deixa salário pago sem saída de caixa. |
| P0B-2 | Leitura dos registos sem verificar erro | `const { data: records } = await …` — sem `error`. Query falhada → `records = []` → `ok: true` sem ter pago nada. |
| P0B-3 | Lookup de caixa sem verificar erro | `const { data: existingRefs } = await …` — sem `error`. Falha assume «não existe» e tenta inserir tudo. |
| P0B-4 | Montante inválido é filtrado, não bloqueado | `.filter(… && isValidCashFlowAmount(r.net_salary))`. O registo é marcado **pago** e simplesmente não gera caixa. |
| P0B-5 | Rascunho pode ser pago | O filtro é `status !== "pago"` — inclui `rascunho`. Não exige `aprovado`. |
| P0B-6 | Data de caixa em UTC | `new Date().toISOString().split("T")[0]` — proibido por `ENGINEERING-STANDARD.md` §6. Existe `src/lib/lisbon-time.ts`. |

A identidade `reference_type = "payroll"` / `reference_id = payroll_record.id`
**já existe** no domínio. Não se cria outra — confirma-se se há `UNIQUE` a
sustentá-la.

### 3.3 Férias ↔ faltas — `src/app/actions/vacation.ts`

| # | Defeito | Evidência |
|---|---|---|
| P0C-1 | **Não é transação** | `UPDATE vacation_requests → INSERT absences → INSERT notifications`, em sequência. |
| P0C-2 | **Erro do INSERT da ausência é ignorado por completo** | `await admin.from("absences").insert({…});` — sem `error`, sem `if`. Falhar aqui devolve `ok: true`. Pedido aprovado, ausência inexistente. |
| P0C-3 | Sem identidade entre pedido e ausência | A tabela `absences` (migration `007_timesheets_absences.sql`) **não tem** coluna de origem. Aprovar duas vezes cria duas ausências. |
| P0C-4 | Sem validação de transição | `reviewVacationRequest` não lê o `status` atual. `aprovado → rejeitado` passa, e a ausência antiga fica. |
| P0C-5 | `deleteAbsence` não conhece a origem | Apagar a ausência deixa o pedido «aprovado» sem ausência correspondente. |

### 3.4 Disponibilidade — `getSubstituteSuggestions` em `src/app/actions/absences.ts`

| # | Defeito | Evidência |
|---|---|---|
| P0D-1 | **Falha aberta em faltas** | `new Set((absencesRes.data ?? []).map(…))` — o `error` de `absencesRes` nunca é lido. Query falhada ⇒ conjunto vazio ⇒ **quem está de férias aparece disponível**. |
| P0D-2 | Falha aberta em conflitos | `logQueryFailure("…:services", servicesError)` regista mas prossegue. `conflictCount` cai para 0 ⇒ quem está ocupado aparece livre. |
| P0D-3 | Não existe estado `UNKNOWN` | O resultado só sabe pontuar. Não distingue «disponível» de «não sei». |

### 3.5 Cálculo puro — `src/lib/payroll-calc.ts`

| # | Defeito | Evidência |
|---|---|---|
| P0F-1 | Dia civil derivado de UTC | `t.clock_in_at.slice(0, 10)` para contar dias trabalhados. Uma entrada às 00:30 de Lisboa em horário de verão é 23:30 UTC do dia anterior — conta no dia errado, e o subsídio de alimentação vai com ele. |
| P0F-2 | Faltas contadas em dias corridos | `(aEnd - aStart) / 86400000 + 1`. Sexta→segunda = 4 dias. Sem calendário laboral. |
| P0F-3 | `dailyHours = contractedHours / 22` | 22 dias fixos, independentemente do mês. |
| P0F-4 | «Bruto» é horas × taxa | `grossSalary = workedHours * hourlyRate`. **Não** é o salário bruto mensal contratual que o novo modelo pede. |

### 3.6 Documentos de colaborador — `src/app/actions/collaborator-documents.ts`

Confirmado que `recibo_salario` já é uma categoria suportada e que o upload
recebe `companyId`/`collaboratorId` do cliente usando o cliente administrativo.
A autorização tem de ser endurecida **antes** de o sistema ser reutilizado para
documentos salariais.

---

## 4. Fila de execução

A ordem é por dependência, não por preferência. **Não se começa uma fase com a
anterior partida.**

| Fase | Frente | Branch prevista | Base necessária | Estado |
|---|---|---|---|---|
| **P0A** | Blindagem da folha atual (§3.1, §3.5) | `fix/payroll-state-integrity` | nenhuma — só código | **Pronta a começar** |
| **P0B** | Pagamento atómico da folha (§3.2) | `fix/payroll-payment-atomicity` | **RPC + migration** | `PRODUCTION_GATE` — ver §5 |
| **P0C** | Férias ↔ faltas (§3.3) | `fix/vacation-absence-integrity` | **coluna de origem + RPC** | `PRODUCTION_GATE` — ver §5 |
| **P0D** | Disponibilidade fecha em erro (§3.4) | `fix/availability-fail-closed` | nenhuma — só código | **Pronta a começar** |
| **P0E** | Autorização de documentos (§3.6) | `fix/collaborator-document-authorization` | nenhuma — só código | **Pronta a começar** |
| P1 | Pagamentos como fonte única | `feat/finance-payments-single-source` | reproduzir o defeito primeiro | Depende de P0 |
| P2 | Fundação salarial mensal | `feat/payroll-monthly-gross-foundation` | auditoria + provável migration | Depende de P0A |
| P3 | Linhas de folha explicáveis | `feat/payroll-explainable-lines` | migration | Depende de P2 |
| P4 | Ponto/faltas/férias → work entries | `feat/payroll-work-entries` | políticas por tipo de falta | Depende de P2, P0C |
| P5 | Equipas / disponibilidade | `feat/team-availability` | — | Depende de P0D |
| P6 | Documentos na folha | `feat/payroll-documents` | estender `attachments` (074) | Depende de P0E, P2 |
| P7 | Mecânico | `feat/mechanic-category` | **descobrir o alvo primeiro** | Bloqueada por investigação |
| P8 | Relatórios / Financeiro V2 | — | consumir o mesmo read model | Depende de P1 |
| P9 | Fundação do outbox (066/067) | — | migrations congeladas + ledger | `PRODUCTION_GATE` |
| P10 | Limpeza final | — | — | Última |
| P11 | Migration 070 | — | `DO_NOT_APPLY` | Congelada |

**Três frentes podem arrancar já** — P0A, P0D e P0E são exclusivamente código,
sem dependência de schema, sem migration, sem toque em produção além do deploy
normal do `master` via PR.

---

## 5. O bloqueio que condiciona metade da fila

`CLAUDE.md` (2026-08-17, verificação read-only contra produção) regista:

```text
070 → UNVERIFIED                          ledger: ABSENT
071 → VERIFIED_APPLIED_OUTSIDE_LEDGER     ledger: ABSENT
072 → VERIFIED_APPLIED_OUTSIDE_LEDGER     ledger: ABSENT
073 → VERIFIED_APPLIED_OUTSIDE_LEDGER     ledger: ABSENT
```

Última entrada real do ledger: **069**, a 2026-08-05. As restantes foram
aplicadas pelo SQL Editor, que não escreve no ledger.

**`run-migrations --apply` está bloqueado por desenho** até o ledger ser
reconciliado, e o `migration-drift-guard` aborta com
`MIGRATION_LEDGER_SCHEMA_DRIFT` antes da primeira escrita. Continua válido:

```text
DO_NOT_APPLY   DO_NOT_BASELINE   DO_NOT_RECONCILE
BACKFILL = 0   HISTORICAL_REPAIR_WRITE = 0
```

Consequência direta e não negociável, por `AGENTS.md` §4:

> É proibido publicar código que chame tabelas, colunas, views, triggers ou RPCs
> que ainda não existam em produção.

Logo **P0B e P0C podem ser escritos, testados e revistos, mas não podem ser
publicados** enquanto a respetiva migration não estiver aplicada em produção com
autorização explícita. A RPC e o código consumidor não entram na mesma PR: a
migration vai primeiro, isolada, e o consumidor só depois.

Isto não é motivo para parar — é motivo para **P0A, P0D e P0E irem primeiro**.

---

## 6. Decisões que pertencem à dona, não ao agente

| # | Decisão | Porquê não pode ser tomada aqui |
|---|---|---|
| D1 | Fechar as PRs #47, #50–#61 como absorvidas | Ação sobre o repositório partilhado. O conteúdo está no `master`, mas fechar é decisão de quem é dono do repositório. |
| D2 | Efeito salarial de cada tipo de falta | `doenca_com_baixa`, `doenca_sem_baixa`, `pessoal_justificado`, `formacao` e subsídio de alimentação em dia de falta são regras de negócio e de lei laboral. Sem política escrita, o motor não inventa — recusa calcular essa componente. |
| D3 | Política de sábado (`SATURDAY_PAY_POLICY`) | Sábado não é automaticamente hora extra. Precisa de regra: normal, extra, ou dependente do horário contratado. |
| D4 | Retenção de recibos de vencimento | Existe `RETENTION_MONTHS = 3` para documentos de colaborador. Não se assume que um recibo de vencimento expira em três meses — obrigações legais de conservação são outra ordem de grandeza. |
| D5 | Fonte do salário bruto mensal | Se não existir salário efetivo por data, é preciso decidir entre campo simples e tabela com `effective_from`. A recomendação técnica é `effective_from` (uma alteração de salário em Outubro não pode reescrever a folha de Setembro), mas a decisão é de negócio. |
| D6 | Retomar ou arquivar a frente de repair histórico | `chore/repair-historical-cashflow` está preparada e por executar. `BACKFILL = 0` mantém-se. |

Nenhuma destas bloqueia P0A, P0D ou P0E.

---

## 7. O que este documento não é

- Não é autorização para nada.
- Não é uma segunda fonte de regras — ver o aviso no topo.
- Não substitui `docs/PLANO-MESTRE.md`, que continua canónico para o roadmap.
- Os números que contém são fotografias de 2026-08-24. Antes de agir sobre
  qualquer um deles, voltar a medir.
