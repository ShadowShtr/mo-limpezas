# T09 — Contrato ↔ Serviço ↔ Calendário

Documento técnico da Task T09. Nada foi aplicado: o SQL está congelado em
`supabase/frozen/T09_atomic_contract_sync.sql` e a integração fica desligada
até o schema da T08 existir.

---

## 1. Divergências encontradas

O payload do serviço era montado em **dois sítios independentes** que
discordavam entre si.

### 1.1 Valor de estofos — divergência em dinheiro

| Prioridade | Criação do contrato | Cron mensal |
|---|---|---|
| 1 | avença → 0 | avença → 0 |
| 2 | preço fixo | preço fixo |
| 3 | **`unit_value` (estofos)** | *(ausente)* |
| 4 | valor/hora | valor/hora |

Um contrato de estofos ficava com os primeiros meses ao preço por unidade e os
seguintes calculados por hora — ou a `null`.

**Causa de fundo:** `unit_value` **não é coluna nenhuma**. Existia apenas como
argumento no momento da criação, calculado no formulário
(`upholstery_units × upholstery_unit_price`). O cron não tinha como o saber.

**Correção:** a projeção canónica deriva o total de `upholstery_units` e
`upholstery_unit_price`, que **estão** persistidos no contrato. Os dois
caminhos passam a chegar ao mesmo número, sem alterar o schema.

### 1.2 Campos perdidos pelo cron

O cron não copiava `cleaning_type`, `payment_status`, `upholstery_type`,
`upholstery_notes`, `upholstery_units` nem `upholstery_unit_price`. Os serviços
dos meses seguintes nasciam sem essa informação — a mesma ocorrência com
conteúdo diferente conforme quem a criou.

### 1.3 `calcServiceValue` sem consumidor

`src/lib/calculations.ts` exporta `calcServiceValue` e **nenhum ficheiro o
chama**. O cálculo estava duplicado inline nos dois produtores.

### 1.4 Três horizontes sem relação documentada

| Onde | Janela |
|---|---|
| criação/atualização do contrato | 3 meses |
| cron mensal | 1 mês |
| reconciliação | 6 meses |

A reconciliação olhava para seis meses e decidia sobre ocorrências que a
criação nunca gerou. Os valores mantêm-se (mudá-los altera produção), mas
passam a estar num sítio só, com a invariante verificada por teste:
`RECONCILIATION ≥ CREATION ≥ CRON`.

---

## 2. Produtores, mutações e consumidores

**Produtores de serviços de contrato**

| Onde | Papel |
|---|---|
| `actions/contratos.ts` → `generateServicesForContract` | criação e atualização |
| `api/cron/generate-services` | geração mensal |
| `actions/intervencoes.ts` | intervenções na ficha do cliente |
| `calendario/_actions/create-service.ts` | serviço avulso (sem `contract_id`) |

**Mutações** — reagendar, mudar equipa, mudar valor, mudar notas e marcar falta
passam todas por `calendario/_actions/`, e todas marcam `is_exception = true`
quando há `contract_id`. Cancelar passa por `actions/cancellations.ts`.

**Consumidores** — calendário, ficha do cliente (intervenções), relatórios,
faturação, dashboard e cron.

---

## 3. Projeção canónica

`src/domain/scheduling/occurrence-projection.ts` — uma implementação só.

Entrada: contrato + data canónica + horário do dia + tamanho da equipa.
Saída: payload determinístico do serviço.

Prioridade do valor, agora única:

1. avença mensal → `0` (o serviço agenda; a avença fatura uma vez por mês);
2. preço fixo por serviço;
3. estofos por unidade (quantidade × preço);
4. valor/hora × duração × nº de pessoas;
5. sem base de cálculo → `null`, nunca `0` (que se confundiria com avença).

O arredondamento mantém o `toFixed(2)` que produção já usa. Muda valores
alterar isso, e essa decisão não é de uma consolidação técnica.

---

## 4. Identidade ≠ estado ≠ projeção

| Camada | O quê | Definida em |
|---|---|---|
| **identidade** | que ocorrência é esta | T08 |
| **estado atual** | onde está marcada, em que situação | `services` |
| **projeção** | o que o contrato diz que devia ser | T09 |

`CONTRACT_SYNCED_FIELDS` lista o que a sincronização pode reescrever.
`occurrence_date`, `contract_id` e `company_id` **não estão lá** — comparar
identidade com projeção foi exatamente o erro que fez o cron duplicar
ocorrências reagendadas.

---

## 5. Matriz de reconciliação

`decideReconciliation` é pura e a ordem das verificações é a própria política:

| Situação | Decisão | Escreve? |
|---|---|---|
| data em `excluded_dates` | `SKIP_EXCLUDED` | não |
| serviço concluído, em curso, falta, sem cobertura | `KEEP` | não |
| serviço cancelado | `KEEP_CANCELLED` | não |
| serviço com `is_exception` | `KEEP_EXCEPTION` | não |
| ocorrência prevista, sem serviço, contrato ativo | `CREATE` | **sim** |
| ocorrência prevista, sem serviço, contrato pausado/cancelado | `KEEP` | não |
| serviço conforme com a projeção | `KEEP` | não |
| serviço divergente e intocado | `UPDATE_FROM_CONTRACT` | **sim** |
| serviço sem ocorrência prevista e intocado | `REMOVE_ORPHAN` | **sim** |
| duas linhas com a mesma identidade | `MANUAL_REVIEW` | não |

