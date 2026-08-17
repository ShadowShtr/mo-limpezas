# Fechamento mensal — runtime

**Criado:** 2026-08-17
**Schema:** `public.financial_periods`, migration 071 (já aplicada em produção)
**Migration nova:** nenhuma. O schema da 071 tinha tudo o que era preciso.

---

## Semântica

| Estado | Como se representa |
|---|---|
| **Aberto** | Não existe linha, **ou** existe com `status = 'open'` |
| **Fechado** | Existe linha com `status = 'closed'` |

Isto não é uma escolha desta camada — é o que a 073 já faz:

```sql
CREATE FUNCTION public.is_financial_period_open(p_company_id uuid, p_year int, p_month int)
RETURNS boolean AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.financial_periods
     WHERE company_id = p_company_id AND year = p_year AND month = p_month
       AND status = 'closed'
  );
$$;
```

`interpretarLinhaPeriodo` repete exactamente esta regra. Se divergirem, a UI diz
uma coisa e a base faz outra.

**Não se cria linha para representar "aberto".** Um mês nasce aberto por
ausência. Criar linhas só para o dizer enchia a tabela de ruído e obrigava a
distinguir "aberto explícito" de "aberto por omissão" em todo o código a jusante.

---

## Data civil, nunca `new Date()`

O processo corre em **UTC** na Vercel — não há `TZ` configurada, e isso está
documentado no `CLAUDE.md` desde a auditoria de fuso de Julho.

`periodoDeDataCivil` lê o ano e o mês **dos caracteres** da string
`YYYY-MM-DD`, sem construir um `Date`:

```ts
const year  = Number(data.slice(0, 4));
const month = Number(data.slice(5, 7));
```

Uma despesa de `2026-08-31` é de Agosto para quem a lançou em Lisboa, e
continua a ser Agosto mesmo que o servidor já esteja em Setembro em UTC.
`new Date("2026-08-31").getMonth()` é precisamente o padrão que desalinhou a
Folha de Pagamento e o Registo de Ponto em Julho.

---

## Falha fechada

Se a leitura de `financial_periods` falhar (timeout, permissão, ligação
perdida), a mutação é **recusada**. Nunca se assume "aberto".

A tentação de tratar erro-de-leitura como "aberto" é grande, porque a
alternativa incomoda o utilizador quando a base está instável. Mas o efeito é
que uma falha de infraestrutura passa a permitir escritas num mês fechado — o
que a guarda existe para impedir — e sem deixar rasto. Um erro visível é
recuperável; uma escrita indevida num período fechado é uma correcção
contabilística.

`lerEstadoPeriodo` distingue os dois casos que um `if (!data)` colapsaria:

- `data: null, error: null` → não há linha → **aberto**
- `error != null` → não se sabe → **recusa**

---

## Classificação das mutações

Critério: **efeito económico**, não a pasta onde a action vive.

### Com lock

| Action | Facto económico | Data autoritativa |
|---|---|---|
| `setPaymentStatus` → `pago` | Cria a saída de caixa do pagamento | `todayInLisbon()` — data do movimento que vai nascer |
| `setPaymentStatus` → `pendente` | Remove a saída de caixa | `period_year`/`period_month` **do pagamento** |
| `createCashFlowEntry` | Cria movimento | `data.date` — a data do movimento |
| `updateCashFlowEntry` | Altera movimento | data actual da linha; **e a nova, se mudar** |
| `deleteCashFlowEntry` | Remove movimento | `date` da linha |
| `generateInvoices` | Cria documentos financeiros | `year`/`month` do argumento |
| `updateInvoiceStatus` | Altera estado de documento | `invoice_date` |
| `deleteInvoice` | Remove rascunho | `invoice_date` |
| `adjustPayrollRecord` | Altera salário a pagar | `period_year`/`period_month` do registo |
| `approvePayrollRecords` | Fixa o valor a pagar | idem, por registo (lote inteiro) |
| `markPayrollPaid` | Cria a saída de caixa do salário | idem |
| `calculateAndSavePayroll` | Recalcula e grava a folha | `year`/`month` do argumento |
| `createEntryFromTransaction` | Cria movimento a partir do extrato | `transaction_date` |

