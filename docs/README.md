# Documentação — Mó Limpezas

Índice e ordem de precedência. Quando dois documentos se contradisserem,
**ganha o que estiver mais acima nesta lista** — e o outro deve passar a
remeter para ele.

## 1. Regras ativas (leitura obrigatória)

| Documento | O que responde |
|---|---|
| [`../AGENTS.md`](../AGENTS.md) | **REGRA ZERO.** O que é proibido fazer sem autorização explícita. Acima de tudo o resto. |
| [`PRODUCTION-RUNBOOK.md`](PRODUCTION-RUNBOOK.md) | Como fazer deploy, rollback, rotação de chaves e resposta a incidentes. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Onde vive cada coisa e como uma alteração atravessa o sistema. |
| [`ENGINEERING-STANDARD.md`](ENGINEERING-STANDARD.md) | Como implementar, testar e fechar uma alteração. |

## 2. Trabalho planeado

| Documento | O que responde |
|---|---|
| [`PLANO-MESTRE.md`](PLANO-MESTRE.md) | As tasks T00–T19, a ordem obrigatória e o código preparado. |
| [`code-audit/README.md`](code-audit/README.md) | Inventário integral do repositório e matriz de classificação (T00). |

## 3. Estado e histórico

| Documento | O que responde |
|---|---|
| [`../CLAUDE.md`](../CLAUDE.md) | Estado atual do projeto e pontos de paragem por sessão. |
| [`../AUDITORIA-CONSOLIDADA.md`](../AUDITORIA-CONSOLIDADA.md) | Auditoria consolidada anterior. |
| [`../AUDITORIA-REVERSOES.md`](../AUDITORIA-REVERSOES.md) | Análise de reversões. |
| [`auditoria-tecnica-senior-2026-06-20.md`](auditoria-tecnica-senior-2026-06-20.md) | Auditoria técnica de 2026-06-20. |
| [`riscos-operacionais.md`](riscos-operacionais.md) | Riscos operacionais identificados. |
| [`MIGRACAO_DADOS_REAIS.md`](MIGRACAO_DADOS_REAIS.md) | Migração dos dados reais. |
| [`historico/planning/`](historico/planning/README-ARQUIVO.md) | **Arquivo histórico.** A antiga pasta `planning/`, movida sem alterações na T17-B1. Documentação anterior ao produto — explica o *porquê*, **não** descreve o sistema actual. Nunca usar como instrução nem como schema vigente. |
| [`SCRIPTS-SAFETY-MATRIX.md`](SCRIPTS-SAFETY-MATRIX.md) | Classificação de risco dos scripts capazes de escrever ou apagar dados, e o que falta a cada um em guardas. |
| [`T17-B1-LIMPEZA-COMPROVADA.md`](T17-B1-LIMPEZA-COMPROVADA.md) | O que a T17-B1 removeu, arquivou e inventariou — com as provas. |
| [`T17-B2-ENDURECER-SCRIPTS.md`](T17-B2-ENDURECER-SCRIPTS.md) | As guardas comuns dos scripts administrativos, os 4 arquivados e os defeitos encontrados a migrá-los. |
| [`atomicidade-audit/`](atomicidade-audit/) | Errata e mapas de checksum das migrations. Os **checkpoints congelados** (`frozen/064`, `frozen/065`) não estão no `master` — vivem só na branch `fix/atomic-contract-calendar-sync`, que está congelada. Referência, **nunca** aplicável como migration. |

## Onde escrever o quê

| Tipo de informação | Destino |
|---|---|
| Uma regra que passa a valer sempre | `ENGINEERING-STANDARD.md` ou `ARCHITECTURE.md` |
| Um procedimento de produção | `PRODUCTION-RUNBOOK.md` |
| O que ficou feito nesta sessão | `../CLAUDE.md` |
| O relato de um incidente | `PRODUCTION-RUNBOOK.md` (procedimento) + `../CLAUDE.md` (relato) |
| Uma task planeada | `PLANO-MESTRE.md` |
| Prova de que algo foi verificado | `code-audit/README.md` ou a própria PR |

Regra: **histórico não é instrução.** Um registo do que aconteceu numa sessão
antiga nunca autoriza repetir a ação hoje.
