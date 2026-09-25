# Testes PostgreSQL descartáveis

Entrada comum: `src/__tests__/helpers/pg-container.ts`. O helper arranca `postgres:17.11-alpine`, publica uma porta aleatória apenas em `127.0.0.1` e só devolve depois de uma ligação TCP executar `SELECT 1`.

## Isolamento e limpeza

- `name` é um prefixo legível. O helper acrescenta PID, sequência e UUID.
- Cada contentor recebe uma etiqueta de propriedade. `stop()` remove somente o contentor com o nome e a etiqueta criados por aquela chamada.
- Uma falha durante o arranque limpa o próprio contentor. Duas execuções com o mesmo prefixo não se removem.
- A ligação devolvida é explícita: host local, porta aleatória, utilizador `postgres` e base fictícia. O helper não lê `.env` nem conhece a base da empresa.
- Para corridas, abrir dois `pg.Client` sobre `container.connection` e coordená-los com `createBarrier(2)`. Não usar `sleep` para decidir a ordem.

Sempre fechar clientes em `finally` e chamar `container.stop()` em `afterAll` ou `finally`.

## Baseline e diferenças conhecidas

`production-baseline.ts` monta um recorte observado em 27/08/2026: 47 tabelas, 93 políticas e 43 chaves para `profiles`. O fixture contém forma de tabelas, PK/FK, RLS e políticas, sem dados reais. Ele não substitui um dump completo nem acompanha automaticamente migrations posteriores.

O andaime Supabase é deliberadamente reduzido. Ele cria somente os papéis, claims e objetos de `auth` necessários às políticas. Não reproduz Auth, Storage, Realtime, extensões, índices avulsos, triggers ou todas as funções da plataforma. Cada suite deve declarar os complementos que adiciona. O harness do CRM, por exemplo, aplica os complementos e migrations indicados em `crm-pg-harness.ts` sobre esse baseline.

Depois de novas migrations, conferir se o teste mede o schema pretendido: baseline observado, overlay explícito ou cadeia de migrations. Um teste verde contra fixture antiga não comprova compatibilidade com o schema atual.

## Função SQL e RLS são provas diferentes

Uma consulta como `postgres` prova a função, constraint ou transação, mas não prova autorização: o superutilizador contorna RLS. Para testar RLS, abrir outra sessão e usar o papel real (`anon`, `authenticated` ou `service_role`) e os claims lidos pelas políticas, incluindo `request.jwt.claim.sub`.

Asserções de isolamento devem demonstrar que a permissão de tabela e schema existe e que a decisão veio da política. Um simples `permission denied for table` não prova RLS. `comoUtilizador()` e `comoServiceRole()` em `crm-pg-harness.ts` são as referências atuais.

Esses testes usam exclusivamente contentores locais descartáveis e dados fictícios. Não executar contra Supabase ou PostgreSQL da empresa.
