# T10 — Realtime, concorrência e invalidação de estado

Documento técnico da Task T10. Ataca o sintoma principal do produto: *"uma
pessoa altera e a outra continua a ver estado antigo — ou diferente"*.

Tudo offline. Nenhuma subscrição existente foi alterada nesta entrega: o que
entra é o núcleo puro e testável, mais a auditoria que diz onde ligá-lo.

---

## 1. Auditoria das subscrições Realtime

Dez handlers `postgres_changes` em oito ficheiros.

| Ficheiro | Tabela | Filtro |
|---|---|---|
| `app/servico/[id]/_components/team-realtime.tsx` | `timesheets` | ✅ `company_id` |
| `cobrancas/_components/daily-billing-client.tsx` | `services` | ✅ `company_id` |
| `financeiro/_components/financial-dashboard-client.tsx` | `services` | ✅ `company_id` |
| `registo-ponto/_components/registo-ponto-client.tsx` | `timesheets` | ✅ `company_id` |
| `components/layout/app-header.tsx` | `notifications` | ✅ `user_id` |
| **`mapa/_components/map-view.tsx`** | `services` | ❌ **sem filtro** |
| **`components/layout/notifications-bell.tsx`** | `notifications` (×3) | ❌ **sem filtro** |
| **`components/layout/sidebar-notif-badge.tsx`** | `notifications` | ❌ **sem filtro** |

**5 dos 10 handlers não declaram filtro** e dependem inteiramente da RLS.

A RLS existe e é correta (`notifications`: *"users see own notifications"*),
por isso **não há aqui uma fuga de dados demonstrada**. O problema é outro, e é
real:

- **defesa em profundidade inconsistente** — metade das subscrições protege-se
  a si própria, a outra metade não;
- **ruído** — sem filtro, o canal entrega mais eventos e cada um provoca um
  refetch;
- **`notifications-bell.tsx` usa o payload como fonte de verdade**: o handler
  de `INSERT` faz `toast(payload.new.title)` diretamente. É o único sítio onde
  conteúdo de um evento chega ao ecrã sem passar pelo servidor.

## 2. O princípio

> **Um evento Realtime é um gatilho, não uma fonte de verdade.**

A tentação é fundir `payload.new` no estado local. Isso cria um objeto que o
servidor nunca produziu: o payload traz as colunas da tabela, não o que a
página realmente lê — juntas, vistas, valores calculados, permissões. O
resultado é um cartão com metade dos dados certos e metade inventados.

O fluxo correto:

```
escrita → resposta autoritativa → estado local
                              ↘ invalidação → outros clientes → refetch
```

## 3. Reconciliador de eventos

`src/domain/realtime/event-reconciler.ts` — puro, sem Supabase, sem rede, sem
relógio.

O evento decide apenas **se vale a pena voltar a perguntar**. O veredicto tem
dois campos, `decision` e `reason`: não há por onde o payload escapar para o
estado da aplicação — há teste a garanti-lo.

| Decisão | Quando |
|---|---|
| `REFETCH` | mudança relevante — buscar snapshot autoritativo |
| `IGNORE_UNKNOWN_TABLE` | tabela que este consumidor não observa |
| `IGNORE_FOREIGN_TENANT` | evento de outra empresa |
| `IGNORE_DUPLICATE` | já processado |
| `IGNORE_STALE` | chegou fora de ordem, mais antigo do que o conhecido |

### Ordem

A rede não garante ordem. Receber `UPDATE B` e depois `UPDATE A` faria o ecrã
voltar atrás no tempo.

A versão vem de **`updated_at`**, que já existe em todas as tabelas de negócio
(trigger `update_updated_at`). **Nenhuma coluna nova foi criada.** Comparação
lexicográfica de timestamps ISO, que é cronológica no formato do PostgreSQL.

Sem `updated_at` no payload não se presume antiguidade — mais vale um refetch
a mais do que perder uma mudança.

### DELETE

O `old` de um `DELETE` traz frequentemente só a chave primária. Não dá para
avaliar antiguidade nem empresa, por isso **um `DELETE` nunca é descartado por
antiguidade** — vale sempre um refetch, que é feito no servidor e já está
limitado à empresa da sessão.

