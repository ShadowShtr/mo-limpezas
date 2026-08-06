# Runbook de Produção — Mó Limpezas

`molimpezas.pt` é usado diariamente por pessoas reais. Este documento é o
processo obrigatório para qualquer coisa que toque produção — deploy,
rollback, rotação de chaves, resposta a incidente. Ler primeiro a **REGRA
ZERO** em `AGENTS.md`; este runbook é o detalhe operacional dela.

Origem: incidente de 2026-08-05 (deploy indevido da branch ampla + chave
administrativa inválida). Relato completo no `CLAUDE.md`, ponto de paragem
de 2026-08-05.

---

## 1. Deploy normal (única forma permitida)

Nunca `vercel --prod`, nunca "Redeploy as Production" no dashboard como
caminho normal. O único fluxo:

```powershell
git fetch origin
git switch master
git pull --ff-only origin master
git status --short
git switch -c <branch-pequena-descritiva>
```

1. Uma alteração pequena e claramente delimitada — nunca misturar assuntos.
2. Abrir PR para `master`.
3. Rever todos os ficheiros do diff — confirmar que não há nada fora do
   escopo anunciado.
4. Correr, e mostrar o resultado:
   ```powershell
   git diff --check
   npx tsc --noEmit
   npm run lint
   npm test
   npm run build
   ```
5. Confirmar dependências de banco — código publicado nunca pode chamar
   tabela/coluna/view/trigger/RPC que ainda não exista em produção (ver
   secção 4).
6. Apresentar plano de rollback (secção 3 abaixo, adaptado à mudança).
7. **Esperar autorização explícita e escrita do proprietário** — não
   reutilizar autorização de uma tarefa anterior.
8. Merge no GitHub (nunca `git push --force` para `master`).
9. Deixar a Vercel publicar sozinha, pela integração GitHub → Production
   Branch = `master`. Confirmar isso continua correto:
   ```powershell
   vercel project inspect mo-limpezas --scope travizani-s-projects
   ```
   ou, com mais detalhe (inclui `productionBranch`), via API:
   ```
   GET https://api.vercel.com/v10/projects/mo-limpezas?teamId=<team>
   ```
10. Confirmar o deploy: `vercel inspect https://molimpezas.pt` deve apontar
    para o commit recém-mesclado.

## 2. O que nunca fazer sem autorização explícita nesta conversa

- `vercel --prod`, `vercel deploy --prod`, `vercel --force`
- "Redeploy as Production" no painel
- `vercel promote` (só como rollback de emergência, secção 3)
- push direto para `master`, merge de PR
- SQL direto em produção, `node scripts/run-migrations.mjs --apply`
- `supabase db push`, `migration repair`
- qualquer script com flag `--apply`
- editar variável de ambiente de Production na Vercel
- rotação de chaves (Supabase API keys, VAPID, etc.)
- alterar domínios, crons, RLS, Storage, Auth settings
- escrever dados de teste na base de produção

Autorização = frase explícita na tarefa atual, nomeando a ação exata. Uma
autorização de ontem, ou de uma ação parecida, não serve para hoje.

## 3. Rollback de emergência

`vercel promote <deployment-id>` é o único caso em que um comando fora do
fluxo normal é aceitável — e só depois de autorização explícita e depois de
confirmar que o deployment-alvo:

- veio do `master` (não de outra branch);
- corresponde ao commit esperado (`vercel inspect <url>`, conferir o SHA);
- já esteve em produção antes, validado;
- é compatível com o estado atual do banco (nenhuma migration aplicada
  depois dele que o código antigo não suporte).

Depois do rollback:
```powershell
curl -sSL -o /dev/null -w "HTTP %{http_code}\n" https://molimpezas.pt
vercel inspect https://molimpezas.pt --scope travizani-s-projects
vercel logs https://molimpezas.pt --scope travizani-s-projects
```
Confirmar domínio principal, `/login`, `/dashboard`, e ausência de erros
recorrentes nos logs antes de considerar resolvido.

**Nunca** correr `vercel --prod`/build manual como parte de um rollback —
`promote` reutiliza um build já existente, não cria um novo a partir do
checkout local (que pode não ser o `master`).

## 4. Compatibilidade código ↔ banco

Publicar código que assume uma tabela/coluna/view/trigger/RPC que ainda não
existe em produção derruba a aplicação para todos os utilizadores — não é
um erro 404 isolado, é o padrão que causou o incidente de 2026-08-05.

Para uma mudança aditiva e compatível:
1. validar a migration (dry-run, revisão do SQL);
2. confirmar existência de backup recente;
3. aplicar a migration, com autorização, uma de cada vez;
4. verificar o banco (schema real, não só o ficheiro);
5. só depois publicar o código que a consome.

Mudanças incompatíveis (renomear/remover coluna, mudar tipo, apertar
constraint) seguem expand/migrate/contract:
1. **expand** — adicionar o novo objeto sem tocar no antigo;
2. **migrate** — código passa a escrever nos dois, ler do novo;
3. **contract** — só depois de tudo estabilizado, remover o antigo.

Nunca remover um objeto que a versão atualmente publicada ainda usa.

