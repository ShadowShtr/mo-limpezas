# Auditoria pre-entrega - 2026-06-16

## Escopo

Revisao geral antes de entregar o sistema para operacao com cerca de 40 colaboradores e 3 gestores.

## Problemas corrigidos

- Caixa financeiro duplicava lancamentos automaticos ao marcar faturas/folhas como pagas mais de uma vez.
- Faturas que deixavam de estar pagas mantinham `paid_at`, `payment_method` e lancamento no caixa.
- Lancamentos manuais de caixa aceitavam `company_id` vindo do cliente sem validar empresa/perfil.
- Acoes de clientes e contratos usavam admin client sem conferir permissao interna.
- Middleware usava `user_metadata.role`, sujeito a divergencia com `profiles.role`.
- Colaborador em detalhe de cliente era redirecionado para `/dashboard`; agora vai para `/app`.
- Historico de presenca tinha campo `notes` enviado na correcao, mas sem input visivel.
- Corrigidos erros de lint relacionados a estado em render/effects, ternarios sem efeito, imports e tipos.

## Protecao de dados

- Criada migration `024_cash_flow_reference_integrity.sql`.
- Aplicado no Supabase remoto o indice unico:
  `cash_flow_entries(company_id, reference_type, reference_id)` para referencias automaticas.
- O `supabase db push` nao foi usado porque o historico remoto tentou reaplicar migrations antigas; a query da migration 024 foi executada isoladamente com `supabase db query --linked`.

## Validacao

- `npm test`: 257 testes passaram.
- `npm run lint`: 0 erros, 8 warnings conhecidos.
- `npm run build`: passou.

## Warnings restantes

- `scripts/run-migrations.mjs`: variavel nao usada.
- Tres avisos de `<img>` do Next.
- Tres variaveis nao usadas em tarefas/demo.

