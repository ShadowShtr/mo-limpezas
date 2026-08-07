# T08 — Identidade canónica de ocorrência

Documento técnico da Task T08. Escrito para responder, sem ambiguidade, às
perguntas que a geração de serviços nunca teve resposta clara.

Nada aqui foi aplicado. O SQL está congelado em
`supabase/frozen/T08_occurrence_identity.sql` e é estruturalmente inaplicável
pelo runner de migrations.

---

## 1. O defeito

A geração decide "esta ocorrência já existe?" assim:

```
contract_id + dia de scheduled_start
```

`scheduled_start` é **estado mutável**. A sequência real que duplica:

1. contrato semanal à quarta gera o serviço de 08/07;
2. a gestora arrasta a visita para sexta, 10/07 (`is_exception = true`);
3. o cron mensal corre outra vez;
4. procura "serviço deste contrato a 08/07" — já não existe, foi movido;
5. cria um serviço **novo** a 08/07.

A mesma ocorrência lógica passa a existir duas vezes.

### A corrida

Mesmo sem reagendamentos, o padrão `SELECT` → `INSERT` tem uma janela:

| | Processo A | Processo B |
|---|---|---|
| t0 | `SELECT` → não existe | |
| t1 | | `SELECT` → não existe |
| t2 | `INSERT` | |
| t3 | | `INSERT` ← duplica |

Acontece com cron + `updateContrato` em simultâneo, com dois crons, ou com um
retry depois de um timeout. Uma consulta prévia nunca pode ser a garantia
final; a garantia tem de estar na base.

---

## 2. A identidade

| Conceito | Significado | Muda? |
|---|---|---|
| **data canónica da ocorrência** | "a visita de 8 de julho deste contrato" | **não** |
| `scheduled_start` / `_end` | quando está marcada agora | sim |
| `is_exception` | divergiu do padrão por decisão humana | sim |
| `status` | agendado, concluído, cancelado… | sim |
| `id` do serviço | linha na base | não |

**Identidade = `(company_id, contract_id, occurrence_date)`.**

`company_id` entra na chave porque toda a unicidade deste sistema é por
empresa. `occurrence_date` é a data que o motor canónico da T07 produz — e é
por isso que a T08 assenta em cima da T07 e não do `master`.

---

## 3. Modelo escolhido, e o que foi rejeitado

**MODELO A (escolhido):** coluna `services.occurrence_date` + índice único
parcial.

**MODELO B (rejeitado):** tabela `contract_occurrences` própria.

O Modelo B só seria necessário para a identidade sobreviver à **eliminação**
do serviço. Não é preciso: apagar uma ocorrência escreve a data em
`contracts.excluded_dates` **antes** de apagar, e falha fechado se esse
registo não for possível (`src/app/actions/cancellations.ts`). É essa exclusão
que impede o cron de recriar. Uma tabela nova acrescentaria uma segunda fonte
de verdade e mais um sítio para dessincronizar.

---

## 4. Tabela de estados e ações

O que a geração faz perante cada estado. Nenhuma linha apaga seja o que for.

| Estado atual da ocorrência | Decisão | Porquê |
|---|---|---|
| não existe | `CREATE` | é uma ocorrência nova |
| existe, agendada | `SKIP_EXISTS` | já lá está |
| existe, **reagendada** para outro dia | `SKIP_EXCEPTION` | a identidade continua ocupada — é isto que fecha o defeito |
| existe, horário/equipa/valor editados | `SKIP_EXCEPTION` | a sincronização não sobrescreve uma decisão humana |
| existe, **cancelada** | `SKIP_CANCELLED` | cancelar não é apagar; recriar anularia a decisão |
| existe, concluída ou em curso | `SKIP_EXISTS` | há trabalho real associado |
| apagada do calendário | `SKIP_EXCLUDED` | a data está em `excluded_dates` |
| duas linhas com a mesma identidade | `CONFLICT_MANUAL` | só pode existir por dados anteriores à constraint |

### Perguntas que faltavam responder

