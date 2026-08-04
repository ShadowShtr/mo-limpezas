# Documentação da Mó Limpezas

Este índice define quais documentos podem orientar trabalho atual. Um documento não listado como **vigente** é apenas histórico ou evidência.

## Fontes vigentes

| Documento | Autoridade |
|---|---|
| `README.md` | instalação, comandos de desenvolvimento e ligações principais |
| `docs/ESTADO-ATUAL.md` | estado confirmado do código, banco e publicação |
| `docs/MIGRATIONS-RUNBOOK.md` | único procedimento autorizado para migrations |
| `docs/ATOMICIDADE-IMPLEMENTACAO.md` | estado e dependências da correção de atomicidade |
| `docs/riscos-operacionais.md` | riscos ainda relevantes e respetivos controlos |
| `docs/MIGRACAO_DADOS_REAIS.md` | registo histórico da importação; não é procedimento executável |
| `planning/docs/11-incidentes-producao.md` | registo histórico de incidentes confirmados |

## Evidência técnica

Os ficheiros em `docs/atomicidade-audit/` são capturas de uma auditoria. JSONs e hashes comprovam o que foi observado naquela data; não definem o estado futuro.

Os SQL 064/065 estão em `docs/atomicidade-audit/frozen/`. São checkpoints preservados por hash e não pertencem à cadeia executável de migrations.

## Documentos históricos

Estes documentos preservam contexto, mas contêm contagens, estados e próximos passos ultrapassados:

- `AUDITORIA_COMPLETA.txt`;
- `AUDITORIA-CONSOLIDADA.md`;
- `AUDITORIA-REVERSOES.md`;
- `docs/auditoria-tecnica-senior-2026-06-20.md`;
- `docs/atomicidade-audit/065-static-review.md`;
- `docs/atomicidade-audit/recurrence-engine-review.md`;
- todo o diretório `planning/`, exceto o registo de incidentes.

Quando houver divergência, prevalece `docs/ESTADO-ATUAL.md`, seguido do código e da inspeção read-only mais recente do banco.

## Regras documentais

1. Não registrar estado como “aplicado” sem evidência no ledger e no schema real.
2. Não transformar relatório histórico em instrução operacional.
3. Não manter dois runbooks para o mesmo procedimento.
4. Atualizar `docs/ESTADO-ATUAL.md` no mesmo commit que muda migrations, política ou compatibilidade de deploy.
5. Não guardar segredos, credenciais ou dados pessoais em documentação versionada.
