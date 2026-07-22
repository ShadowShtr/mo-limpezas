# AUDITORIA SÉNIOR — "Alterações que revertem / não aparecem"

**Repositório:** ShadowShtr/mo-limpezas
**Data:** 2026-07-22
**Método:** revisão de código linha a linha (server actions, calendário, sheets, migrações, service worker, pipeline de deploy) + execução de diagnóstico read-only contra a base de PRODUÇÃO.

---

## Veredito como auditor sénior

O site não está "a reverter" alterações — está **a alternar entre versões** e a
**deixar processos automáticos reescrever dados por cima de alterações manuais**.
O sintoma "altero e volta / altero e não aparece / o valor some / o calendário
não reflete" tem 6 causas confirmadas com evidência, por ordem de gravidade:

```
1. O código corrigido nunca chegou a produção (8 commits por publicar).
2. Deploys por dois canais (Vercel CLI + GitHub) alternam a versão do site.
3. O runner de migrações re-executa TUDO + seed contra produção, sem controlo.
4. Formulários gravam null por cima de campos que não carregaram (partial update).
5. Edições manuais de serviços de contrato nunca são marcadas como exceção
   (is_exception nunca é escrito) → a reescrita automática reverte-as.
6. Escritas diretas do browser na tabela services falham em silêncio com RLS
   (0 linhas afetadas, sem erro, UI mostra "sucesso").
```

---

## CAUSA 1 — Os fixes nunca chegaram a produção (CRÍTICO)

O master local está **8 commits à frente do GitHub desde 13–16 de julho** (hoje
é dia 22). Confirmado com:

```
git rev-list --left-right --count master...origin/master   →   8   0
```

Os commits por publicar são precisamente os fixes das áreas com queixas:

```
4530361 fix(calendario): pagamento passa a configurar-se no painel, nao no card
a61b77a feat(calendario): botoes rapidos de estado de pagamento nos cards
e46301e fix(contratos): evita servicos mensais/personalizados caindo em fim de semana
e6ac6d9 fix(seguranca): fecha achados da auditoria (RLS, validacao financeira, restore)
c1a6701 fix(notificacoes): ativa Realtime na tabela notifications
8fd6fa9 feat(notificacoes): pop-up (toast) ao chegar notificação nova
1f0faea feat(financeiro): anexo de fatura em pagamentos + notificação ao atribuir tarefa
7eca98e feat(calendario): coluna Prédios + fix(cobrancas): avença duplicada + fix(datas)
```

**Consequência:** os bugs de "perda de type/notes do cliente", "perda do valor
da avença" e "avença duplicada na cobrança" foram corrigidos localmente mas
produção continua a produzi-los. Parece que "as correções reverteram" — nunca
foram publicadas.

Além disso: **migrações 057 e 058 nem sequer estão no git** (untracked) e há
6+ ficheiros de código modificados por commitar (WIP de tarefas/férias). Se a
migração for aplicada à base sem o código ir junto (ou vice-versa), o site
quebra ou grava em colunas "inexistentes".

---

## CAUSA 2 — Deploys por dois canais (CRÍTICO)

Existe `.vercel/output/` no disco: já foram feitos builds/deploys por **Vercel
CLI a partir do PC**, misturados com os deploys automáticos do GitHub.

**Mecanismo da reversão:** o deploy CLI publica a versão local (com fixes); um
`git push` posterior de outra máquina/sessão dispara o deploy do GitHub (sem os
fixes) e o site **anda para trás**. É a origem nº 1 do sintoma "estava bom e
voltou a ficar mau".

Agravante: `/api/health` não devolvia a versão — era impossível provar que
commit estava no ar quando alguém reportava uma reversão.

---

## CAUSA 3 — Runner de migrações inseguro (CRÍTICO)

O `scripts/run-migrations.mjs` original:

```js
password: "@vitortmf36978",            // password de produção HARDCODED no repo
...
for (const file of files) {            // re-executa TODAS as migrações, sempre
  try { await client.query(sql); }
  catch (err) {
    if (err.message.includes("already exists") || ...) {
      // engole o erro e continua
    }
  }
}
// e no fim aplica SEMPRE o seed:
const seed = readFileSync(".../supabase/seed.sql");   // "NÃO executar em produção"
await client.query(seed);
```

