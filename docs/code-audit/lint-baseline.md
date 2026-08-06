# Baseline de qualidade — Task T02

> Medir antes de apertar. Este documento regista o estado **medido** do
> repositório no momento em que os gates de qualidade foram fechados, para que
> qualquer regressão futura tenha um ponto de comparação real.

Origem: [`../PLANO-MESTRE.md`](../PLANO-MESTRE.md), secção 23 (Task T02).

## Medição — 2026-08-06, commit base `11cdea7`

| Métrica | Valor medido |
|---|---:|
| ESLint — erros | 0 |
| ESLint — warnings | 0 |
| `tsc --noEmit` — erros | 0 |
| `tsc --noEmit --noUnusedLocals --noUnusedParameters` — erros | 0 |
| Diagnósticos do compilador via auditor | 0 |

Comando usado para a medição:

```bash
npx eslint --format json -o lint-baseline.json
npx tsc --noEmit --noUnusedLocals --noUnusedParameters
```

## Decisão

O baseline estava limpo. Não havia dívida a pagar antes de apertar, por isso o
gate foi fechado imediatamente em vez de ficar como intenção:

| Guarda | Antes | Depois |
|---|---|---|
| `@typescript-eslint/no-unused-vars` | `warn` | `error` |
| `noUnusedLocals` | desligado | `true` |
| `noUnusedParameters` | desligado | `true` |
| `npm run lint:strict` | não existia | `eslint --max-warnings=0` |
| `npm run typecheck` | não existia | `tsc --noEmit` |
| `npm run quality` | não existia | typecheck + **lint:strict** + test + build |

Parâmetros intencionalmente não usados continuam permitidos com o prefixo `_`
(`argsIgnorePattern`, `varsIgnorePattern`, `caughtErrorsIgnorePattern`) — a
regra apanha código morto, não obriga a mudar assinaturas exigidas por
interfaces.

## O que ficou de fora, e porquê

| Item | Estado | Motivo |
|---|---|---|
| Workflow de CI | standby | `npm run build` precisa das variáveis de ambiente reais (`prebuild` corre `check-env.ts`). Um workflow que corra typecheck + lint:strict + test é viável e fica para PR própria, para não misturar configuração de CI com esta entrega. |
| `npm run audit:code:strict` como gate | standby | Falharia hoje, e com razão: os quatro artefactos perigosos ainda existem. Passa a ser gate assim que a **Task T03** os remover. |
| Remoção de código morto | standby | Pertence à **Task T17**. Os candidatos estão em [`README.md`](README.md) e nenhum foi removido nesta fase. |

## Como verificar

```bash
npm run typecheck
npm run lint:strict
npm test
```

Qualquer um destes a falhar significa regressão face ao baseline aqui
registado — não um gate demasiado apertado.
