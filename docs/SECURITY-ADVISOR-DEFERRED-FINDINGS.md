# SECURITY_ADVISOR_DEFERRED_FINDINGS

**Aberto:** 2026-08-29
**Estado:** aberto — deliberadamente **fora** da 085
**Âmbito:** superfície pública de base de dados (funções e grants históricos)

---

## Contexto

A 085 fechou o que estava **provado** pela leitura read-only de produção de
2026-08-29: duas views sem `security_invoker` legíveis por `anon`, e três
funções `SECURITY DEFINER` sem `search_path` com `EXECUTE` para `anon`.

Este documento regista o que o advisor assinalou e a 085 **não** tocou. Não é
uma lista de coisas esquecidas: é a fronteira entre o que foi medido e o que
precisa de caracterização antes de se lhe mexer.

Uma migration de incidente que alarga o âmbito para "aproveitar a viagem"
deixa de ser auditável, e um `REVOKE` sobre uma função cujo papel na avaliação
de RLS não foi medido pode partir autorização legítima em produção.

## A. `can_access_service(uuid)` — PRIORIDADE ALTA na task seguinte

```
SECURITY DEFINER = YES
search_path fixado = NO
anon/authenticated EXECUTE = YES
```

Usada em policy de RLS: `034_rls_servicos_clientes_locais.sql:47` →
`USING (can_access_service(id))`.

**Porque não entrou na 085:** é invocada durante a avaliação de policies de
`services`. Revogar `EXECUTE` a `authenticated` pode fazer a policy deixar de
avaliar para o próprio utilizador a quem ela devia dar acesso — exactamente a
classe de erro que a 083 documentou ao explicar porque usou `get_my_role()` em
vez de uma subconsulta a `profiles`.

**A caracterizar antes de decidir:**

1. Se a avaliação da policy corre com os privilégios do chamador ou do dono.
2. O que acontece a um `authenticated` legítimo sem `EXECUTE`, medido em PG17.
3. Se o `search_path` pode ser fixado isoladamente (provavelmente sim, e sem
   risco) antes de qualquer decisão sobre `EXECUTE`.

Nota: fixar `search_path` e revogar `EXECUTE` são decisões **separáveis**. A
primeira é quase certamente segura por si só.

## B. `handle_new_user()` — achado composto

```
search_path = pg_catalog, public   (JÁ corrigido pela 068)
anon/authenticated EXECUTE = YES   (por corrigir)
```

**Correcção a um relatório anterior:** classificar isto como "falso positivo"
foi impreciso. O `search_path` está correcto desde a 068, mas o `EXECUTE` é um
achado **independente** e continua aberto.

**Porque não entrou na 085:** é `RETURNS trigger`. Uma função de trigger é
invocada pelo motor, não pelo papel que faz o `INSERT`, e o efeito prático de
lhe revogar `EXECUTE` depende disso. Exige análise própria — incluindo o que a
068 já decidiu sobre o bootstrap de perfis.

## C. Restantes `function_search_path_mutable`

Varredura a repetir na task seguinte, sobre o estado **pós-085**. As três que a
085 fixou saem da lista; as que sobrarem devem ser triadas uma a uma, com
callers mapeados, e não fechadas em bloco.

## D. Grants históricos amplos em tabelas que hoje dependem de RLS

O incidente da 083/084 (`fixed_variable_payments` com `TRUNCATE`/`REFERENCES`/
`TRIGGER`/`MAINTAIN` concedidos a `anon` e `authenticated`) e o desta 085 têm a
mesma forma: **grants concedidos antes de o RLS existir, nunca revistos depois**.

Vale uma varredura sistemática, read-only, de todas as tabelas de `public`:

- que papéis têm que privilégios, incluindo `PUBLIC` (grantee = 0);
- quais desses privilégios têm caller real;
- quais são incompatíveis com a invariante pretendida da tabela.

`TRUNCATE` merece atenção própria: **não passa por RLS**.

## Regra de método

Cada item acima segue o mesmo caminho antes de virar migration:

    ALVO → callers (src/, scripts/, policies, cron, migrations)
         → papel de cada caller (service-role ou sessão)
         → o que quebra se anon perder acesso
         → o que quebra se authenticated perder acesso
         → ACL realmente necessária
         → decisão versionada

`UNKNOWN_CALLER = FAIL_CLOSED`: sem caller identificado, a resposta é fechar —
mas fechar com prova, não por precaução.