### Reconexão

Ao reconectar, `ledger.reset()` é obrigatório: durante a desconexão houve
escritas que nunca chegaram, e o que está em memória deixa de poder servir para
decidir o que é antigo. O resync é autoritativo, não incremental.

### Memória

O ledger tem teto (500 entradas por omissão) e descarta as mais antigas. Uma
sessão de um dia inteiro não o faz crescer sem fim.

## 4. Matriz de invalidação entre domínios

`revalidateBusinessPaths` pede **rotas**. Quem escreve uma action sabe o que
mudou ("um contrato"), não necessariamente que ecrãs dependem disso — e é aí
que nascem os buracos.

`invalidateBusinessState({ domains })` inverte a pergunta. **Estende o helper
existente** (`src/lib/revalidate-business.ts`); não é um mecanismo concorrente.

| Domínio | Ecrãs | Dependência menos óbvia |
|---|---|---|
| `contracts` | contratos, calendário, clientes, **cobranças**, relatórios | o defeito histórico: alterar o valor de um contrato deixava as cobranças com números antigos |
| `services` | calendário, clientes, cobranças, relatórios | é a unidade de trabalho: conta para horas, receita e cobrança |
| `clients` | clientes, calendário, contratos, cobranças | o nome aparece nos cartões e nas faturas |
| `locations` | locais, clientes, **calendário**, contratos, relatórios | o valor/hora entra no cálculo de cada serviço |
| `teams` | calendário, relatórios | o tamanho da equipa multiplica o valor |
| `collaborators` | relatórios, financeiro | horas e ausências |
| `invoices` | cobranças, financeiro, clientes, relatórios | |
| `payments` | financeiro, cobranças, relatórios | |
| `settings` | configurações, relatórios, financeiro, cobranças, calendário | IVA, taxa horária e subsídio entram em todos os cálculos |

Há teste a garantir que **nenhum domínio invalida todos os ecrãs** —
invalidação "nuclear" é tão problemática como a insuficiente.

Estado atual: **126 chamadas diretas a `revalidatePath`** espalhadas pelas
actions. A matriz existe para que acrescentar um consumidor novo passe a ser
uma alteração num sítio, e não uma caça a 126 chamadas.

## 5. Standby

Tudo o que segue é integração, e exige tocar em código que corre em produção —
fica para depois da revisão desta PR:

- **ligar o reconciliador aos 10 handlers** e acrescentar filtro `company_id`
  aos 5 que não o têm;
- **`notifications-bell.tsx`** deixar de usar `payload.new` para o toast;
- **substituir as 126 chamadas diretas** por `invalidateBusinessState`;
- **política de patch** — mapear os writes que gravam o formulário inteiro
  quando deviam gravar só os campos alterados. Dois utilizadores no mesmo
  contrato: A altera o horário, B grava com estado antigo e apaga a alteração
  de A. A correção exige olhar action a action;
- **concorrência otimista** com `updated_at` esperado — depende de decidir se
  o servidor rejeita ou funde, e isso é decisão de produto;
- **lifecycle das subscrições** (mudança de rota, remontagem, acumulação de
  listeners) — precisa de runtime real para ser verificado a sério.

## 6. Riscos

- **O reconciliador ainda não está ligado a nada.** Os testes provam a lógica,
  não o comportamento da aplicação. Ligá-lo muda o padrão de refetch de oito
  componentes e deve ser feito com a aplicação a correr à frente.
- **Acrescentar filtros `company_id`** reduz eventos recebidos. Se algum
  consumidor dependia (sem saber) de eventos que a RLS deixava passar, deixa de
  os receber. É a correção certa, mas é uma mudança de comportamento.
- **`IGNORE_STALE` depende de `updated_at` ser fiável.** É mantido por trigger
  na base, mas uma escrita que o contorne produziria um evento que o
  reconciliador considera antigo.

## 7. Nada de produção

Sem migrations, sem alterações de schema, sem ligação ao Supabase, sem
credenciais, sem testes contra a base real. Migration 070 intocada.