Problemas:

1. **Sem tabela de controlo** — cada run re-executa os 62 ficheiros. Migrações
   com `UPDATE`/`DELETE`/`INSERT` de dados (021, 023, 025) **re-aplicam-se sobre
   dados reais** já alterados pela gestora → valores "voltam atrás" na base.
2. **`seed.sql` aplicado a produção** em todos os runs — o próprio ficheiro diz
   "NÃO executar em produção" e insere 5 clientes fictícios com UUIDs fixos.
3. **Password do Postgres em texto claro**, agora no histórico do git/GitHub.
   ⚠️ Tem de ser RODADA no dashboard do Supabase — remover do ficheiro não chega.
4. Erros engolidos → nunca se sabe o que foi realmente aplicado.

---

## CAUSA 4 — Padrão "partial update" nos formulários (ALTO)

Formulários (sheets) alimentados por queries com listas de colunas escritas à
mão. Quando a query não carrega uma coluna que o formulário grava, o update
escreve `null`/default **por cima do valor real**.

Casos reais já ocorridos (confirmados pelos comentários no próprio código):

- **Clientes** — a listagem não carregava `type`/`notes`; editar pelo ícone "..."
  da lista apagava esses campos (fix no commit 2eb8154, por publicar).
- **Contratos** — a ficha do cliente não carregava `fixed_price`/`fixed_monthly`/
  `apply_vat`; editar por lá **apagava o valor da avença** e, em cascata, zerava
  serviços futuros (fix no commit e999852, por publicar).

Mitigação existente (local): fontes únicas `CLIENTE_SHEET_SELECT` e
`CONTRATO_SHEET_SELECT` em `src/lib/cliente-sheet-fields.ts` e
`src/lib/contrato-sheet-fields.ts`.

Variante do mesmo padrão ainda ativa em `src/app/actions/contratos.ts:428` e `:554`:

```ts
await admin.from("locations")
  .update({ hourly_rate: input.hourly_rate ?? null })   // ?? null apaga o valor
  .eq("id", input.location_id)
```

Num contrato de avença/estofos em que o formulário não envia valor/hora, isto
**anula o `hourly_rate` do local** — e todos os cálculos por hora desse local
passam a dar 0/errado.

---

## CAUSA 5 — `is_exception` nunca é escrito (ALTO)

A reescrita automática de serviços futuros ao editar contrato
(`updateFutureServiceValuesForContract`, `src/app/actions/contratos.ts:264+`)
respeita corretamente as exceções:

```ts
if (service.is_exception) continue;   // não reescreve exceções manuais
```

**MAS**: `grep -R "is_exception" src/` mostra que **nenhum ponto do código
alguma vez grava `is_exception = true`** — nem o drag & drop do calendário
(`reschedule.ts`), nem a edição de horário/valor no painel de detalhe
(`service-detail-sheet.tsx`), nem nenhuma outra action. A coluna existe desde a
migração 006 e só é lida, nunca escrita.

**Consequência:** TODA a edição manual de um serviço vindo de contrato é
sobrescrita na próxima edição do contrato — horário, equipa e valor voltam ao
padrão. É o mecanismo nº 1 de "alterei a intervenção e depois voltou" dentro da
aplicação.

---

## CAUSA 6 — Escritas diretas do browser com RLS silencioso (ALTO)

`service-detail-sheet.tsx` (componente de **browser**) escreve diretamente na
tabela, sem server action — linhas 352-355, 383-386, 400-403:

```ts
const { error } = await supabase.from("services").update(update).eq("id", svc.id);
if (error) { ... }   // ← um update bloqueado por RLS NÃO devolve erro:
                     //    afeta 0 linhas e o código segue para "sucesso"
```

Consequências:

1. **RLS silencioso** — se a policy não permitir o update, o Supabase devolve
   sucesso com 0 linhas. A UI mostra "Horário atualizado ✓", nada foi gravado,
   e ao recarregar volta o valor antigo. Sintoma exato de "gravo e não aparece".
   Risco real: a migração 054 (`harden_service_only_policies`) e o commit
   e6ac6d9 mexem em RLS **fora de sincronia** com o código deployado.
