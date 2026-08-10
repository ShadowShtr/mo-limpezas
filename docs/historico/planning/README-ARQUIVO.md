# Arquivo histórico — `planning/`

> Este directório é **histórico**. Foi movido de `planning/` para
> `docs/historico/planning/` na **T17-B1** (2026-08-10), sem uma única alteração
> ao conteúdo dos ficheiros.

## O que isto é

A documentação de planeamento escrita **antes** do produto existir: features
imaginadas, stack a escolher, esquema de base de dados proposto, orçamento,
roadmap por fases, wireframes e o briefing para a dona da empresa.

Foi útil e continua a explicar **porque** o produto ficou como ficou. É por isso
que foi preservado em vez de apagado.

## O que isto NÃO é

**Não é fonte operacional.** Nada aqui descreve o sistema como ele está hoje.
Números, tabelas, nomes de colunas, preços e prazos deste directório podem estar
— e em muitos casos estão — desactualizados face ao código em produção.

🔴 **Nunca usar um documento deste directório como instrução de implementação
nem como descrição do schema actual.**

## Onde está a verdade actual

| Pergunta | Documento vigente |
|---|---|
| O que é proibido fazer sem autorização | [`../../../AGENTS.md`](../../../AGENTS.md) — **REGRA ZERO** |
| O trabalho planeado (T00–T19) | [`../../PLANO-MESTRE.md`](../../PLANO-MESTRE.md) |
| Estado da sessão e ponto de retoma | [`../../HANDOFF-2026-08-08.md`](../../HANDOFF-2026-08-08.md) |
| Onde vive cada coisa | [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) |
| Como implementar e fechar uma alteração | [`../../ENGINEERING-STANDARD.md`](../../ENGINEERING-STANDARD.md) |
| Operação de produção | [`../../PRODUCTION-RUNBOOK.md`](../../PRODUCTION-RUNBOOK.md) |
| Índice e precedência da documentação | [`../../README.md`](../../README.md) |

## Regra de escrita

**Histórico não se reescreve.** Se um documento deste directório estiver errado
face ao presente, a correcção pertence ao documento vigente correspondente — não
a este. Não "melhorar" texto antigo, não actualizar números, não apagar
contexto.
