# SECURITY_033_CHARACTERIZATION_REQUIRED

**Aberto:** 2026-08-28
**Estado:** aberto — deliberadamente **não** resolvido na branch da 083
**Âmbito:** autorização (policies da 033). **Não** bloqueia a 083.

---

## Estado da hipótese

    033_LATENT_PRIVILEGE_BUG = HYPOTHESIS_NOT_PROVEN

A 033 endurece `cash_flow_entries` com policies que decidem o papel por
subconsulta directa a `profiles`:

```sql
(SELECT role FROM public.profiles WHERE id = auth.uid()) IN ('admin','gestor')
```

O relato associado é que essa forma **falha** para `authenticated`, porque a
subconsulta corre com os privilégios de quem chama e `authenticated` não teria
`SELECT` em `profiles` — a policy rebentaria com «permission denied for table
profiles» em vez de decidir. Foi esse raciocínio que levou a 083 a usar
`public.get_my_role()` (014, `SECURITY DEFINER`) em vez da subconsulta.

**A escolha da 083 está provada; o relato sobre a 033 não.**

A prova que existe hoje (`payment-authorization-hardening-postgres.test.ts`,
bloco «get_my_role sem SELECT directo em profiles») retira o `SELECT` em
`profiles` a `authenticated` e mostra que `payments_manager_select` continua a
decidir correctamente. Isso prova que **a 083 não depende** desse grant. Não
prova o que a 033 faz na ausência dele: a fixture concede `SELECT` em
`profiles` a `authenticated` durante os restantes blocos, e nenhum teste mede
as policies da 033 sem esse grant.

Concluir que a 033 está partida em produção exigiria saber o ACL real de
`profiles` em produção, e essa leitura ainda não foi feita.

## Porque a 033 NÃO foi alterada aqui

Mudar policies de `cash_flow_entries` a partir de uma hipótese não medida
arriscava fechar acesso legítimo por causa de um defeito que pode não existir —
e fá-lo-ia dentro de uma branch cuja invariante é outra (autorização de
pagamentos). Uma alteração de autorização sem caracterização é a mesma classe
de erro que a 083 existe para corrigir.

    033_CHANGED = NO

## Task futura — READ-ONLY, com Postgres

Sem escrita em produção. A caracterizar:

1. **ACL real esperado** de `public.profiles` em produção — em particular se
   `authenticated` tem `SELECT`, e por que via (grant directo, PUBLIC, herança).
2. **Que policies da 033** usam subquery directa a `profiles`, uma a uma, e em
   que tabelas.
3. **Callers reais** de cada uma: quem chega a essas policies como
   `authenticated` e não como `service_role`.
4. **Comportamento medido** de `authenticated` sem `SELECT` em `profiles`
   contra essas policies, em PG17 descartável — erro de permissão, ou decisão
   correcta?
5. **Impacto funcional** de cada resultado, do lado do produto.
6. **Decisão:** migrar para o helper `SECURITY DEFINER` (como a 083) ou manter
   a subconsulta, com o motivo registado.

Só depois disto a hipótese muda de estado. Enquanto não mudar, mantém-se
`HYPOTHESIS_NOT_PROVEN` — não «provavelmente verdade».