**Quando alguém apaga uma ocorrência, o que impede o cron de a recriar?**
A escrita em `contracts.excluded_dates`, feita **antes** do `DELETE` e em modo
fail-closed. Com a T08 passa a registar-se a `occurrence_date`, não a data
agendada — hoje, apagar um serviço reagendado exclui a data errada e a
ocorrência canónica volta na corrida seguinte.

**Cancelar remove a ocorrência?** Não. A linha permanece com
`status = 'cancelado'` e mantém a identidade — e é essa identidade que impede a
recriação. Um cancelamento seguido de eliminação cai no caso anterior.

**Reagendar, qual é a identidade?** A data canónica original. É o que muda
face a hoje.

**Alterar a frequência do contrato, o que acontece às ocorrências futuras?**
A reconciliação apaga as futuras que deixaram de pertencer ao padrão e não são
exceções (`reconcileFutureServicesForContract`). Com identidade, essa
comparação passa a ser feita por `occurrence_date` em vez de pela data
agendada — hoje um serviço movido não corresponde a nenhuma data válida e é
apagado por engano.

**Alterar `starts_on`, o que é preservado?** As exceções e tudo o que já
aconteceu. As ocorrências futuras não-exceção são recalculadas.

---

## 5. Backfill

`occurrence_date = scheduled_start::date` **não** é válido: um serviço movido
representa uma ocorrência de outro dia.

`original_date` seria a evidência ideal. Existe desde a migration 006 e
**nenhum código do projeto a escreve** — é sempre `NULL`. O diagnóstico conta
quantas linhas a têm preenchida precisamente para confirmar isso; se aparecer
alguma, a origem é desconhecida e o backfill não a usa.

| Classe | O que é | Backfill |
|---|---|---|
| `NORMAL` | na data canónica, sem colisão | automático |
| `CANCELLED` | cancelado na data canónica | automático (preserva a identidade) |
| `RESCHEDULED` | exceção fora da data canónica | **revisão humana** |
| `DUPLICATE_CANDIDATE` | dois serviços no mesmo dia | plano de reparação |
| `DATE_INCONSISTENT` | fora do padrão sem ser exceção | **revisão humana** |
| `MISSING_CONTRACT` | `contract_id` sem contrato | **revisão humana** |
| `STANDALONE` | sem contrato | fica sem identidade, por definição |

O SQL congelado só preenche `NORMAL`. Tudo o resto sai no plano offline.

---

## 6. Duplicados: como se escolhe o sobrevivente

Nunca "o primeiro id" — a ordem de chegada não diz nada sobre onde está o
trabalho real. A ordem é determinística e por evidência:

1. dependências (registo de ponto e linha de fatura pesam mais);
2. estado (`concluido` > `em_curso` > `agendado` > `falta` > `cancelado`);
3. exceção manual antes de gerado automaticamente;
4. mais antigo;
5. `id`, só como desempate final para o resultado ser reprodutível.

**Se mais do que um lado tiver registo de ponto ou linha de fatura, o veredicto
é `MANUAL_REVIEW`** — fundir apagaria trabalho ou dinheiro de uma cliente real.
O planeador nunca emite um `DELETE`.

FK verificadas: `timesheets` (007, CASCADE), `service_photos` (027, CASCADE),
`service_reinforcements` e `service_price_audit` (006, CASCADE),
`invoice_items` (008, SET NULL), `client_notifications` (013, SET NULL).

---

## 7. Ferramentas offline

Todas puras, sem ligação a nada, e incapazes de escrever — qualquer flag de
escrita é recusada (fail-closed).

```bash
# Impacto da T07 sobre contratos existentes (desbloqueia o PR #46)
npx tsx scripts/compare-recurrence-compat.ts --input contratos.json

# Estado da identidade num snapshot
npx tsx scripts/diagnose-occurrence-identity.ts --input snapshot.json --out diagnostico.json

# Plano de reparação (intenções, nunca execução)
npx tsx scripts/plan-occurrence-repair.ts --input snapshot.json --out plano.json
```

A leitura faz *pick* explícito dos campos técnicos: nomes, emails, moradas e
telefones que venham no snapshot **não entram** em memória estruturada e por
isso não podem aparecer em relatório nenhum.

---

