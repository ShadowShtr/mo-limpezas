# T17-A — Auditoria global e classificação de 100% dos ficheiros

> **Ronda de auditoria.** Não remove nada. A limpeza comprovada é a T17-B.
>
> Inventário gerado por `scripts/audit-file-inventory.mjs`, versionado em
> `reports/file-classification.json`, guardado por
> `src/__tests__/t17-inventory-guard.test.ts`.

---

## 0. 🚨 AVISO DE INTEGRIDADE DE DADOS

A regressão financeira continua **sem diagnóstico**. Esta task é **estática e
offline**: zero writes, zero migrations, zero credenciais, zero produção, zero
execução de qualquer script analisado.

---

## 1. Totais

**552 ficheiros versionados.**

| Extensão | # | Topo | # |
|---|---|---|---|
| `.ts` | 236 | `src/` | 367 |
| `.tsx` | 140 | `supabase/` | 76 |
| `.sql` | 76 | `scripts/` | 41 |
| `.md` | 42 | `docs/` | 23 |
| `.mjs` | 33 | raiz | 19 |
| outros | 25 | `planning/` | 15 |
| | | `public/` | 8 |
| | | `.github/`, `reports/` | 3 |

---

## 2. Matriz de classificação

| Estado | # | Leitura |
|---|---|---|
| **MANTER** | **503** | em uso, comprovado |
| **STANDBY** | **33** | precisa de decisão antes de qualquer acção |
| **ARQUIVAR** | **15** | `planning/` — documentação anterior ao produto |
| **REMOVER** | **1** | único candidato com confiança total |
| CENTRALIZAR | 0 | oportunidades listadas em §9, sem alteração nesta ronda |
| SUBSTITUIR | 0 | idem |

### Por categoria

| Categoria | # | | Categoria | # |
|---|---|---|---|---|
| route-ui | 132 | | api-route | 16 |
| test | 77 | | planning | 15 |
| migration | 72 | | component | 14 |
| lib | 56 | | config | 12 |
| script | 41 | | asset | 8 |
| server-action | 35 | | ci / types / sql-frozen / supabase-other | 2 cada |
| domain | 34 | | report / src-other | 1 cada |
| doc | 28 | | other | 2 |

---

## 3. Três falsos positivos que o próprio classificador produziu

Registados porque são a parte mais instrutiva desta auditoria: **a análise
estática erra sempre para o lado de declarar código morto**, e cada erro destes,
seguido sem verificação, seria um incidente.

### 3.1 `src/proxy.ts` marcado como órfão

O projecto usa **Next 16.2.7**, onde `middleware.ts` passou a chamar-se
`proxy.ts`. É carregado pelo framework, sem importadores — e é o ficheiro que
**protege todas as rotas por role**. "Remover" abriria a aplicação inteira.

O classificador só procurava convenções dentro de `src/app/`. Corrigido com uma
tabela de convenções de raiz.

### 3.2 Scanners de segurança marcados como perigosos

`scan-secrets.mjs`, `audit-security.ts` e `check-env.ts` foram classificados
`PRODUCTION_DANGEROUS` por conterem a string `SUPABASE_SERVICE_ROLE_KEY` — que
lá está porque **procuram** a chave.

Corrigido: distingue-se `process.env.SUPABASE_SERVICE_ROLE_KEY` (usa) de uma
menção (procura). Contagem caiu de 22 para 14.

### 3.3 Comparadores offline marcados como capazes de escrever

Os três `compare-*-compat.ts` foram apanhados por mencionarem `--apply`,
`--execute`, `--write` — dentro de `assertNoWriteFlags`, que existe para as
**recusar**.

Corrigido invertendo a ordem: prova-se primeiro que é inofensivo.

> **Lição para a T17-B:** nenhum ficheiro será removido só porque uma busca
> textual não encontrou consumidores. As três portas que a busca não vê —
> convenção do framework, entrada de CLI, import dinâmico — têm de ser fechadas
> uma a uma.

---

## 4. Actions — 35 ficheiros com `"use server"`

### 4.1 Autenticação

| Padrão | # |
|---|---|
| `requireProfile` central (T05/T06) | **15** |
| guard inline duplicado (`getUser` → ler profile → verificar role) | **20** |
| **sem guard nenhum** | **0** |