2. Sem `auditLog` — alterações críticas sem rasto.
3. Sem marcação de `is_exception` (ver Causa 5).
4. Sem `revalidatePath` — outras abas ficam com cache velho.

---

## Fatores agravantes (médio)

- **Corrida no estado otimista do calendário** (`calendar-view.tsx`): o estado
  local `localServices` é sobreposto pela prop `services` via `useEffect`; com
  duas sessões de gestão abertas é **last-write-wins sem verificação de
  concorrência** (`updated_at`) — edições pisam-se sem aviso.
- **PWA/Service worker**: o novo SW fica em "waiting" até a colaboradora tocar
  em "Atualizar" (decisão consciente para não recarregar a meio do ponto). Quem
  nunca toca continua a correr a **app antiga** no telemóvel — "a alteração não
  aparece". O HTML nunca é cacheado (correto) e a cache é carimbada por deploy
  (correto).
- **Cálculo de valor duplicado em 4+ sítios** (reschedule, detail-sheet,
  reescrita de contratos, cron) — qualquer correção numa cópia não chega às
  outras. Falta um helper central `calculateServiceValue`.
- **`revalidatePath` incompleto** — ex.: alterações financeiras de contrato não
  revalidam `/dashboard/cobrancas`.

---

## RESULTADOS DA EXECUÇÃO REAL (produção, read-only, 2026-07-22)

`node scripts/audit-reversoes.mjs` contra a base de produção:

```
❌ 2 críticos:
   - 8 commits locais por publicar no GitHub (fixes não estão em produção)
   - migrações 057/058 fora do git

⚠️ 6 avisos:
   - 18 ficheiros modificados/untracked no working tree
   - .vercel/output presente (deploys CLI já feitos deste PC)
   - AUDIT_APP_URL não configurado (não foi possível interrogar produção)
   - auditoria de type/notes sem entradas (fix ainda não está em produção)
   - 141 pares de serviços SOBREPOSTOS na mesma equipa (-30/+60 dias) — as
     "interseções quebradas" são DADOS reais a precisar de triagem
   - SW espera toque em "Atualizar" (colaboradoras podem correr app antiga)

✅ 10 ok:
   - 62/62 migrações verificadas aplicadas em produção (sondagem automática
     de tabelas/colunas/views/buckets derivada dos próprios .sql)
   - sem clientes fictícios do seed em produção
   - sem contratos ativos de avença com valor nulo/0
   - fuso horário consistente (0 serviços fora de 06h-21h Lisboa)
   - sem padrão de edições em corrida no audit_log (14 dias)
   - HTML nunca servido da cache do SW
   (informativo: 35 serviços a sáb/dom na janela — confirmar se intencionais;
    930 clientes ativos sem notas — nem todos são perda)
```

---

## FERRAMENTAS ENTREGUES (no repo, por commitar)

```
scripts/audit-reversoes.mjs          Diagnóstico read-only em 9 secções; sai
                                     com código 1 se houver críticos (para CI).
                                     Uso: node scripts/audit-reversoes.mjs
                                          node scripts/audit-reversoes.mjs --skip-db

scripts/run-migrations.mjs           REESCRITO: exige SUPABASE_DB_URL do env
                                     (sem password no código); tabela de
                                     controlo _migrations (só aplica pendentes,
                                     em transação, pára ao 1º erro); primeiro
                                     uso numa base com dados exige --baseline;
                                     seed só com --seed e recusado se a base
                                     tiver dados.

src/app/api/health/route.ts          Passa a devolver version (commit) e branch
                                     — prova em segundos que versão está no ar.

src/__tests__/reversao-guards.test.ts  12 testes-guarda (todos a passar):
   - CLIENTE_SHEET_SELECT/CONTRATO_SHEET_SELECT contêm todos os campos críticos
   - nenhuma página alimenta os sheets com listas de colunas à mão
   - runner sem credenciais hardcoded, com _migrations, seed guardado
   - SW nunca cacheia HTML nem /api/; cache carimbada por deploy
   - /api/health expõe a versão
```

