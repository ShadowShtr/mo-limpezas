# Anexos múltiplos — três fluxos que só aceitavam um ficheiro

> **Estado: implementado no branch, migration 074 NÃO APLICADA.**
> A aplicação da 074 em produção exige revisão do SQL versionado e autorização
> explícita, pela REGRA ZERO (`AGENTS.md`).

## O problema

Três fluxos guardavam **um** anexo em colunas da própria linha do registo:

| Fluxo | Colunas | Bucket |
|---|---|---|
| Pagamentos fixos/variáveis | `attachment_url`, `attachment_name`, `attachment_size`, `attachment_mime` | `payment-attachments` |
| Tarefas (Kanban) | `attachment_url`, `attachment_name` | `task-attachments` |
| Faltas | `document_url` | — (nunca teve action) |

Anexar um segundo ficheiro sobrescrevia as colunas. Pior: em Pagamentos, a
action **apagava o ficheiro anterior do storage** antes de gravar o novo.

```js
// src/app/actions/payments.ts, antes de 2026-08-18
if (payment.attachment_url) {
  await admin.storage.from(PAYMENT_ATTACHMENTS_BUCKET).remove([oldPath]);
}
```

Sem recuperação. Um utilizador que anexasse a fatura correcta por cima de um
recibo perdia o recibo.

**Já eram 1:N e não mudaram:** `service_photos` (027),
`collaborator_documents` (20260608), `bank_statement_imports` (043).

---

## O modelo

Uma tabela `attachments` genérica, `parent_type` + `parent_id`, modelada sobre
o que `service_photos` já provou neste projecto.

```
fixed_variable_payments ─┐
management_tasks        ─┼─ 1 ── N ── attachments
absences                ─┘
```

Ver `supabase/migrations/074_attachments.sql`.

### Três decisões, e porquê

**1. As colunas legadas ficam intactas.** A migration não as lê, não as altera,
não as apaga. Os anexos que já existem continuam exactamente onde estão.

O read model junta as duas fontes numa lista só, na leitura — nunca copiando.
Copiar o legado para `attachments` faria o mesmo ficheiro aparecer duas vezes
na UI.

```
[legado]  fatura-antiga.pdf     ← coluna attachment_url
[novo]    recibo.pdf            ← linha em attachments
[novo]    comprovativo.jpg      ← linha em attachments
```

**2. Sem FK para o pai.** `parent_id` aponta para três tabelas diferentes, logo
não há FK possível. A integridade é garantida no runtime: toda a operação
valida `auth → company_id → parent existe → parent pertence à company`, e o
`CHECK` de `parent_type` é a última linha de defesa, não a primeira.

**3. Anexos imutáveis.** `SELECT`, `INSERT`, `DELETE` — sem policy de `UPDATE`.
Trocar o `storage_path` de uma linha existente deixaria o ficheiro antigo órfão
no bucket, sem nada a apontar-lhe.

---

## A identidade de autorização é o trio

Nunca se lê nem se remove um anexo só por `attachment.id`. Revalida-se sempre:

```
company_id + parent_type + parent_id
```

Um id válido com o parent errado é negado. Um id de outra empresa é negado. Um
`parent_type` manipulado no pedido é rejeitado antes de chegar à base.

---

## Adicionar nunca remove

A regra que esta ronda existe para garantir. Em todo o caminho de adicionar há
**um só** `remove()` de storage: a compensação do ficheiro que acabou de ser
enviado quando o `INSERT` falha.

| Estado | O que acontece |
|---|---|
| upload falha | não se cria linha |
| upload ok, `INSERT` falha | remove-se **o ficheiro acabado de enviar**, e mais nenhum |
| upload ok, `INSERT` ok | anexo acrescentado à lista |

Remoção de storage só em `removeAttachment` (acção explícita do utilizador) ou
na compensação acima.

### Remover legado ≠ remover novo

São caminhos deliberadamente distintos, e a diferença não está escondida atrás
de lógica implícita:

- **legado** → limpa as colunas do registo pai + apaga o ficheiro correspondente;
- **novo** → apaga a linha de `attachments` + o ficheiro dela.

Remover um nunca afecta o outro.

---

## Idempotência

`client_event_id` estável por ficheiro escolhido (não por tentativa). Duplo
clique, retry de rede ou re-render devolvem o anexo já criado em vez de criar
um segundo. O índice único da 074 é o que o garante, no escopo da empresa — o
mesmo id noutro tenant é legítimo e permitido.

---

## Limites

| | |
|---|---|
| `MAX_ATTACHMENT_BYTES` | 20 MB — o que os fluxos já praticavam |
| `MAX_ATTACHMENTS_PER_PARENT` | 20 anexos **novos**; o legado não gasta quota |
| `ALLOWED_ATTACHMENT_MIME` | lista fechada: PDF, imagens, Word, Excel, texto |

Lista fechada de propósito: um bucket privado que aceite qualquer tipo é uma
superfície de upload arbitrário.

---

## Um achado do caminho

O `sanitize` dos helpers antigos trocava `/` por `_` mas mantinha os pontos:
`../../etc/passwd` saía como `.._.._etc_passwd`.

Isso é inofensivo enquanto caminho — sem separador, não há travessia. Mas
`isAttachmentPathInCompany` recusa qualquer caminho que contenha `..`, e o
resultado era um anexo que **subia com sucesso e depois nunca mais podia ser
aberto nem removido**. Um ficheiro preso no bucket.

Apanharia também o caso benigno: `relatório..final.pdf`.

Corrigido no `sanitize` (colapsa sequências de pontos), não no guard — o guard
deve continuar paranóico. Fixado em teste.

---

## Rollback

**PRE-USE** — enquanto a tabela estiver comprovadamente vazia:

```sql
DROP TABLE public.attachments CASCADE;
```

Validado contra PGlite.

**POST-USE** — depois de utilizadores criarem anexos, **nunca `DROP`**:

1. reverter runtime/UI para o deploy anterior;
2. preservar as linhas de `attachments` e os ficheiros no storage;
3. os anexos novos ficam invisíveis, mas intactos e recuperáveis.

O legado continua a funcionar em qualquer das fases, porque nunca foi tocado.

---

## Ligações

- `supabase/migrations/074_attachments.sql` — a tabela, índices e RLS
- `src/lib/attachments.ts` — contrato, limites, read model
- `src/app/actions/attachments.ts` — actions partilhadas pelos três fluxos
- `src/components/attachments/attachments-field.tsx` — o campo, um só
- `src/__tests__/attachments.test.ts` — 38 testes
- `AGENTS.md` — REGRA ZERO