**Nenhuma action está desprotegida.** O problema é de duplicação: 20 ficheiros
repetem à mão o que o guard central já faz, e cada cópia é um sítio onde uma
correcção futura pode não chegar.

Ficheiros com guard inline: `create-service`, `reschedule`, `update-service`,
`absences`, `auth`, `building-cards`, `cancellations`, `clientes`,
`colaboradores`, `contratos`, `csv-import`, `email`, `equipas`, `intervencoes`,
`locations`, `map`, `notifications`, `vacation`, `vehicles`, `whatsapp`.

**→ CENTRALIZAR.** Não alterado nesta ronda.

### 4.2 Escritas sem auditoria

**12 ficheiros com ≥3 escritas e zero `auditLog`:**

| Ficheiro | escritas |
|---|---|
| `vehicles.ts` | 9 |
| `collaborator-documents.ts` | 7 |
| `payments.ts` | 7 |
| `vacation.ts` | 7 |
| `invoices.ts` | 6 |
| `management-tasks.ts` | 6 |
| `notifications.ts`, `building-cards.ts`, `timesheets.ts` | 4 |
| `absences.ts`, `cash-flow.ts`, `csv-import.ts` | 3 |

`payments.ts` e `invoices.ts` são os que mais interessam: tocam exactamente na
área da regressão não diagnosticada.

### 4.3 `company_id` fora da sessão

6 ficheiros não derivam `company_id` de `profile.company_id`. Dos que escrevem:
`colaboradores.ts` (12), `locations.ts` (4), `notifications.ts` (4),
`absences.ts` (3).

> Nota: `clientes.ts` e `contratos.ts` **verificam** `profile.company_id !==
> input.company_id` — validam em vez de confiar, o que é correcto. A auditoria
> de tenant fina é trabalho da T17-B.

---

## 5. Erros ignorados — **268 em 82 ficheiros**

Padrão: `const { data: x } = await admin…` sem `error` na desestruturação.
Consulta falha → `data` vem `null` → o `?? []` a seguir dá lista vazia → o ecrã
mostra zero com ar de número certo.

| Ficheiro | # |
|---|---|
| `invoices.ts` | 13 |
| `collaborator-documents.ts` | 12 |
| `contratos.ts` | 11 |
| `colaboradores.ts` | 10 |
| `reports.ts` | 10 |
| `cancellations.ts`, `clientes.ts`, `management-tasks.ts` | 9 |
| +74 ficheiros | |

Categorias relacionadas: `?? []` **272** · `?? 0` **127** · `catch` vazio **0** ·
`debugger` **0**.

**Ranking de criticidade:**

1. **CRÍTICO** — os 47 da superfície financeira (T14 §2.2), já congelados por
   guarda;
2. **ALTO** — `collaborator-documents` (12): um documento que não carrega
   parece não existir;
3. **MÉDIO** — restantes actions de escrita;
4. **BAIXO** — páginas de leitura onde o pior caso é uma tabela vazia.

---

## 6. Realtime — 8 handlers

| Ficheiro | Tabela | `company_id` | resync | `payload` como verdade | cleanup |
|---|---|---|---|---|---|
| `daily-billing-client` | services | ✅ | ✅ | não | ✅ |
| `financial-dashboard-client` | services | ✅ | ✅ | não | ✅ |
| `registo-ponto-client` | timesheets | ✅ | ✅ | não | ✅ |
| `map-view` | timesheets | ❌ | ✅ | não | ✅ |
| `team-realtime` | timesheets | ❌ | ❌ | **SIM** | ✅ |
| `notifications-bell` | notifications | ❌ | ✅ | **SIM** | ✅ |
| `app-header` | notifications | ❌ | ❌ | não | ✅ |
| `sidebar-notif-badge` | notifications | ❌ | ✅ | não | ✅ |

**5 sem filtro `company_id`** · **2 usam `payload.new` como fonte de verdade**
(o princípio que a T10 fixou: o evento é gatilho, não estado) · **todos** fazem
cleanup da subscrição.

**→ T16.** Congelada. Não tocada.

---

## 7. Cache e invalidação

**126 chamadas directas a `revalidatePath`** em 24 ficheiros · **1** uso de
`invalidateBusinessState` (dentro do próprio helper) · **24** `router.refresh` ·
**0** `revalidateTag`/`unstable_cache`.

