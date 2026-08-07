# Snapshot de compatibilidade da T07

Procedimento para transformar o risco do PR #46 de "talvez mude contratos" num
número exato.

> **Este procedimento é executado pelo proprietário, no painel Supabase.**
> Nenhum agente, script ou automatismo do repositório tem — nem deve ter —
> acesso para o fazer enquanto o incidente de credenciais estiver aberto.

---

## 1. Porquê

O motor de recorrência da T07 conta semanas de forma diferente do algoritmo
anterior. A regra exata está medida em `src/__tests__/recurrence-compat.test.ts`:

> um contrato quinzenal ou de 3 em 3 semanas muda **se e só se** o dia
> escolhido e o dia de início ficarem em lados opostos da fronteira de
> quinta-feira do algoritmo antigo — 24 das 49 combinações possíveis.

O que falta não é a regra. É saber **quantos contratos reais** caem em cada
caso. Sem esse número, o #46 não deve ir a merge.

---

## 2. Como obter (só leitura)

No **SQL Editor do painel Supabase**, autenticado como proprietário.

Não usar `SUPABASE_SERVICE_ROLE_KEY`. Não usar `.env.local`. Não usar nenhum
script do repositório. A chave antiga continua por revogar — ver
`docs/incidents/2026-08-06-credential-exposure.md`.

```sql
SELECT
  id,
  frequency,
  weekdays,
  interval_days,
  starts_on,
  ends_on,
  excluded_dates
FROM contracts
ORDER BY id;
```

Só isto. Sem nome, cliente, morada, email, telefone, valor, perfil ou qualquer
dado pessoal.

Exportar como JSON e guardar **fora do git**:

```
tmp/t07-contracts-snapshot.json
```

`tmp/` e `*-snapshot.json` estão em `.gitignore`. Confirmar antes de continuar:

```bash
git status --short          # o snapshot NÃO pode aparecer
git check-ignore -v tmp/t07-contracts-snapshot.json
```

---

## 3. Formato aceite

A ferramenta aceita o resultado do `SELECT` diretamente, em `snake_case`, mas
precisa da janela de análise à volta:

```json
{
  "window": { "start": "2026-08-01", "end": "2027-07-31" },
  "contracts": [ <linhas do SELECT> ]
}
```

A janela recomendada é de 12 meses a partir de hoje: é o horizonte em que
ocorrências futuras podem ainda vir a ser geradas.

A leitura faz *pick* explícito dos campos técnicos — qualquer campo extra que
venha no export é ignorado e não entra em memória.

---

## 4. Correr

```bash
npx tsx scripts/compare-recurrence-compat.ts \
  --input tmp/t07-contracts-snapshot.json \
  --out tmp/t07-compat-report.json
```

O resumo agregado sai no terminal. O JSON detalhado, por contrato, contém
`id`s reais — **fica local, nunca é versionado nem colado numa PR**.

---

## 5. O que reportar

Só agregados:

| Métrica | Valor |
|---|---|
| total de contratos | |
| sem alteração | |
| com alteração | |
| quinzenais alterados | |
| 3-em-3-semanas alterados | |
| mensais com datas adicionais | |
| diários alterados | (esperado: 0) |
| semanais alterados | (esperado: 0) |
| personalizados alterados | (esperado: 0) |
| datas acrescentadas | |
| datas removidas | |

---

## 6. Como ler o resultado

**Se `biweeklyChanged` e `triweeklyChanged` forem 0** — o bloqueio principal de
compatibilidade da T07 desaparece. Mesmo assim **não mergear
automaticamente**: trazer o relatório para revisão.

**Se houver contratos afetados** — não alterar o motor para reproduzir o
comportamento antigo. O comportamento novo é o correto; o antigo tinha uma
fronteira herdada da época Unix, acidental. O que se faz é classificar o
impacto por frequência (quantos contratos, quantos serviços futuros, se a
diferença acrescenta, remove ou troca a semana) e preparar um plano de
transição.

**Se `dailyChanged`, `weeklyChanged` ou `customChanged` forem diferentes de
zero** — parar. Essas frequências não devem mudar, e a ferramenta avisa. Seria
sinal de um defeito por descobrir, não de uma diferença esperada.

Nada de corrigir dados reais a partir deste relatório: ele mede, não repara.