### Sem lock — e porquê

| Action | Porque não |
|---|---|
| `confirmMatch` | Escreve `bank_reconciliation_matches` e `bank_transactions.status`. Metadados de correspondência; não cria nem altera movimento. |
| `rejectMatch` | Idem. |
| `manualMatch` | Idem — associa um movimento existente a uma linha de extrato. |
| `ignoreTransaction` | Marca uma linha de extrato como ignorada. Não toca no caixa. |
| `ensurePayrollCalculated` | Corre no **render**. Ver a secção seguinte. |

> Se alguma das quatro primeiras passar a escrever em `cash_flow_entries`, entra
> no lock. O critério é o efeito, e o efeito pode mudar.

### `updateCashFlowEntry` — os dois períodos

Mover um movimento de Julho para Agosto **retira** dinheiro de Julho e põe-no em
Agosto. Validar só o destino deixava um caminho aberto para alterar um mês
fechado: bastava editar a data de uma linha de Julho fechado para Setembro
aberto, e os totais de Julho mudavam.

| Origem | Destino | Resultado |
|---|---|---|
| aberta | aberto | passa |
| **fechada** | aberto | **recusa** |
| aberta | **fechado** | **recusa** |
| fechada | fechado | recusa |

---

## Folha de pagamento no render

`ensurePayrollCalculated` corre dentro do render de um Server Component — foi a
correcção de Julho para o crash da Folha. Aqui não serve nem uma guarda dura nem
deixar passar:

| Mês | Comportamento |
|---|---|
| **Aberto** | Materializa como sempre |
| **Fechado** | **Zero escrita.** Devolve os registos que existem, com `materializado: false` e `motivo: PAYROLL_PERIOD_CLOSED_NO_MATERIALIZATION` |
| **Estado indeterminado** | Não materializa (falha para o lado seguro) |

Uma guarda que devolvesse erro fazia a página inteira explodir ao abrir a folha
de um mês fechado. Deixar escrever criava a pior excepção possível — *«render é
read-only, excepto quando recalcula financeiramente um período fechado»*. As
duas regras coexistem: calcula, mostra, e não grava.

---

## Checklist

Só **falha de leitura** bloqueia o fecho.

| Item | Gravidade |
|---|---|
| Falha ao ler qualquer fonte | **BLOCKER** |
| Faturas em rascunho | WARNING |
| Despesas sem categoria | WARNING |
| Movimentos bancários por conciliar | WARNING |
| Pagamentos pendentes | WARNING |

Fechar um mês sem saber o que ele contém é o único caso em que a resposta certa
é indiscutivelmente "não". Os restantes são situações reais e vale a pena
mostrá-las, mas **nenhuma foi aprovada como política de empresa que impede um
fecho**. Transformá-las em bloqueios seria inventar regras de negócio a partir
de código, e o resultado previsível é a gestora não conseguir fechar Agosto por
três despesas sem categoria que lhe são indiferentes.

Se o dono decidir que alguma passa a bloquear, muda-se em `itemContagem`.

### O checklist não é a autoridade

`closeFinancialPeriod` **volta a calcular** os bloqueadores no momento da
escrita. Não é desconfiança do ecrã: entre abrir o modal e clicar em "Fechar
mês" passam segundos ou minutos, e nesse intervalo a base pode ter mudado.
Aceitar o checklist enviado pelo cliente seria aceitar uma fotografia do passado
como autorização para escrever no presente — e um cliente modificado poderia
simplesmente afirmar "zero bloqueadores".

---

## Fechar e reabrir

