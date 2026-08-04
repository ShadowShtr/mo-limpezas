# Mó Limpezas - Plataforma de gestão

Aplicação operacional para calendário, equipas, contratos, clientes, tempos, faturação e PWA.

Stack principal: Next.js 16, React 19, TypeScript, Supabase e Vercel.

## Estado antes de trabalhar

Leia nesta ordem:

1. `docs/ESTADO-ATUAL.md`;
2. `docs/MIGRATIONS-RUNBOOK.md`;
3. `docs/ATOMICIDADE-IMPLEMENTACAO.md`;
4. `docs/README.md`.

Auditorias antigas e o diretório `planning/` são históricos. Não use os seus “próximos passos” como instruções atuais.

## Desenvolvimento local

```powershell
npm.cmd install
npm.cmd run dev
```

A aplicação fica disponível em `http://localhost:3000`.

## Validação

```powershell
npm.cmd test
npx.cmd tsc --noEmit --incremental false
npm.cmd run lint
npm.cmd run build
git diff --check
```

## Migrations

O processo é controlado por:

- `supabase/migration-policy.json`;
- `scripts/run-migrations.mjs`;
- `public._migrations` no banco;
- `docs/MIGRATIONS-RUNBOOK.md`.

Os checkpoints 064/065 não são migrations executáveis. Estão preservados em `docs/atomicidade-audit/frozen/`.

Para uma inspeção somente de leitura:

```powershell
node scripts/run-migrations.mjs --dry-run
```

Não aplique migrations, não faça reconciliação de ledger e não publique a branch de correção sem seguir o runbook.

## Configuração

As variáveis são verificadas por `scripts/check-env.ts`. Segredos ficam exclusivamente nos ambientes locais e de publicação e nunca devem ser incluídos no Git ou em relatórios.

## Tarefas automáticas

As rotas programadas são definidas em `vercel.json`. Alterações em geração de serviços exigem testes de idempotência, concorrência e datas antes de publicação.

## Documentação

O índice e a classificação completa estão em `docs/README.md`.