---

## ROTEIRO DE CORREÇÃO (ordem de ataque)

```
================================================================================
FASE 0 — SEGURANÇA (fazer JÁ, antes de tudo)
================================================================================
1. RODAR a password do Postgres no dashboard do Supabase.
   A antiga (@vitortmf36978) está no histórico do git no GitHub.
2. Adicionar ao .env.local:
   SUPABASE_DB_URL=postgres://...   (connection string nova)
   AUDIT_APP_URL=https://<dominio-de-producao>

================================================================================
FASE 1 — PARAR A ALTERNÂNCIA DE VERSÕES
================================================================================
3. Rever e commitar o WIP (tarefas/férias) — migrações 057/058 SEMPRE no mesmo
   commit que o código que as usa.
4. git push origin master  → publica finalmente os 8 fixes.
5. NUNCA MAIS `vercel --prod` manual. Um canal só: deploy automático via push.
6. Uma vez: node scripts/run-migrations.mjs --baseline
   (marca as 62 migrações como aplicadas sem re-executar nada)

================================================================================
FASE 2 — FECHAR OS MECANISMOS DE REVERSÃO NO CÓDIGO
================================================================================
7. Marcar is_exception = true em TODA a edição manual de serviço de contrato:
   - reschedule.ts (drag & drop): se contract_id != null → is_exception: true
   - service-detail-sheet (horário/equipa/valor): idem
   Teste obrigatório: criar contrato → editar serviço futuro → editar contrato
   → o serviço editado NÃO volta ao padrão.
8. Migrar as escritas do service-detail-sheet para server actions
   (fecha de uma vez: RLS silencioso, falta de auditLog, falta de revalidação).
   Regra: todo update de services devolve as linhas afetadas; 0 linhas = erro
   mostrado ao utilizador, nunca "sucesso".
9. Corrigir contratos.ts:428/:554 — só atualizar locations.hourly_rate quando o
   contrato é por hora OU houve alteração explícita; nunca `?? null` cego.

================================================================================
FASE 3 — HIGIENE ESTRUTURAL
================================================================================
10. Helper central calculateServiceValue(input) usado por: criação manual,
    contratos, cron, drag, detail-sheet, reescrita futura, cobranças.
11. Regra de ouro nos campos críticos: se source.campo === undefined → bloquear
    gravação com mensagem clara, nunca converter undefined em null.
12. revalidatePath: cobrir /dashboard/cobrancas em alterações financeiras.
13. Verificação de concorrência (updated_at) nas server actions de services e
    contracts — elimina o last-write-wins entre duas sessões.

================================================================================
FASE 4 — DADOS EXISTENTES
================================================================================
14. Triagem dos 141 pares de serviços sobrepostos (relatório da auditoria).
15. Confirmar os 35 serviços de fim de semana na janela -30/+60 dias.
16. Recuperar perdas antigas de type/notes/avença via audit_log (campo before).

================================================================================
ROTINA PERMANENTE
================================================================================
- Depois de cada deploy:  node scripts/audit-reversoes.mjs
- Quando alguém disser "voltou atrás":  abrir <site>/api/health e comparar o
  campo version com `git log` — em segundos sabe-se se é código antigo ou dados.
- npm run test tem de passar sempre (inclui os 12 testes-guarda anti-reversão).
```

---

## CRITÉRIO DE ACEITE

A situação só está resolvida quando:

- produção responde em `/api/health` com o mesmo commit do GitHub;
- `node scripts/audit-reversoes.mjs` termina com 0 críticos;
- editar manualmente um serviço de contrato e depois editar o contrato NÃO
  reverte a edição manual (teste automático);
- um update bloqueado por RLS aparece como ERRO ao utilizador, nunca "sucesso";
- nenhum formulário grava `null` por cima de campo que não carregou;
- `npm run lint`, `npm run build` e `npm run test` passam;
- a password antiga da base está rodada.

## FORA DO ÂMBITO

Conciliação bancária, SMS/WhatsApp, design visual, autenticação, RLS não
relacionada, refatorações estéticas.