## 5. Branches amplas nunca vão diretamente para produção

Uma branch que mistura várias funcionalidades, migrations, refatorações e
documentação nunca é mesclada como um PR único — mesmo que "só" tenha um
commit de diferença para `master` no momento do merge, o histórico completo
nunca foi revisto e testado como unidade.

`fix/atomic-contract-calendar-sync` está **congelada**: não pode ser
mesclada nem implantada como um todo. Serve só de referência para extrair
trabalho em PRs pequenos, cada um nascendo de `master` atualizado — nunca
continuando diretamente nela.

## 6. Segredos e variáveis de ambiente

- Nunca imprimir, logar, commitar, ou enviar chave/token pelo chat — nem
  parcialmente. Usar fingerprint (hash truncado) ou máscara quando for
  preciso comparar/confirmar algo sobre um segredo.
- Alterar uma variável de ambiente na Vercel **não afeta deployments já
  publicados** — só passa a valer num deployment novo (merge normal, ou
  "Redeploy" do commit já em produção depois de autorizado, exatamente
  como feito na correção da `SUPABASE_SERVICE_ROLE_KEY` em 2026-08-05).
- `vercel env pull` não decifra variáveis marcadas "Sensitive"/"Encrypted"
  neste projeto — não depender disso para confirmar valores; confirmar
  pelo comportamento real (logs, resposta da API) depois do deploy.
- Ao rodar uma chave: nunca apagar a antiga antes de confirmar que a nova
  funciona em produção — ficar sem nenhuma chave válida é pior que ter uma
  key comprometida por mais alguns minutos controlados.

## 7. Resposta a incidente em produção

1. Parar imediatamente qualquer trabalho não relacionado.
2. Não tentar várias correções ou deployments às cegas — cada tentativa
   sem diagnóstico é um novo risco.
3. Identificar o deployment e o commit ativos:
   ```powershell
   vercel inspect https://molimpezas.pt --scope travizani-s-projects
   ```
4. Capturar logs (nunca dados pessoais/PII neles):
   ```powershell
   vercel logs https://molimpezas.pt --scope travizani-s-projects --json
   ```
5. Se necessário, restaurar um deployment conhecido bom (secção 3) —
   com autorização.
6. Corrigir numa branch limpa a partir do `master`, nunca na branch onde o
   problema apareceu.
7. Documentar causa, correção e prevenção (`CLAUDE.md`, ponto de paragem
   datado).
8. Só retomar o roadmap normal depois de produção estar confirmada
   estável — validação ao vivo, não só testes locais.

## 8. Scripts que escrevem ou apagam dados

Todo script assim (ex.: `scripts/run-migrations.mjs`,
`scripts/test-tenants/*.mjs`) deve:
- funcionar em dry-run por padrão, sem qualquer flag;
- exigir `--apply` explícito para escrever, idealmente com uma segunda
  confirmação nomeada (`--confirm PALAVRA_EXATA`);
- mostrar ambiente/projeto/quantidade de linhas afetadas antes de agir;
- nunca ter um valor por omissão que aponte para produção sem essa
  confirmação explícita.

## 9. Ensaio de uma migration de guarda numa base descartável

> Procedimento obrigatório **antes** de pedir autorização para aplicar uma
> migration que altere permissões, triggers ou policies. Escrito para a
> migration `070_guard_profile_managed_fields.sql` (Task T04); o mesmo
> procedimento serve para qualquer guarda futura.
>
> 🔴 **Nada disto se faz contra produção.** Nem o runner, nem o script de
> verificação. Se em qualquer passo houver dúvida sobre que base está do outro
> lado, parar — ver secção 10.

### 9.1 Porquê

Os testes estáticos de `src/__tests__/` provam que o SQL contém as cláusulas
certas. Não provam que a base recusa a escrita, nem que o rollback desliga a
guarda sem deixar resíduo. Só uma ligação a Postgres prova isso.

### 9.2 Base descartável

Criar (ou reutilizar) um projeto Supabase **exclusivamente para ensaio**, sem
dados reais e que possa ser destruído sem consequências. Nunca um projeto de
preview ligado a dados de clientes.

### 9.3 `.env` exclusivo do ensaio

Não editar o `.env` de trabalho. Criar um ficheiro separado, por exemplo
`.env.ensaio` (ignorado pelo git, como todos os `.env*`), com as variáveis a
apontar **apenas** ao projeto descartável:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<ref-descartavel>.supabase.co
SUPABASE_DB_URL=postgresql://postgres.<ref-descartavel>:<password>@<host>.pooler.supabase.com:5432/postgres
```

### 9.4 Confirmação visual do project ref

**O passo de maior risco de todo o processo.** Antes de qualquer comando que
escreva, confirmar com os próprios olhos que o ref é o descartável:

```bash
set -a; . ./.env.ensaio; set +a
echo "$NEXT_PUBLIC_SUPABASE_URL"
node scripts/run-migrations.mjs        # sem flags = dry-run, só SELECT
```

O dry-run imprime o projeto e as migrations pendentes. Se o ref que aparece não
for o descartável, **parar aqui** — a variável está errada.

Sequência completa, para leitura de uma vez (os passos seguintes explicam cada
comando):

```bash
set -a
. ./.env.ensaio
set +a