| Alvo | # |
|---|---|
| `/dashboard/clientes` | 20 |
| `/dashboard/calendario` | 17 |
| `/dashboard/financeiro` | 13 |
| `/dashboard/colaboradores` | 9 |
| `/dashboard/cobrancas`, `/dashboard/locais` | 7 |
| **`/dashboard` (invalidação ampla)** | **5** |
| restantes | 48 |

As 5 chamadas a `/dashboard` invalidam a árvore inteira por uma alteração
pontual. **→ T16.** Não migrado.

---

## 8. Performance — estrutural

| Sinal | # | Severidade |
|---|---|---|
| `select("*")` | 13 em 9 ficheiros | MÉDIA (4 são o export de backup, legítimo) |
| `await` dentro de `for` | 8 em 7 ficheiros | MÉDIA |
| N+1 conhecido (`daily-billing`) | 2 | **ALTA** — já documentado na T14 §10.4 |
| paginação ausente | a confirmar por rota | BAIXA |

---

## 9. Oportunidades de centralização

Sem alteração nesta ronda:

1. **Guard das actions** — 20 cópias inline do `requireProfile` (§4.1);
2. **`revalidatePath`** — 126 chamadas por substituir por `invalidateBusinessState`;
3. **Erros ignorados** — 268 pontos por converter em `SourceResult`;
4. **Estados de UI** — loading/empty/error repetidos por ecrã;
5. **`vat_rate ?? 23`** — 6 ficheiros, já congelados por guarda da T14.

---

## 10. Qualidade de tipos e ruído

| Sinal | # | Leitura |
|---|---|---|
| `@ts-ignore` / `@ts-expect-error` | **0** | ✅ |
| `debugger` | **0** | ✅ |
| `catch {}` vazio | **0** | ✅ |
| `console.log/debug/info` | **1** | observabilidade legítima (`route-metrics`) |
| `console.error/warn` | 30 | operacional — **não remover** |
| `any` explícito | 21 em 11 ficheiros | LEGACY, sobretudo `management-tasks` (6) |
| `as unknown as` | 32 em 21 ficheiros | maioria em fronteiras de tipo do Supabase |
| `eslint-disable` | 54 em 32 ficheiros | rever caso a caso |
| TODO/FIXME reais | **0** | os 3 achados são falsos positivos: a palavra "TODO" em português e `XXXX-XXX` de código postal |

---

## 11. Scripts — 41

| Risco | # | Significado |
|---|---|---|
| **PRODUCTION_DANGEROUS** | **14** | usa a chave administrativa **e** escreve/apaga |
| SAFE_OFFLINE | 13 | sem acesso à base |
| ADMIN_READ | 6 | chave administrativa só para ler |
| WRITE_CAPABLE | 5 | escreve, sem chave administrativa |
| READ_ONLY | 3 | leitura |

**Os 14 perigosos:** `create-admins`, `create-colaborador`, `fix-num-people`,
`fix-service-times`, `fix-weekend-services`, `geocode-locations`,
`import-contratos-5`, `import-fluxo-junho`, `import-pdf-jun26`,
`migrate-real-data`, `reset-operacao`, `restore-backup`, `restore-contratos`,
`restore-servicos`.

Todos **STANDBY**. `reset-operacao.mjs` é o mais grave — apaga a operação e o
financeiro inteiros.

> A T03 já removeu artefactos capazes de destruir uma base real. Estes
> sobreviveram a essa passagem; a T17-B decide entre arquivar, exigir flag
> explícita, ou remover. **Nenhum foi executado.**

---

## 12. Schema

**72 migrations** (001–070 + auxiliares) — todas **MANTER**: uma migration
versionada é histórico do schema e não se apaga.

**Migration 070 continua NÃO APLICADA.**

**2 ficheiros SQL congelados**, ambos **STANDBY**, ambos **não aplicados**:
`T08_occurrence_identity.sql` · `T09_atomic_contract_sync.sql`.

Esta task não alterou nada disto.

---

## 13. Documentação

28 em `docs/` — todas **MANTER**. Incidentes, runbook e handoffs preservados;
nenhuma história reescrita.

