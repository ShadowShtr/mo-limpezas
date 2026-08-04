# Runbook de migrations

Este é o único procedimento vigente para migrations da Mó Limpezas.

## Estado autorizado

- Ativas: 001-063 e as quatro migrations legadas listadas em `supabase/migration-policy.json`.
- Congeladas: checkpoints 064/065 guardados em `docs/atomicidade-audit/frozen/`.
- Ledger: `public._migrations`.
- Não existe migration pendente autorizada neste momento.

## Regras invioláveis

1. Não editar migration já registada.
2. Não aplicar ficheiro que não esteja classificado como ativo.
3. Não marcar migrations em massa como aplicadas.
4. Não misturar dados de demonstração com migrations.
5. Não executar SQL agregado.
6. Não aplicar alteração destrutiva junto da primeira versão do código que depende dela.
7. Não executar migration se o fingerprint real divergir das pré-condições aprovadas.
8. Não usar o runner para reconciliar manualmente 064/065.

## Validação local obrigatória

```powershell
node scripts/run-migrations.mjs --dry-run
npm.cmd test
npx.cmd tsc --noEmit --incremental false
npm.cmd run lint
npm.cmd run build
git diff --check
```

O dry-run é somente leitura. Se o ledger não existir, tiver checksum nulo, migration desconhecida ou checkpoint congelado registado, ele deve falhar.

## Criação de uma migration nova

1. atualizar primeiro `docs/ESTADO-ATUAL.md` com objetivo e pré-condições;
2. criar ficheiro numerado novo, sem alterar os checkpoints;
3. adicionar o nome a `activeMigrations` somente após revisão;
4. escrever SQL transacional e preferencialmente aditivo;
5. criar preflight read-only;
6. revisar locks, tempo, RLS, grants, triggers, funções e rollback;
7. validar que o código antigo continua funcional;
8. executar ensaio com `BEGIN`, verificações e `ROLLBACK`, apenas em janela controlada;
9. confirmar que o fingerprint voltou ao estado inicial;
10. obter autorização explícita para aplicação definitiva.

## Aplicação definitiva

1. confirmar projeto, commit e ambiente;
2. confirmar backup e mecanismo de recuperação;
3. pausar jobs de escrita;
4. capturar fingerprint, contagens e versão do ledger;
5. definir `MIGRATION_CONFIRM_PROJECT_REF` com a referência pública já confirmada do projeto;
6. executar somente o ficheiro aprovado através de `node scripts/run-migrations.mjs --apply`;
7. verificar checksum e objetos criados;
8. testar RLS, RPCs e invariantes;
9. publicar código compatível;
10. testar com contas controladas, reativar jobs e monitorizar.

## Interrupção obrigatória

Parar imediatamente quando houver:

- checksum divergente;
- SQL não classificado;
- 064/065 no ledger;
- lock inesperado;
- contagem alterada sem previsão;
- falha de RLS ou autorização;
- erro parcial;
- fingerprint diferente;
- falta de backup confirmado.

Nenhum documento histórico substitui este runbook.