**Fechar** é idempotente: fechar um mês já fechado devolve o estado actual sem
mexer no `closed_at` original (perder-se-ia a data real do fecho por causa de um
duplo-clique). `closed_by` é o perfil da sessão e `closed_at` é gerado no
servidor — nenhum vem do browser.

Dois gestores a fechar em simultâneo resolvem-se pelo
`UNIQUE (company_id, year, month)` da 071: o segundo colide e o `onConflict`
converge para o mesmo estado final, em vez de rebentar com um erro de constraint
que a gestora não saberia interpretar.

**Reabrir** exige motivo — mínimo 3 caracteres úteis, `trim` aplicado. A base
também o exige (`financial_periods_reopen_needs_reason`, 071); validar em
TypeScript dá a mensagem certa antes do pedido, mas a garantia é da base.
Reabrir um mês já aberto é um no-op: não se cria linha para registar uma
reabertura que não aconteceu.

Ambas auditam em `audit_logs`:

```
financial_period_closed     meta: { year, month }
financial_period_reopened   meta: { year, month, reason }
```

Só identidade do período e do actor. **Nenhum valor financeiro** — quem fechou e
quando é o que importa auditar; os números vivem nas suas tabelas.

---

## Isolamento e desempenho

**Por empresa.** A chave do contexto por pedido é `companyId:year:month`, e o
`companyId` não é opcional. Uma chave só de ano/mês faria a primeira empresa a
ler um mês decidir o estado desse mês para todas as outras no mesmo processo —
num sistema multi-tenant, o pior tipo de bug.

**Por período.** Agosto fechado não bloqueia Setembro nem Julho. Trocar o
seletor para um mês aberto devolve as acções desse mês.

**Sem cache entre pedidos.** O estado muda por acção humana e é lido em mutações
que decidem se escrevem. Uma cache com TTL abriria uma janela em que o mês está
fechado na base e aberto na cache. O que existe é `criarContextoPeriodo`, que
memoiza dentro da **mesma** mutação: validar três datas não faz três leituras.

---

## UI

A pastilha (`Mês aberto` / `✓ Mês fechado`) e o botão vivem na casca do
Financeiro, ao lado do seletor de período. A casca continua a ser um componente
de servidor **sem efeitos** — recebe `periodStatus` já lido pela página, não o
vai buscar.

> 🔴 A UI é conveniência, não segurança. O botão desaparece num mês fechado, mas
> as server actions revalidam o estado por si e recusam mesmo que o pedido venha
> de um cliente modificado. Leituras, exports e o dashboard continuam a
> funcionar normalmente num mês fechado.

---

## Limitações conhecidas

- **`generateInvoices` não usa a RPC da 072.** A criação atómica continua por
  activar: `ATOMIC_EFFECT = PROVEN` (PGlite), `CONCURRENT_SERIALIZATION =
  NOT_PROVEN` (PGlite não dá duas ligações simultâneas). O lock de período
  aplica-se; a atomicidade da criação é outro assunto.
- **O ledger de migrations continua dessincronizado** — ver
  `docs/LEDGER-RECONCILIATION-PENDING.md`. Não afecta este runtime (as tabelas
  existem), mas bloqueia `run-migrations --apply`.
- **A 070 continua `UNVERIFIED`.** Não relacionado, mas registado no mesmo
  documento.
- **Nenhum período foi fechado em produção.** Este trabalho é runtime + testes.

---

## Ligações

- `src/domain/finance-v2/financial-period.ts` — regras puras
- `src/lib/finance-period-guard.ts` — `assertFinancialPeriodOpen`
- `src/app/actions/financial-periods.ts` — read, checklist, close, reopen
- `src/components/financeiro/period-close-controls.tsx` — pastilha e modais
- `src/__tests__/financial-period.test.ts` — 44 testes
- `supabase/migrations/071_finance_periods_and_expense_categories.sql` — schema
- `supabase/migrations/073_payment_to_cashflow.sql` — `is_financial_period_open`