echo "$NEXT_PUBLIC_SUPABASE_URL"

node scripts/run-migrations.mjs

node scripts/run-migrations.mjs \
  --apply \
  --confirm-production "<ref-descartavel>"

node scripts/verify-profile-guards.mjs \
  --database-url "$SUPABASE_DB_URL" \
  --forbid-project-ref "<ref-do-projeto-real>" \
  --i-know-this-database-is-disposable

node scripts/verify-profile-guards.mjs \
  --database-url "$SUPABASE_DB_URL" \
  --forbid-project-ref "<ref-do-projeto-real>" \
  --i-know-this-database-is-disposable \
  --rehearse-rollback
```

> ⚠️ Os dois refs são **diferentes**: `<ref-descartavel>` é a base de ensaio,
> `<ref-do-projeto-real>` é o projeto que nunca pode ser tocado. Trocá-los é o
> erro mais grave possível neste procedimento — e é por isso que o verificador
> exige que sejam declarados em sítios distintos.

### 9.5 Aplicar as migrations

O runner exige `--confirm-production <ref>` **mesmo numa base descartável**.
Não é um erro nem um aviso a ignorar: a flag compara o ref extraído de
`SUPABASE_DB_URL` com o de `NEXT_PUBLIC_SUPABASE_URL` e obriga a repetir esse
mesmo ref à mão. Aqui, o ref a passar é o do projeto de ensaio:

```bash
node scripts/run-migrations.mjs --apply --confirm-production <ref-descartavel>
```

Numa base vazia isto aplica tudo, da 001 à 070.

### 9.6 Verificação normal

```bash
node scripts/verify-profile-guards.mjs \
  --database-url "$SUPABASE_DB_URL" \
  --forbid-project-ref "<ref-do-projeto-real>" \
  --i-know-this-database-is-disposable
```

`--forbid-project-ref` declara qual é o projeto que o verificador **nunca** pode
tocar — o real. É obrigatório indicá-lo aqui, e não pode ser deduzido do
ambiente: neste procedimento, `NEXT_PUBLIC_SUPABASE_URL` aponta legitimamente
para o projeto **descartável**, porque o runner de migrations exige que coincida
com `SUPABASE_DB_URL` (passo 9.5).

> Substituir `<ref-do-projeto-real>` pelo ref do projeto de produção. Esse valor
> nunca é escrito neste documento nem em nenhum ficheiro versionado.

O script imprime, antes de qualquer escrita, qual é a base alvo e qual é o
projeto protegido. Confirmar os dois com os próprios olhos.

Além disso: nunca lê `SUPABASE_DB_URL` do ambiente por si, recusa correr se não
conseguir identificar o project ref da base alvo, e corre tudo numa transação
terminada em `ROLLBACK`.

**Critério de sucesso:** `12/12 verificações passaram. Transação revertida.`

### 9.7 Ensaio do rollback

```bash
node scripts/verify-profile-guards.mjs \
  --database-url "$SUPABASE_DB_URL" \
  --forbid-project-ref "<ref-do-projeto-real>" \
  --i-know-this-database-is-disposable \
  --rehearse-rollback
```

Na mesma transação: valida com a guarda ativa → larga trigger e função →
confirma que os bloqueios da 070 desaparecem e que os da 069 permanecem →
reaplica o SQL lido do ficheiro da migration → valida outra vez → `ROLLBACK`.

⚠️ Este modo **altera temporariamente objetos da base**. É revertido pelo
`ROLLBACK` final, mas enquanto a transação está aberta a guarda está mesmo
ausente para aquela ligação. Só contra a base descartável.

**Critérios de sucesso, todos obrigatórios:**

| Sinal | Significado |
|---|---|
| `✔ Triggers 069 e 070 presentes.` | As migrations estão mesmo aplicadas |
| Fase `1/3` a `12/12` | A guarda funciona |
| `✔ Rollback aplicado: ... 069 intacta.` | O rollback é cirúrgico |
| Fase `2/3` a `12/12` | Sem a 070 os bloqueios dela desaparecem, e os da 069 ficam |
| `✔ Migration 070 reaplicada a partir do ficheiro.` | A reaplicação corre |
| Fase `3/3` a `12/12` | O estado final é igual ao inicial |
| `36/36 verificações passaram. Transação revertida.` | Ensaio completo |
| Código de saída `0` | Nada falhou |

Qualquer fase abaixo de `12/12`, ou saída diferente de `0`, invalida o ensaio.
Não avançar para o pedido de autorização.

### 9.8 Depois do ensaio

Só depois de tudo acima passar se prepara um pedido **separado** de autorização
para aplicar a migration no ambiente real, anexando a saída do ensaio como
evidência. A aplicação em produção continua sujeita à REGRA ZERO (`AGENTS.md`)
e à secção 2 deste runbook.

## 10. Na dúvida

Não executar. Parar, mostrar exatamente o que foi encontrado, e pedir
autorização.
