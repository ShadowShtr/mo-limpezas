# CODEX_TASK_12 - revisao adversarial dos PRs #81 e #82

## Escopo imutavel

- Base da reproducao: `f001866c9efa2479ab05c9e52308674c5b676f3c`.
- PR #81 testado em `a10c7b2bf059acd6ee2eaced65c07e2b409c0565`.
- PR #82 testado em `5eaee43d01025f7f8961a7a527219ab092957738`.
- PostgreSQL real descartavel: `postgres:16-alpine`, versao 16.15.
- Concorrencia: duas ligacoes PostgreSQL reais.
- Producao, storage e migrations de producao: zero escritas.
- Os PRs #81, #82 e #84 nao foram alterados.

O teste materializa os ficheiros das duas HEADs exatas com `git show`. Assim, a
reproducao nao depende de uma copia editada dessas branches.

## Resultado executivo

| Hipotese | Resultado |
|---|---|
| F14-A, revalidacao apos conflito | **CONFIRMED_BUG** para `type`, `amount` e `status` |
| F14-B, unmark de movimento legado | **CONFIRMED_BUG** |
| F14-C, composicao do manifesto | **PARTIAL**: atomicidade segura, prestate incompleto |
| Periodos fechados | politica atual valida apenas competencia |

## F14-A - conflito e concorrencia

A reproducao usa um trigger apenas como barreira deterministica. A ligacao A
inicia `mark_payment_paid` e para imediatamente antes do `INSERT`. A ligacao B
insere uma linha concorrente com a mesma identidade unica. Quando A continua,
o `ON CONFLICT DO NOTHING` do #81 e acionado.

O ramo de conflito relê apenas o `id` e aceita como resultado uma linha com:

- `type = entrada`;
- valor `999.00` para uma obrigacao de `100.00`;
- `status = pendente` apesar de o pagamento terminar `pago`.

O isolamento por empresa e por identidade de referencia esta correto: empresa
diferente nao colide, e referencia de outro pagamento nao e adotada. Duas
chamadas simultaneas normais terminam com um pagamento pago e um movimento.

Correcao proposta, nao implementada: depois do conflito, reler a linha completa
com a mesma validacao usada no caminho de reutilizacao (`company`, referencia,
`type`, `amount` e `status`) e abortar a transacao em qualquer divergencia.

## F14-B - proveniencia, unmark e conciliacao

O caminho completo foi executado com o executor exato do #82:

1. o repair cria o pagamento e liga o movimento legado;
2. o #81 confirma o mesmo movimento, preservando o seu `id`;
3. `unmark_payment_paid` apaga esse movimento legado.

O schema/protocolo atual nao distingue um movimento criado pelo mark de um
movimento preexistente reutilizado. Portanto `SCHEMA_OR_PROTOCOL_GAP = YES`.

Quando o movimento esta conciliado, o delete ainda ocorre. A FK com
`ON DELETE CASCADE` apaga a correspondencia de conciliacao, enquanto a transacao
bancaria continua marcada como reconciliada. Isto elimina evidencia financeira
e deixa estados semanticamente divergentes.

Correcao proposta, nao implementada:

- registrar proveniencia e prestate de reutilizacao de forma transacional;
- no unmark, apagar somente movimentos criados pelo mark;
- para movimento legado, restaurar o prestate conhecido;
- recusar unmark quando exista conciliacao, salvo fluxo explicito de reversao;
- manter `mark -> unmark -> mark` sobre a mesma entidade legada, sem duplicar.

## F14-C - manifesto e rollback

### Apply

| Campo alterado entre snapshot e apply | Protegido hoje | Deve proteger |
|---|---:|---:|
| `description` | nao | sim |
| `amount` | sim | sim |
| `date` | nao | sim |
| `status` | sim | sim |
| `category` | nao | sim |
| `expense_category_id` | nao | sim |
| `reference_type` | sim | sim |
| `reference_id` | sim | sim |
| `company_id` | sim | sim |
| `notes` | nao | sim |
| `type` | sim | sim |
| `created_at` | nao | sim, como sinal de substituicao de prestate |

Consequencias comprovadas:

- uma categoria estruturada atribuida depois do snapshot e sobrescrita pelo
  valor antigo ao criar o pagamento;
- uma data alterada depois do snapshot gera competencia a partir da data antiga;
- um anexo criado antecipadamente para o UUID alvo e silenciosamente adotado
  quando o pagamento nasce.

### Garantias que funcionam

- colisao do UUID alvo: rollback total;
- segunda aplicacao: rejeicao segura, zero duplicados;
- falha depois de 1, 2, 3, 4 ou 5 itens: zero pagamentos persistidos;
- alteracao de valor, estado, tipo, empresa ou referencia: apply recusado.

### Rollback

O rollback recusa pagamento pago e nao faz rollback parcial. Porem aceita e
apaga o repair depois de alteracoes em descricao, categoria, notas e competencia
do pagamento, ou data, categoria e notas do movimento. Tambem apaga o pagamento
e deixa um anexo generico orfao.

Correcao proposta, nao implementada: o manifesto deve conter e comparar o
prestate economico e documental completo. O rollback deve validar o estado
integral autorizado e recusar quando existam anexos ou atividade posterior.

## Periodos financeiros

| Competencia | Data de caixa | Resultado atual |
|---|---|---|
| aberta | fechada | sucesso |
| fechada | aberta | recusado |
| aberta | aberta | sucesso |
| fechada | fechada | recusado |

`CURRENT_PERIOD_POLICY = COMPETENCE_ONLY`.

Politica proposta: uma RPC que altera a obrigacao e cria/edita caixa deve validar
os dois periodos. A competencia protege a obrigacao; `p_paid_on` protege o
movimento de caixa. Se qualquer um estiver fechado, a transacao inteira falha.

## Reproducao

```powershell
npm test -- --run src/__tests__/adversarial-81-82-postgres.test.ts
```

Resultado local: `48/48`. O teste inicia e remove o seu proprio container,
cria uma base vazia e nao le credenciais da aplicacao.

`PATCH_PROPOSED = NO`: esta branch contem apenas reproducao, documentacao e a
declaracao de tipos necessaria ao harness. As correcoes devem ser revistas e
implementadas separadamente.
