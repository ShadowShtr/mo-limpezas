<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 🔴 REGRA ZERO — PRODUÇÃO É UM SISTEMA VIVO

`molimpezas.pt` é utilizado diariamente por pessoas reais para executar o
trabalho da empresa. Produção NÃO é ambiente de teste.

Esta regra tem prioridade sobre qualquer outra instrução do repositório.

Origem: incidente de 2026-08-05 — um push para a branch ampla
`fix/atomic-contract-calendar-sync` acabou implantado como Production no
Vercel (via `vercel --prod` manual, correndo a partir do checkout errado) e
tomou `molimpezas.pt`, seguido de uma chave administrativa inválida que
causou loop de login. Ver `docs/PRODUCTION-RUNBOOK.md` para o relato completo
e `CLAUDE.md` para o ponto de paragem correspondente.

## 1. Ações proibidas sem autorização explícita do proprietário

Nenhum agente, automação ou programador pode executar por iniciativa própria:

- `vercel --prod`
- `vercel deploy --prod`
- `vercel --force`
- "Redeploy as Production" no painel da Vercel
- `vercel promote`
- push direto para `master`
- merge de PR para `master`
- execução de SQL em produção
- execução de migrations
- `supabase db push`
- `migration repair`
- scripts com `--apply`
- alteração de variáveis de ambiente de Production
- rotação de chaves
- alteração de domínios, crons, RLS, Storage ou Auth
- qualquer escrita de teste na base de produção

A autorização deve estar escrita na tarefa/conversa atual e indicar exatamente
qual ação foi autorizada. Autorizações antigas não podem ser reutilizadas.

## 2. Único fluxo normal permitido para produção

O fluxo normal é obrigatoriamente:

1. Criar uma branch curta a partir do `master` atualizado.
2. Fazer somente uma alteração pequena e claramente delimitada.
3. Abrir PR para `master`.
4. Rever todos os ficheiros do diff.
5. Executar:
   - `git diff --check`
   - `npx tsc --noEmit`
   - `npm run lint`
   - `npm test`
   - `npm run build`
6. Confirmar dependências de banco e compatibilidade com produção.
7. Apresentar plano de rollback.
8. Receber autorização explícita do proprietário.
9. Fazer merge no GitHub.
10. Deixar a Vercel publicar automaticamente a Production Branch `master`.

Nunca usar `vercel --prod` como caminho normal de publicação.

## 3. Verificação obrigatória antes de qualquer merge

Antes do merge, mostrar:

- branch atual;
- SHA do commit;
- SHA atual de `origin/master`;
- lista completa de ficheiros alterados;
- migrations incluídas;
- objetos de banco exigidos pelo código;
- resultado de testes, TypeScript, lint e build;
- plano de rollback;
- confirmação de que não existem alterações não relacionadas.

Se qualquer item estiver incerto, o merge fica bloqueado.

## 4. Código e banco devem ser compatíveis

É proibido publicar código que chame tabelas, colunas, views, triggers ou RPCs
que ainda não existam em produção.

Para mudanças aditivas e compatíveis:

1. validar a migration;
2. backup;
3. aplicar a migration com autorização;
4. verificar o banco;
5. só depois publicar o código consumidor.

Mudanças incompatíveis devem seguir expand/migrate/contract e nunca remover
objetos ainda usados pela versão atualmente publicada.

## 5. Branches amplas nunca vão diretamente para produção

Branches com várias funcionalidades, migrations, refatorações e documentação
misturadas nunca podem ser mescladas como um único PR.

Devem ser preservadas como referência e divididas em branches pequenas,
criadas a partir do `master` atual.

A branch `fix/atomic-contract-calendar-sync` está CONGELADA e NÃO pode ser
mesclada ou implantada como um todo.

## 6. Rollback de emergência

`vercel promote <deployment-conhecido>` é permitido apenas como rollback de
emergência, após autorização explícita e confirmação de que o deployment:

- veio do `master`;
- corresponde ao commit esperado;
- foi anteriormente validado;
- é compatível com o estado atual do banco.

Depois do rollback, validar domínio principal, login, dashboard e logs.

## 7. Segredos e variáveis

Nunca imprimir, guardar em commit, logar ou enviar chaves pelo chat.

Alterar uma variável na Vercel exige um NOVO deployment do `master`.
Promover um deployment antigo não incorpora a variável nova.

## 8. Incidente em produção

Ao encontrar falha em produção:

1. parar imediatamente todo trabalho não relacionado;
2. não tentar várias correções ou deployments aleatórios;
3. identificar o deployment e commit ativos;
4. capturar logs;
5. restaurar um deployment conhecido quando necessário;
6. corrigir numa branch limpa;
7. documentar causa, correção e prevenção;
8. só retomar o roadmap depois de produção estar estável.

## 9. Scripts perigosos

Todo script capaz de escrever ou apagar dados deve:

- funcionar em dry-run por padrão;
- exigir `--apply`;
- mostrar ambiente, projeto e quantidade de linhas afetadas;
- recusar produção sem confirmação adicional;
- nunca usar valores padrão que apontem para produção.

## 10. Regra de dúvida

Na dúvida, NÃO executar.

Parar, apresentar o estado encontrado e pedir autorização.