15 em `planning/` — **ARQUIVAR**: documentação anterior ao produto actual, ainda
referida no `CLAUDE.md`. A T17-B avalia mover para `docs/historico/`. **Não
apagar.**

---

## 14. Testes

77 ficheiros. Nenhum removido — a task proíbe-o salvo duplicação total
comprovada, e não se encontrou nenhuma.

Nota conhecida: `scan-secrets.test.ts` não colige no Windows (pré-existente,
alheio; passa no CI Linux).

---

## 15. Dependências

**Não alteradas. `npm audit fix` não executado.**

Diagnóstico reaproveitado do handoff: **16 vulnerabilidades** (2 low, 3
moderate, 11 high); em produção **14**. O único caminho para as `high` de
`next`/`postcss`/`sharp` é um major do Next.

**Next 16.2.7 · React 19.2.4.** Não actualizados. Backlog separado.

---

## 16. Segurança e dados pessoais

Executado apenas o scanner já existente: `npm run secrets:scan` →
**549 ficheiros analisados, nenhuma credencial**.

Nenhum `.env` foi lido. Nenhum valor foi impresso. Os artefactos locais
sensíveis (`.env.local`, `scripts/_admins.mjs`, `CREDENCIAIS_*`, `backups/`,
`supabase/.temp/`, `.vercel/`) não foram tocados — não estão versionados e
ficam fora do inventário por construção.

---

## 17. Candidato a remoção — **1**

```
"C\uF03ATempmo-limpezas-dev.log"
```

O nome contém **U+F03A**, o carácter que o Windows usa no lugar de `:` (ilegal
em NTFS). Descodificado, o nome do ficheiro é o caminho
`C:\Temp\mo-limpezas-dev.log`: alguém escreveu `> C:\Temp\...` numa shell que
tratou o caminho como nome relativo, e o resultado foi commitado.

Zero consumidores · zero convenção · zero referência · conteúdo é um log de
desenvolvimento antigo.

**Não removido nesta ronda** — a T17-A audita, a T17-B remove. Um teste garante
que continua a existir enquanto estiver marcado.

---

## 18. Top 15 por impacto

| # | Item | Onde | Acção |
|---|---|---|---|
| 1 | 268 erros de consulta ignorados | 82 ficheiros | T17-B / Financeiro V2 |
| 2 | 126 `revalidatePath` directos | 24 ficheiros | T16 |
| 3 | 20 guards inline duplicados | actions | CENTRALIZAR |
| 4 | 14 scripts capazes de destruir uma base | `scripts/` | T17-B: decidir |
| 5 | 12 actions com ≥3 escritas e zero auditoria | actions | T12/T13 |
| 6 | 5 handlers realtime sem `company_id` | componentes | T16 |
| 7 | 2 handlers usam `payload.new` como verdade | realtime | T16 |
| 8 | Migration 070 não aplicada | `supabase/` | base descartável |
| 9 | 2 SQL congelados não aplicados | `supabase/frozen/` | base descartável |
| 10 | N+1 na Cobrança Diária | `daily-billing.ts` | Financeiro V2 |
| 11 | 5 invalidações amplas de `/dashboard` | actions | T16 |
| 12 | 16 vulnerabilidades npm | `package.json` | frente própria |
| 13 | 4 módulos legacy por remover | `src/domain/*` | após transição |
| 14 | 15 documentos de planeamento | `planning/` | T17-B: arquivar |
| 15 | 1 ficheiro-lixo | raiz | T17-B: remover |

---

## 19. Como regenerar

```bash
node scripts/audit-file-inventory.mjs --output reports/file-classification.json
```

A guarda `t17-inventory-guard.test.ts` falha se um ficheiro versionado ficar sem
classificação, se o inventário referir ficheiros que já não existem, ou se uma
classificação não tiver razão escrita. **Não compara campo a campo** — seria
frágil sem ser útil, e uma guarda que falha a toda a hora acaba desligada.

---

## 20. Confirmação

**ZERO** writes · **ZERO** migrations · **ZERO** produção · **ZERO** credenciais ·
**ZERO** pagamentos reais · **ZERO** UI · **ZERO** T12 · **ZERO** T13 ·
**ZERO** T16 · **ZERO** ficheiros removidos · **ZERO** scripts executados ·
**ZERO** dependências alteradas.
