# Migração de Dados Reais — Mó Limpezas

> Última revisão: 2026-06-18.
> Substituição dos dados fictícios (seed/demo) pelos dados reais da empresa, exportados da app anterior.

Este documento descreve **o que foi feito**, **as decisões tomadas** e **como reproduzir**. Os
ficheiros com dados pessoais (clientes/colaboradores) **não** estão no repositório — ver
[Privacidade](#privacidade-e-ficheiros-fora-do-git).

---

## 1. Resumo

| Entidade | Antes (demo) | Depois (real) |
|---|--:|--:|
| `profiles` (utilizadores) | 63 | **28** |
| `clients` | 63 | **900** |
| `locations` | 82 | **899** |
| `teams` | 25 | **16** |
| `team_members` | 63 | **21** |
| Tabelas operacionais (services, timesheets, invoices, payroll, etc.) | com demo | **vazias** (limpas) |

Empresa única: **Mó Limpezas** — `company_id = 00000000-0000-0000-0000-000000000001`.

---

## 2. Limpeza dos dados fictícios

Removidos **todos** os dados demo, **exceto** os 2 utilizadores de teste pedidos:

- `shadowshtr@gmail.com` → perfil **Vitor Medina** (`admin`)
- `vitorshadowmedina@gmail.com` → perfil **Vitor Colaborador** (`colaborador`)

A limpeza respeitou a ordem das dependências (FK). Tabelas esvaziadas:
`timesheets, invoices, cash_flow_entries, services, contracts, absences, vacation_requests,
team_members, teams, locations, clients, vehicles, notifications, client_notifications,
payroll_records, vehicle_allocations, collaborator_documents, management_tasks, invoice_items,
service_price_audit, service_reinforcements, audit_logs`.

Os utilizadores demo do `auth` foram apagados via Admin API (`auth.admin.deleteUser`), o que
remove o `profile` por cascata (`profiles.id REFERENCES auth.users ON DELETE CASCADE`).

> **Gotcha registado:** 5 utilizadores não apagavam ("Database error deleting user"). Causa: FK
> de `payroll_records.collaborator_id` (e a view `monthly_hours_summary`) ainda apontava para
> esses perfis. Solução: esvaziar `payroll_records` **antes** de apagar os utilizadores.

---

## 3. Importação dos dados reais

Fonte: ficheiros Excel exportados da app anterior, normalizados para JSON
(50 + 850 clientes, 26 colaboradores, 16 equipas).

### 3.1 Colaboradores (`profiles` + `auth.users`)

Cada colaborador foi criado via `auth.admin.createUser` com `user_metadata`
(`company_id`, `role`, `full_name`) — o trigger `handle_new_user` cria o `profile`
automaticamente; depois atualiza-se `phone`/`status`.

**Mapeamento de papéis** (perfil da app anterior → papel nesta app):

| App anterior | Esta app |
|---|---|
| `admin` | `admin` |
| `supervisor` | `gestor` |
| `user` | `colaborador` |
| `semacesso` | `colaborador` |

**Login/email:**
- Tem email real → usa o email.
- Só tem username → `username@molimpezas.local`.
- Sem username (derivado do nome) → `slug-do-nome@molimpezas.local`.

**Senhas:** geradas (provisórias, formato `Mo<random>!9`), **sem envio de email**. Cada pessoa
troca depois em "Recuperar password". Logins `@molimpezas.local` não recebem email de recuperação
(domínio interno) — a senha é alterada por um admin.

### 3.2 Clientes (`clients`)

Campos importados: `name` (Nome), `address` (Morada), `phone` (Contacto). O **Saldo** (dívidas)
foi **ignorado** por decisão do negócio (módulo financeiro ainda não existe). `type` definido por
heurística: nomes que parecem imóvel/negócio (`prédio`, `lavandaria`, `alojamento`, `loja`,
`clínica`, etc.) → `empresa`; restantes → `individual`.

Proteção anti-duplicado por `name + phone` (idempotente ao reexecutar).

### 3.3 Locais (`locations`)

A app mostra moradas e a aba **Locais** a partir da tabela `locations`, não de `clients.address`.
Por isso foi criado **1 local por cliente** (`name = "Morada principal"`, `address = morada`,
`service_type = limpeza_regular`). Clientes sem morada não geram local.

### 3.4 Equipas (`teams` + `team_members`)

`leader_id` = perfil do supervisor (Alessi Santos, onde indicado). Os membros vinham concatenados
sem separador (ex.: `"Monique Ju Marcela Martins"`); são separados por **correspondência gulosa do
nome mais longo da esquerda para a direita** contra a lista de colaboradores, com fronteira de
espaço. Isto distingue corretamente casos como `"cris"` vs `"cris (nara)"`.

---

## 4. Geocodificação dos locais

Os 899 locais foram geocodificados com a **Mapbox Geocoding API v6** (token
`NEXT_PUBLIC_MAPBOX_TOKEN`) para preencher `lat`/`lng` e aparecerem no Mapa.

- A morada é **limpa** antes do pedido: remove-se a cauda administrativa
  (`"União das freguesias de…"`) e URLs, que confundem o geocoder. O **código postal** (NNNN-NNN)
  é o sinal mais forte.
- Pedido com `country=pt`, `limit=1` e `proximity=-8.97,39.02` (viés para a zona Carregado/Alenquer).
- Fallback para os que falham: tenta `código postal + Portugal`.

**Resultado:** 899/899 com coordenadas. A maioria fica ao nível da rua/código-postal (não do número
de porta — cobertura limitada do Mapbox em PT), o que é adequado para pins de mapa. Validado em
Odivelas, Quinta do Anjo, S. J. da Talha, Samora Correia, Póvoa de Santa Iria e Azambuja.

**Custo:** ~905 pedidos — dentro do free tier (100.000/mês). **0 €.**

---

## 5. Como reproduzir

Scripts utilitários (data-driven; **não** contêm dados pessoais):

```bash
# 1. Importar (limpar demo + inserir reais). Lê um JSON normalizado externo.
node scripts/migrate-real-data.mjs --data <caminho>.json [--wipe]

# 2. Geocodificar locais sem coordenadas
node scripts/geocode-locations.mjs

# 3. (FUTURO) Envio em massa de recuperação de password.
#    Requer domínio verificado no Resend. Sem --send é dry-run (só lista).
node scripts/send-password-recovery.mjs            # dry-run
node scripts/send-password-recovery.mjs --send     # envia
```

> **Recuperação de password sem email** (enquanto não há domínio verificado no
> Resend): as colaboradoras trocam em Perfil → "Alterar password"; admins/gestores
> usam "Redefinir password" na ficha do colaborador (gera nova senha provisória).
> O envio por email fica pronto em `scripts/send-password-recovery.mjs` para quando
> o domínio existir.

Requer `.env.local` com `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e
`NEXT_PUBLIC_MAPBOX_TOKEN`. Ver cada script para o formato do JSON esperado.

---

## 6. Privacidade e ficheiros fora do git

Nunca commitar dados pessoais nem segredos. Ficheiros ignorados (`.gitignore`):

- `CREDENCIAIS_COLABORADORES.local.md` — senhas provisórias geradas.
- `*.local.md`, `scripts/*.local.json`, ficheiros de dados de import (`*_data*.json`, dumps de clientes).

---

## 7. Pendentes

- 1 cliente sem morada (**Bruna Alexandra**) — sem local/coordenadas até ter endereço.
- `clients` não guarda saldo/dívida — migrar para o módulo financeiro quando existir.
- Confirmar papel dos 2 "sem acesso" (Dani parque da vila, cris) — atualmente `colaborador`.
- Viaturas das equipas (Opel/Corsa/Berlingo/próprio) não foram associadas a `vehicles`.
