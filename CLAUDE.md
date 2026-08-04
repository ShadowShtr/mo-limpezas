# Instruções de trabalho - Mó Limpezas

Este ficheiro contém apenas regras atuais. O histórico está no Git e nas auditorias classificadas em `docs/README.md`.

## Leitura obrigatória

1. `AGENTS.md`;
2. `docs/ESTADO-ATUAL.md`;
3. `docs/MIGRATIONS-RUNBOOK.md`;
4. `docs/ATOMICIDADE-IMPLEMENTACAO.md`.

## Estado crítico

- `origin/master` conhecido: `5581784`.
- A branch `fix/atomic-contract-calendar-sync` contém trabalho local posterior.
- Baseline de banco esperado: 001-063 mais quatro migrations legadas.
- Os checkpoints 064/065 não são executáveis e não podem aparecer no ledger.
- A branch está bloqueada para deploy enquanto depender de RPCs presentes somente nos checkpoints.
- Não tocar no banco ou publicar sem autorização explícita.

## Regras

- Preservar alterações existentes e separar commits por assunto.
- Não editar migrations registadas.
- Não criar SQL agregado, baseline automático ou dados de demonstração no runner.
- Toda mutação composta deve ser transacional, idempotente, auditável e protegida por revisão.
- Nunca engolir erro Supabase nem devolver sucesso parcial.
- Datas civis usam regra explícita de Lisboa; instantes persistidos usam UTC.
- Não adicionar escrita direta de negócio em componente client.
- Não criar uma segunda implementação de recorrência.
- Não tratar auditoria histórica como estado atual.
- Atualizar `docs/ESTADO-ATUAL.md` junto de qualquer mudança de compatibilidade, migration ou publicação.

## Validação mínima

```powershell
npm.cmd test
npx.cmd tsc --noEmit --incremental false
npm.cmd run lint
npm.cmd run build
git diff --check
```

O resultado local não prova schema, RLS, concorrência ou Realtime. Esses pontos exigem as verificações do runbook e não devem ser declarados concluídos sem evidência.
