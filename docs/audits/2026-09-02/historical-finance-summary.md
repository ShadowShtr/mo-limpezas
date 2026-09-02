# TASK5 — dossier histórico read-only

Estado: `BLOCKED_READ_ONLY_REVALIDATION`

Este dossier não executou SQL contra produção. Nesta execução não existe
conector read-only nem `.env.local` configurado, e o branch
`origin/read-only/historicos-financeiros-2026-09` contém apenas a base de código,
sem manifestos de dados. Por isso não são inventados IDs, datas ou totais por
linha.

## Valores conhecidos carregados da direção

| Indicador | Valor | Proveniência |
|---|---:|---|
| Competência divergente | 29 | carry-forward; não rederivado |
| Competência fixa | 7 | carry-forward; não rederivado |
| Competência variável | 22 | carry-forward; não rederivado |
| Pago sem cashflow | 53 | carry-forward; não rederivado |
| Total pago sem cashflow | €11.251,71 | carry-forward; não rederivado |
| Pago sem `paid_at` | 14 | carry-forward; não rederivado |
| Total sem `paid_at` | €3.245,03 | carry-forward; não rederivado |
| Provenance desconhecida | 8 | carry-forward; não rederivado |
| Anexos legacy | 17 | carry-forward; não rederivado |
| Anexos novos | 19 | carry-forward; não rederivado |
| Anexos físicos | 36 | carry-forward; não rederivado |
| Anexos em falta | 0 | carry-forward; não rederivado |
| Anexos órfãos | 0 | carry-forward; não rederivado |

## Manifests

Os CSVs adjacentes contêm apenas cabeçalho e uma guarda de estado. Não
representam “zero ocorrências”; representam ausência de SELECT verificável.

Para fechar TASK5 é necessário executar, com autorização própria, somente os
SELECTs de produção e preencher as linhas técnicas. Nenhuma correção de dados,
cashflow, provenance, `paid_at` ou storage faz parte desse passo.