## 8. Compatibilidade T07: o que realmente muda

Medido, não estimado (`src/__tests__/recurrence-compat.test.ts`).

O algoritmo antigo agrupava semanas com `floor(timestamp / 7 dias)`. Como
1970-01-01 foi uma **quinta-feira**, a fronteira dos baldes caía à quinta,
repartindo cada semana civil em dois: segunda–quarta num, quinta–domingo no
seguinte.

**Regra exata:** um contrato quinzenal ou de 3 em 3 semanas muda de paridade
**se e só se** o dia escolhido e o dia de início ficarem em lados opostos dessa
fronteira.

| Início | Muda para dias… | Não muda para dias… |
|---|---|---|
| segunda, terça ou quarta | quinta, sexta, sábado, domingo | segunda, terça, quarta |
| quinta, sexta, sábado ou domingo | segunda, terça, quarta | quinta, sexta, sábado, domingo |

Ou seja: **24 das 49 combinações** mudam. Não depende do horário de verão, nem
do mês, nem do ano.

| Frequência | Muda? |
|---|---|
| diário | não |
| semanal | não |
| **quinzenal** | conforme a tabela acima |
| **3 em 3 semanas** | conforme a tabela acima |
| **mensal** | sim, em qualquer janela de vários meses (o antigo só gerava no primeiro mês) |
| personalizado | não |

O mensal só **acrescenta** datas; não remove nenhuma.

Falta o número real: quantos contratos da base estão em cada caso. É o que o
comparador dá assim que houver um snapshot.

---

## 9. Runbook da base descartável

Ainda **não executar**. Depende do incidente de credenciais encerrado, da base
descartável criada e de autorização explícita e separada.

1. aplicar as migrations existentes (001–070) só na base descartável;
2. exportar um snapshot sintético e correr
   `compare-recurrence-compat.ts` → guardar o relatório de impacto da T07;
3. correr `diagnose-occurrence-identity.ts` → guardar o diagnóstico;
4. correr `plan-occurrence-repair.ts` → guardar o plano;
5. **Passo 2** do SQL congelado (relatório de duplicados) — se devolver
   linhas, resolver antes de continuar;
6. **Passo 1** (coluna) e **Passo 3** (backfill conservador);
7. verificar quanto ficou por preencher (consulta 6.4);
8. resolver os casos de revisão humana com o plano;
9. **Passo 4** (índice único);
10. validar com as consultas do **Passo 6** — a 6.2 tem de devolver zero;
11. testar a concorrência: duas gerações em simultâneo → uma linha;
12. **Passo 7** (rollback) e repetir do ponto 6 para provar idempotência.

Só depois se coloca a questão de aplicar em produção — com autorização
separada, e nunca por analogia com este documento.

---

## 10. O que fica em standby

- **integração da geração idempotente** com o cron e as actions: o código está
  preparado (`decideEnsure`), mas ligá-lo exige a coluna, que ainda não existe;
- **escrever `occurrence_date` na exclusão** em vez da data agendada: mesma
  dependência;
- **`contracts.month_day` / `month_week` / `month_weekday`**: existem no schema
  e nenhum código os lê; decidir entre usar ou remover exige migration;
- **execução da reparação**: só na base descartável, com flag própria que
  ainda não está implementada, de propósito.

---

## 11. Riscos

- **A paridade quinzenal muda** para os contratos da tabela da secção 8. É
  risco da T07, não da T08 — mas é a T08 que o torna mensurável. Os serviços já
  gerados não são tocados; a diferença aparece na geração seguinte.
- **O índice único falha se houver duplicados** por resolver. Por isso o
  relatório de duplicados é o Passo 2, antes de tudo.
- **`CREATE UNIQUE INDEX` sem `CONCURRENTLY` bloqueia escritas** na tabela.
  Numa base com tráfego real usa-se a variante `CONCURRENTLY`, que não pode
  correr dentro de transação e deixa um índice inválido se falhar.
- **O backfill conservador deixa linhas por preencher.** É deliberado: `NULL`
  está fora do índice parcial, por isso não bloqueia nada, e adivinhar
  reescreveria histórico real.
