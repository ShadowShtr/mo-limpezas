# Mapa operacional do código

Use este ficheiro para localizar uma alteração pequena. Leia primeiro o
percurso afetado, os seus consumidores e os testes indicados. As decisões e
incidentes antigos ficam no [índice geral da documentação](../README.md); não
são leitura inicial para uma correção.

## Cobrança diária

```text
/dashboard/cobrancas
  → page.tsx carrega o dia inicial
  → CobrancasTabs monta a aba Diário
  → DailyBillingClient consulta e recebe comandos
  → actions/daily-billing.ts autentica, lê e chama a RPC
  → set_service_payment_atomic persiste serviço + caixa
```

| Responsabilidade | Entrada |
|---|---|
| Página e dados iniciais | `src/app/(dashboard)/dashboard/cobrancas/page.tsx` |
| Seleção da aba | `src/app/(dashboard)/dashboard/cobrancas/_components/cobrancas-tabs.tsx` |
| Estado da consulta e dos botões | `src/app/(dashboard)/dashboard/cobrancas/_components/daily-billing-client.tsx` |
| Identidade e ciclo das consultas | `src/app/(dashboard)/dashboard/cobrancas/_components/use-daily-billing-query.ts` |
| Sessões do editor e comandos pendentes | `src/app/(dashboard)/dashboard/cobrancas/_components/use-daily-billing-payments.ts` |
| Apresentação de uma linha | `src/app/(dashboard)/dashboard/cobrancas/_components/payment-row.tsx` |
| Leitura, autorização e comando | `src/app/actions/daily-billing.ts` |
| Regra económica da escrita | `supabase/migrations/097_service_payment_period_atomic.sql` |
| Outro consumidor do comando | `src/app/(dashboard)/dashboard/calendario/_components/service-detail-sheet.tsx` |
| Testes focados | `src/__tests__/daily-billing-client.test.tsx`, `src/__tests__/atomic-rpc-results.test.ts`, `src/__tests__/service-payment-period-atomic.pg.test.ts` |

Para um botão de pagamento, começar pelo componente, seguir
`PaymentRow → useDailyBillingPayments → setServicePayment` até
`set_service_payment_atomic` e procurar os nomes antes de editar. Uma recarga
segue `DailyBillingClient → useDailyBillingQuery → getDailyBilling`. A UI não
volta a calcular o valor que a RPC confirma.

## Folha de pagamento

```text
/dashboard/folha-pagamento
  → page.tsx faz somente leitura
  → PayrollClient apresenta e inicia comandos explícitos
  → actions/payroll.ts coordena autorização e RPCs
  → lib/payroll-calc.ts contém o cálculo puro
  → migrations 096, 098, 099 e 100 persistem regras atómicas atuais
```

| Responsabilidade | Entrada |
|---|---|
| Página e identidade do período | `src/app/(dashboard)/dashboard/folha-pagamento/page.tsx` |
| Lista, seleção e PDF | `src/app/(dashboard)/dashboard/folha-pagamento/_components/payroll-client.tsx` |
| Editor manual | `src/app/(dashboard)/dashboard/folha-pagamento/_components/payroll-edit-sheet.tsx` |
| Actions e orquestração | `src/app/actions/payroll.ts` |
| Cálculo puro | `src/lib/payroll-calc.ts` |
| Estado permitido | `src/domain/payroll/payroll-state.ts` |
| Persistência atual | `supabase/migrations/096_payroll_period_atomic.sql`, `098_payroll_base_salary_and_net_override.sql`, `099_payroll_extra_days_and_advances.sql`, `100_payroll_clock_vs_manual.sql` |

Abrir a página não deve escrever. Alterações de cálculo exigem seguir todos os
escritores e a apresentação do PDF; alterações de estado exigem conferir as
RPCs e o bloqueio do período.

## Migrations

```text
scripts/run-migrations.mjs (CLI e ambiente)
  → scripts/lib/migration-runner-guards.mjs (argumentos e confirmação)
  → scripts/lib/migration-blocklist.mjs (bloqueios)
  → scripts/lib/migration-runner-core.mjs (seleção, execução e ledger)
  → supabase/migrations/*.sql
  → public._migrations
```

Sem argumentos, o runner é dry-run. Escrita exige `--apply` e confirmação,
mas executar migrations continua proibido sem autorização explícita. Não
carregar o wrapper em testes: ele lê `.env`. Testar guardas como funções puras e
o núcleo com cliente controlado ou PostgreSQL descartável.

Testes principais: `src/__tests__/migration-runner-guards.test.ts`,
`migration-runner-core.test.ts`, `migration-runner-targeted-apply.test.ts` e os
ficheiros `*.pg.test.ts` de atomicidade. Migrations publicadas são append-only;
correções entram num ficheiro novo.

## Testes e comandos

O projeto usa Vitest em `vitest.config.ts`; os testes ficam em
`src/__tests__`. O ambiente padrão é Node e testes de componentes declaram
`// @vitest-environment jsdom` no próprio ficheiro.

```powershell
npm test -- src/__tests__/daily-billing-client.test.tsx
npm run typecheck
npm run lint
npm test
```

Antes de merge, executar também `git diff --check` e `npm run build`. Ler o
`prebuild` no `package.json` antes do build, pois ele valida ambiente, segurança
e atualiza o carimbo do service worker.

## Medição inicial de contexto

Em 12/09/2026, a localização de COB-01 exigiu quatro ficheiros de execução
(`page.tsx`, `cobrancas-tabs.tsx`, `daily-billing-client.tsx` e
`actions/daily-billing.ts`), uma RPC e os consumidores do nome da action. A
pesquisa automática por esses símbolos demora menos de um segundo neste
checkout; o tempo humano anterior não estava instrumentado. A partir deste
mapa, cada tarefa deve registar separadamente tempo de localização, leitura,
implementação e testes, conforme a ficha MET-01.