Só três decisões escrevem. Uma exceção, um cancelamento ou uma data excluída
**nunca** produzem escrita — verificado por invariante.

### Alterações ao contrato

| Alteração | Efeito |
|---|---|
| dia da semana acrescentado | `CREATE` nas datas novas |
| dia da semana removido | `REMOVE_ORPHAN` só nas intocadas; concluídas e exceções ficam |
| frequência, `starts_on`, `ends_on` | recalcula o conjunto esperado; mesmas regras |
| horário, equipa, duração | `UPDATE_FROM_CONTRACT` nas intocadas |
| preço, IVA, tipo de limpeza | `UPDATE_FROM_CONTRACT` nas intocadas |
| contrato pausado | não cria; não apaga o que existe |
| contrato reativado | volta a criar |

### Estados do contrato

Valores reais de `contracts.status` (migration 005): **`ativo`**, **`pausado`**,
**`cancelado`**. Não há `encerrado` — não foi inventado nenhum enum.

---

## 6. Cancelamento e exclusão

**Cancelar ≠ apagar.** Um serviço cancelado mantém `occurrence_date`, ocupa a
identidade, não é recriado e continua auditável.

**Apagar = excluir a ocorrência canónica.** O código atual escreve em
`excluded_dates` a **data agendada**; com `occurrence_date` passa a escrever a
data canónica. Sem isso, apagar um serviço reagendado exclui a data errada e a
ocorrência original reaparece na corrida seguinte — o defeito encontrado na
T08. A decisão e os testes entram agora; a integração fica em standby porque
depende da coluna.

---

## 7. Escrita atómica

`supabase/frozen/T09_atomic_contract_sync.sql` — função
`sync_contract_occurrences(company_id, contract_id, plan)`.

- **`SECURITY INVOKER`** (não `DEFINER`): a RLS de `services` e `contracts`
  continua a aplicar-se. `search_path` fixado à mesma.
- **Isolamento por empresa** validado antes de qualquer escrita; contrato de
  outra empresa levanta exceção.
- **`pg_advisory_xact_lock`** por contrato: duas sincronizações do mesmo
  contrato serializam; contratos diferentes não se bloqueiam. Lock de
  transação, liberta sozinho.
- **`ON CONFLICT DO NOTHING`** com o predicado do índice parcial da T08 —
  retry-safe.
- **Rede de segurança na base:** o `UPDATE` e o `DELETE` filtram
  `is_exception = false AND status = 'agendado'`. Mesmo que o plano venha
  errado, a base recusa tocar numa decisão humana.
- **`contract_synced_at`** é declarado, para o trigger da migration 059 não
  marcar a sincronização como edição manual.
- **Devolve o estado autoritativo** (contagens + serviços), em vez de um
  sucesso vazio que obrigasse o frontend a inventar estado.
- Privilégios: `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE ... TO
  authenticated`. Nada para `anon`.

---

## 8. Calendário

Princípio fixado: **o serviço é o snapshot operacional da ocorrência; o
contrato é a regra para ocorrências futuras.** O calendário lê `services` e não
recalcula preço ou horário a partir do contrato para substituir o que está
persistido — isso só acontece por sincronização explícita, que respeita
exceções.

---

## 9. Standby

- **ligar a projeção canónica ao cron e às actions** — a decisão está isolada e
  testada, mas trocar os dois produtores altera o que é gerado em produção e
  deve entrar com o snapshot de compatibilidade na mão;
- **escrita atómica via RPC** — depende da coluna da T08 e da função da T09,
  nenhuma aplicada;
- **`excluded_dates` com `occurrence_date`** — mesma dependência;
- **`calcServiceValue` sem consumidor** — fica onde está; removê-lo ou
  reencaminhá-lo para a projeção é limpeza de outro domínio;
- **`reference_number`** — o retry por colisão continua como está. Não é
  identidade de ocorrência (isso é a T08) e trocá-lo por uma sequência exige
  migration.

---

## 10. Riscos

- **Ligar a projeção canónica muda valores de serviços gerados** para contratos
  de estofos: passam a ter o preço por unidade também nos meses do cron. É a
  correção de um defeito, mas altera números que já foram vistos.
- **`REMOVE_ORPHAN` apaga.** Só toca em serviços `agendado` e não-exceção, e
  regista a exclusão antes — mas continua a ser a decisão mais destrutiva da
  matriz, e por isso é a que mais testes tem.
- **A reconciliação depende da identidade da T08.** Sem `occurrence_date`
  preenchida, os serviços não participam: o plano vê as ocorrências como em
  falta. É seguro (não apaga), mas só fica correto depois do backfill.
