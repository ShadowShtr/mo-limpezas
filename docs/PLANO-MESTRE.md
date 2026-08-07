# PLANO MESTRE DE REESTRUTURAÇÃO, ATOMICIDADE, LIMPEZA, INTEGRAÇÃO E EVOLUÇÃO DO SISTEMA MÓ LIMPEZAS

> **Documento oficial de execução técnica**
>
> Este documento consolida numa única estrutura toda a análise já realizada sobre o sistema Mó Limpezas, incluindo:
>
> - a reavaliação integral da atomicidade;
> - os 96 ficheiros únicos analisados nas comparações entre `master` e `fix/atomic-contract-calendar-sync`;
> - os problemas encontrados no código, banco de dados, migrations, calendário, contratos, recorrência, faturação, relatórios, Realtime, cache, segurança, documentação e testes;
> - a ordem correta de resolução;
> - a arquitetura central que todas as áreas devem seguir;
> - as regras obrigatórias para futuras atualizações;
> - as tasks completas;
> - os critérios de limpeza de 100% do projeto;
> - os códigos preparados para implementação;
> - os testes, riscos, dependências, notas iniciais, metas e condições de conclusão;
> - os itens concluídos, os itens pendentes e os pontos em standby.

## Objetivo mínimo obrigatório

Todas as áreas analisadas devem alcançar nota **7/10 ou superior**, com evidência real de testes, integração, compatibilidade e funcionamento conjunto.

## Objetivo arquitetural

Impedir que o sistema continue a receber:

- correções isoladas;
- regras duplicadas;
- migrations desconectadas;
- cálculos divergentes;
- atualizações sem transação;
- funcionalidades que funcionam de forma diferente conforme a página;
- documentos contraditórios;
- testes que dão uma confiança maior do que realmente provam;
- scripts perigosos;
- código morto ou obsoleto;
- alterações que desaparecem, voltam atrás ou ficam diferentes entre utilizadores.

---

# 1. DIRETRIZ PRINCIPAL

Todo o trabalho deve ser tratado como uma única reorganização central do sistema.

Não devem ser criadas várias soluções independentes para:

- contratos;
- calendário;
- serviços;
- recorrência;
- avenças;
- faturação;
- pagamentos;
- fluxo de caixa;
- relatórios;
- sincronização;
- cache;
- auditoria;
- migrations;
- segurança;
- autorização;
- validação;
- tratamento de erros.

Cada área deve encaixar-se numa estrutura comum, com regras únicas, responsabilidades claras e integração explícita entre código, banco, cache, Realtime e utilizadores.

A ordem obrigatória é:

1. compreender;
2. inventariar;
3. confirmar referências;
4. centralizar regras;
5. criar proteção automática;
6. remover apenas o que estiver comprovadamente sem utilização;
7. corrigir as fundações;
8. corrigir os fluxos críticos;
9. integrar banco, código, cache e Realtime;
10. testar;
11. medir;
12. publicar de forma controlada;
13. confirmar o resultado sem usar produção como ambiente de teste.

---

# 2. REGRAS INEGOCIÁVEIS

## 2.1 Não assumir

Nenhum ficheiro, função, import, variável, componente, action, migration, tabela, policy, trigger, tipo ou documento pode ser classificado como inútil sem verificação.

Antes de remover qualquer item, devem ser verificadas:

- referências estáticas;
- imports;
- exports;
- chamadas indiretas;
- carregamento dinâmico;
- convenções automáticas do Next.js;
- rotas;
- Server Actions ligadas a formulários;
- cron jobs;
- scripts externos;
- migrations;
- policies;
- triggers;
- funções PostgreSQL;
- utilização em testes;
- utilização em documentação operacional;
- dependência de produção;
- dependência do clone local;
- dependência de CI/CD.

## 2.2 Não retirar funcionalidades do ar

O sistema possui utilizadores ativos.

Portanto:

- nenhuma funcionalidade deve ser removida sem substituição validada;
- nenhuma migration deve ser aplicada diretamente sem ensaio;
- nenhuma branch ampla deve ser mesclada por conveniência;
- nenhum endpoint deve ser apagado sem confirmar que não é utilizado;
- nenhuma página deve perder comportamento sem smoke test;
- nenhuma mudança de regra financeira deve ser publicada silenciosamente;
- nenhuma regra de recorrência deve alterar datas existentes sem plano de migração;
- nenhuma alteração de Realtime deve depender apenas de testes locais;
- produção nunca deve ser usada para experimentar.

## 2.3 Remover somente o comprovadamente desnecessário

A limpeza deve localizar e classificar:

- códigos mortos;
- códigos duplicados;
- linhas inúteis;
- trechos sem efeito;
- repetições desnecessárias;
- funções sem utilização;
- imports não utilizados;
- variáveis desnecessárias;
- arquivos obsoletos;
- migrations históricas indevidamente editadas;
- documentos contraditórios;
- scripts perigosos;
- dados operacionais dentro do repositório;
- helpers locais que repetem uma regra central;
- actions que repetem autenticação;
- cálculos financeiros copiados;
- chamadas de revalidação dispersas;
- consultas que ignoram erros;
- fallbacks que escondem inconsistências;
- tipos divergentes do schema;
- testes que apenas procuram strings e dão uma confiança maior do que deveriam.

## 2.4 Priorizar soluções gratuitas

A prioridade deve ser:

- TypeScript;
- ESLint;
- Vitest;
- PostgreSQL;
- Supabase;
- GitHub Actions;
- scripts Node.js;
- ferramentas já instaladas;
- recursos nativos do Next.js;
- recursos nativos do banco;
- recursos nativos do Supabase Realtime.

## 2.5 Não duplicar soluções

Antes de criar uma nova implementação, verificar:

- se existe helper;
- se existe migration;
- se existe RPC;
- se existe serviço;
- se existe regra no domínio;
- se existe action;
- se existe hook;
- se existe policy;
- se existe teste;
- se existe solução na branch de atomicidade;
- se existe correção mais recente no `master`.

Quando existir, a solução deve ser reutilizada, corrigida, centralizada e reconciliada.

---

# 3. ESTADO DA REVISÃO REALIZADA

## 3.1 Reavaliação integral da atomicidade

A análise foi refeita sem reutilizar automaticamente as conclusões anteriores.

Foram revistos todos os ficheiros devolvidos pelas comparações nos dois sentidos:

- `master → fix/atomic-contract-calendar-sync`: **84 ficheiros**;
- `fix/atomic-contract-calendar-sync → master`: **15 ficheiros**;
- três ficheiros apareciam nos dois sentidos;
- total consolidado: **96 ficheiros únicos**.

Foram incluídos:

- documentos históricos;
- JSONs de inventário com milhares de linhas;
- snapshots de schema;
- SQL congelado;
- migrations;
- scripts de ensaio;
- scripts de rollback;
- scripts de diagnóstico;
- testes;
- Server Actions;
- componentes;
- tipos;
- ficheiros removidos;
- ficheiros perigosos;
- proteções posteriores existentes apenas no `master`.

No `package-lock.json`, por ser um ficheiro gerado, foram verificadas as linhas efetivamente alteradas e a mudança correspondente da dependência `pg`.

## 3.2 Limite da afirmação

A revisão dos 96 ficheiros não equivale a afirmar que todos os ficheiros inalterados de todo o repositório foram novamente lidos linha a linha.

A certificação de “100% do projeto” só pode ser concluída depois de:

- inventário integral da árvore;
- checkout local;
- execução do TypeScript;
- execução do ESLint;
- execução dos testes;
- execução do build;
- grafo de imports;
- deteção de módulos inalcançáveis;
- pesquisa de referências;
- inspeção de imports dinâmicos;
- validação das rotas Next.js;
- validação das migrations;
- comparação com o schema real;
- confirmação do ledger;
- teste numa base descartável.

Até essa etapa, o documento diferencia:

- **comprovado**;
- **provável**;
- **candidato a remoção**;
- **standby**;
- **dependente de validação**.

# 4. VEREDITO CORRIGIDO SOBRE A ATOMICIDADE

A conclusão correta é:

> Existe uma implementação de atomicidade real, tecnicamente avançada e parcialmente pronta, mas ela ainda não forma uma solução transacional completa para toda a aplicação e não está num estado que possa ser publicada diretamente.

## 4.1 Estados que não podem ser misturados

| Estado | O que existe |
|---|---|
| Implementado e atual no `master` | Runner seguro, proteções de produção, isolamento de `company_id` e `role` |
| Implementado na branch | Motor de recorrência, actions consumidoras de RPCs, ensaios 066/067, diagnósticos |
| Congelado como referência | RPCs avançadas de clientes e faturas do checkpoint 065 |
| Ainda inexistente | Transação completa de contrato + local + ocorrências + calendário |
| Ainda não demonstrado | Concorrência real entre ligações e Realtime com recuperação de eventos |
| Parcialmente implementado | Outbox, revisões, idempotência e locks |
| Não reproduzível de ponta a ponta | Código da branch dependente de objetos congelados ou não instalados |
| Bloqueado para merge direto | Branch ampla divergente do `master` atual |

A atomicidade não precisa ser criada do zero.

Mas também não está totalmente pronta.

---

# 5. O QUE ESTÁ REALMENTE PRONTO

## 5.1 Alteração de estado da fatura e fluxo de caixa

O checkpoint congelado 065 contém uma RPC robusta para a alteração do estado da fatura.

Ela possui:

- bloqueio transacional da fatura;
- `expected_revision` obrigatório;
- autorização verificada novamente dentro da função;
- `mutation_id`;
- hash da requisição;
- recibo idempotente;
- atualização da fatura;
- criação ou remoção do lançamento de caixa;
- auditoria;
- outbox;
- snapshot da fatura no retorno.

Tudo é executado na mesma transação PostgreSQL.

O desenho é tecnicamente sólido nesse domínio.

O problema não é a qualidade da função. O problema é que a versão mais completa está num checkpoint congelado, e não numa migration ativa reproduzível.

## 5.2 Arquivamento e eliminação segura de clientes

O checkpoint 065 também contém:

- `archive_client_atomic`;
- `delete_empty_client_atomic`;
- recusa estruturada para eliminar cliente com histórico;
- bloqueio de cliente;
- bloqueio de locais;
- bloqueio de contratos;
- bloqueio de serviços;
- bloqueio de faturas;
- revisão esperada;
- auditoria dentro da transação;
- evento dentro da transação;
- eliminação apenas quando não há histórico relevante.

A eliminação destrutiva antiga foi desativada de propósito.

Essa decisão deve ser preservada.

## 5.3 Fundação do outbox

A migration 067 implementa:

- sequência transacional por empresa;
- `SELECT ... FOR UPDATE` em `company_sync_state`;
- bloqueio consultivo por empresa e `mutation_id`;
- idempotência por operação e hash;
- conflito quando o mesmo `mutation_id` é reutilizado com outro conteúdo;
- eventos imutáveis;
- ordenação por empresa;
- publicação da tabela de eventos no Supabase Realtime;
- remoção de permissões de escrita pelo browser.

Como fundação, o desenho é bom.

Como sistema completo, ainda falta ligar essa fundação às mutações reais.

## 5.4 Segurança de produção no `master`

O `master` contém proteções posteriores que não devem ser perdidas:

- execução sem argumentos é dry-run;
- dry-run usa somente consultas de leitura;
- escrita exige `--apply`;
- escrita exige confirmação exata do projeto;
- host e utilizador da ligação são analisados;
- cada migration é executada numa transação;
- divergência de checksum bloqueia a execução;
- falhas de leitura não são tratadas como base vazia;
- erros falham fechado;
- o runner principal ficou mais seguro que o existente na branch ampla.

Essas proteções devem prevalecer em qualquer integração.

---

# 6. PRINCIPAL BLOQUEADOR: RPCS AVANÇADAS CONGELADAS

As RPCs mais avançadas de clientes e faturas encontram-se em:

```text
docs/atomicidade-audit/frozen/065_fix_domain_atomicity_outbox.sql
```

A política da branch afirma que o ficheiro:

- é um checkpoint;
- está congelado;
- é protegido por hash;
- não deve ser aplicado como migration.

Ao mesmo tempo, as actions da branch chamam capacidades e assinaturas provenientes desse checkpoint.

Isso cria um estado inconsistente:

1. o código chama RPCs avançadas;
2. as RPCs avançadas estão num ficheiro não aplicável;
3. a base pode conter versões anteriores ou parciais;
4. os SQL 064/065 estreitos do `master` não instalam todo o checkpoint;
5. um clone novo não consegue reconstruir o schema exigido pelo código;
6. os tipos podem representar outra versão;
7. testes estáticos podem passar sem que o objeto exista no banco;
8. a branch não pode ser tratada como unidade pronta.

## Correção correta

Não aplicar o checkpoint congelado.

Criar uma migration nova, aditiva, posterior ao estado real do banco, contendo somente:

- as funções reconciliadas;
- as assinaturas confirmadas;
- as permissões corretas;
- os índices necessários;
- os triggers necessários;
- a compatibilidade com 068/069;
- os tipos atualizados;
- os testes reais.

---

# 7. CONTRATOS E CALENDÁRIO CONTINUAM SEM ATOMICIDADE COMPLETA

## 7.1 Criação de contrato

A criação atual executa etapas separadas:

1. atualiza o local;
2. insere o contrato;
3. calcula ocorrências;
4. insere serviços um a um;
5. tenta compensar apagando o contrato caso a geração falhe.

### Problemas

- falha ao atualizar o local pode ser ignorada;
- a atualização do local não é revertida;
- a compensação também pode falhar;
- serviços podem ser inseridos parcialmente;
- não existe `expected_revision`;
- não existe `mutation_id` persistido pela interface;
- não existe bloqueio do local;
- não existe bloqueio do contrato;
- não existe uma única transação;
- geração de referências continua fora do banco;
- concorrência pode criar ocorrências duplicadas;
- o utilizador pode receber erro mesmo com parte dos dados gravada.

## 7.2 Atualização de contrato

A atualização:

1. atualiza o local;
2. atualiza o contrato;
3. remove ocorrências incompatíveis;
4. atualiza ocorrências futuras;
5. gera as que faltam;
6. confirma campos;
7. grava auditoria.

Se a reconciliação falhar:

- o contrato pode já estar alterado;
- o local pode já estar alterado;
- alguns serviços podem já ter sido apagados;
- outros serviços podem já ter sido atualizados;
- alguns serviços podem não ter sido gerados;
- a action pode devolver erro sem conseguir explicar o estado final.

A mensagem que afirma que “nada foi considerado gravado” é perigosa quando o `UPDATE` já ocorreu.

## 7.3 Pausa e cancelamento

A action atualiza o estado do contrato e depois remove serviços futuros.

Isso permite:

- contrato pausado com serviços ativos;
- contrato cancelado com cards ainda visíveis;
- falha silenciosa transformada em contagem zero;
- auditoria que não representa exatamente o que aconteceu.

## 7.4 Reativação

A reativação pode deixar o contrato ativo sem recriar imediatamente as ocorrências.

A regeneração depende de:

- nova edição;
- cron futuro;
- ação manual.

Esse comportamento causa diferença entre:

- ficha do contrato;
- calendário;
- relatórios;
- cobrança;
- expectativa do utilizador.

## 7.5 Identidade lógica da ocorrência

Não existe, nos snapshots analisados, uma chave autoritativa equivalente a:

- `occurrence_key`;
- `logical_date`;
- `occurrence_date`;
- `schedule_slot`;
- índice único por contrato e ciclo.

A constraint de `reference_number` impede números repetidos, mas não impede a mesma ocorrência lógica com números diferentes.

## Conclusão

Contrato e calendário precisam de uma única RPC transacional que faça:

- validação do ator;
- validação da empresa;
- `mutation_id`;
- hash;
- `expected_revision`;
- bloqueio do local;
- bloqueio do contrato;
- gravação;
- preservação de exceções;
- reconciliação;
- geração;
- contador;
- auditoria;
- outbox;
- snapshot autoritativo.

---

# 8. IDEMPOTÊNCIA EXISTE, MAS NÃO ESTÁ LIGADA CORRETAMENTE À INTERFACE

## 8.1 `mutation_id` novo em cada pedido

Quando o servidor gera um novo UUID em cada chamada:

- primeiro clique: mutação A;
- retry: mutação B;
- clique repetido: mutação C.

A base não reconhece B e C como repetição de A.

## Regra obrigatória

O `mutation_id` deve:

1. nascer na interface;
2. ser armazenado durante a operação;
3. ser reutilizado em retries;
4. ser descartado somente após resultado autoritativo;
5. ser regenerado numa nova intenção real do utilizador.

## 8.2 Revisão obtida imediatamente antes da gravação

Buscar a revisão atual no servidor imediatamente antes de chamar a RPC não protege contra interface desatualizada.

A revisão correta é a revisão do snapshot apresentado ao utilizador.

## 8.3 Auditoria duplicada

Quando a RPC grava auditoria dentro da transação e a action grava novamente fora da transação, podem ocorrer:

- dois eventos;
- nomes diferentes;
- falha da segunda auditoria;
- operação concluída com action retornando erro;
- dificuldade de reconstrução;
- relatórios duplicados;
- confusão entre evento de domínio e telemetria.

A auditoria da mutação deve permanecer na RPC.

# 9. FATURAÇÃO AINDA POSSUI OPERAÇÕES NÃO ATÓMICAS

## 9.1 Geração mensal

Problemas:

- retorno antecipado antes de processar avenças;
- contrato mensal sem serviço concluído pode não gerar fatura;
- numeração baseada em contagem;
- cabeçalho e itens inseridos separadamente;
- erros de itens ignorados;
- possibilidade de fatura vazia;
- possibilidade de fatura parcial;
- erros por cliente podem ser engolidos;
- lote pode terminar como sucesso parcial;
- duas execuções concorrentes podem gerar documentos duplicados;
- encontrar uma fatura pode fazer saltar o cliente inteiro;
- falta regra explícita de proporcionalidade.

## 9.2 Alteração de estado no `master`

No `master`, a atualização da fatura e o lançamento de caixa ainda podem acontecer em operações separadas.

## Avaliação

| Operação | Estado |
|---|---|
| Alterar estado + caixa no checkpoint 065 | Desenho robusto |
| Compatibilidade com produção | Não comprovada |
| Gerar cabeçalho + itens | Não atómico |
| Gerar número | Sujeito a corrida |
| Gerar lote | Não atómico |
| Retry | Interface não preserva ID |
| Avença sem visita concluída | Pode não faturar |
| Fatura vazia/parcial | Possível |

---

# 10. MOTOR DE RECORRÊNCIA

## 10.1 Correção positiva

A branch corrige o problema do `master` que calculava apenas o mês de `rangeStart`.

## 10.2 Problema dos dias 29, 30 e 31

Construir:

```ts
new Date(ano, mes, dayOfMonth)
```

faz o JavaScript normalizar datas inexistentes.

Exemplos:

- 31 de fevereiro passa para março;
- 31 de abril passa para maio.

Consequências:

- mês sem ocorrência;
- ocorrência deslocada para outro mês;
- duas ocorrências no mesmo mês;
- exclusões aplicadas à data errada;
- relatórios mensais divergentes;
- cobrança alocada ao mês errado.

## Correção

Usar:

```text
min(dia original, último dia do mês)
```

antes de aplicar deslocamento de fim de semana.

## 10.3 Limite de vinte anos

O gerador personalizado começa no início do contrato e percorre passo a passo.

Contratos muito antigos podem atingir o limite antes de chegar à janela.

## Correção

Calcular matematicamente o primeiro passo relevante.

---

# 11. MIGRATION 067 E TIPOS TYPESCRIPT DIVERGENTES

A migration 067 remove:

- `affected_range`;
- `delivered_at`.

Adiciona:

- `affected_from`;
- `affected_to`.

O tipo `src/types/database.ts` da branch ainda representa a estrutura antiga.

Isso significa:

- TypeScript incorreto;
- queries capazes de selecionar colunas inexistentes;
- diagnóstico enganoso;
- aplicação compilada contra um contrato de dados errado.

## Regra

Migration, tipos e código consumidor devem fazer parte da mesma entrega.

---

# 12. DIAGNÓSTICO DE SAÚDE DEMASIADO OTIMISTA

Problemas:

- baseline declarado como 063;
- migrations 064–067 tratadas como ativas;
- comparação parcial de nomes;
- checksums não totalmente validados;
- existência de tabela tratada como funcionamento;
- outbox pode existir sem consumidor;
- Realtime pode estar publicado sem recuperação de lacunas;
- sistema pode aparecer saudável com sincronização inativa.

## Correção

O health check deve distinguir:

- schema presente;
- migration registada;
- checksum correto;
- função presente;
- permissão correta;
- trigger presente;
- publicação Realtime;
- consumidor ativo;
- última sequência processada;
- existência de lacunas;
- compatibilidade dos tipos;
- compatibilidade do código.

---

# 13. ISOLAMENTO MULTIEMPRESA AINDA INCOMPLETO

As migrations 068/069 corrigem:

- confiança em `raw_user_meta_data`;
- alteração de `company_id`;
- alteração de `role`.

Mas ainda podem ficar expostos campos como:

- `vacation_balance`;
- `hourly_rate`;
- `status`;
- `contracted_hours_month`;
- datas contratuais;
- outros campos de gestão.

Uma colaboradora não deve conseguir alterar diretamente os próprios dados laborais através da API.

## Prioridade

Crítica.

---

# 14. FICHEIROS PERIGOSOS

## 14.1 `supabase/APPLY_ALL.sql`

Pode:

- eliminar tabelas;
- eliminar views;
- eliminar funções;
- eliminar sequências;
- recriar schema antigo;
- recriar função vulnerável;
- recriar policies antigas;
- inserir seed;
- destruir produção.

## 14.2 `scripts/build-combined-sql.mjs`

Reconstrói o `APPLY_ALL.sql`.

## 14.3 `CRIAR_PAGAMENTOS.sql`

Contém:

- UUIDs fixos;
- valores operacionais;
- lançamentos financeiros;
- descrições;
- policy ampla.

## 14.4 Endpoint de seed

Usa service role para criar:

- Auth users;
- perfis;
- equipas;
- clientes;
- locais;
- contratos;
- serviços;
- faturas;
- caixa;
- salários;
- faltas;
- tarefas;
- viaturas.

Pode causar danos em preview, staging ou ambiente mal configurado.

## 14.5 `seed.sql`

Usa identificadores fixos e dados ligados à empresa.

Deve ser transformado em fixture explicitamente descartável.

---

# 15. DOCUMENTAÇÃO E TESTES NÃO PODEM SER A ÚNICA FONTE DE VERDADE

## 15.1 Documentação contraditória

Foram encontrados documentos que:

- no início afirmam migration pendente;
- mais abaixo afirmam migration aplicada;
- mantêm PR aberta depois de fechada;
- mantêm instrução antiga depois de proibida;
- misturam stack antiga e atual;
- misturam histórico e execução.

## 15.2 Testes estáticos

Testes que procuram:

- `FOR UPDATE`;
- `REVOKE`;
- nome da função;
- texto de comentário;
- palavra “histórico”;

não provam:

- compilação do SQL;
- existência no banco;
- concorrência;
- compatibilidade;
- entrega Realtime;
- recuperação de lacunas;
- isolamento real.

## Regra

Testes estáticos continuam úteis, mas devem ser complementados por:

- testes de integração;
- testes de concorrência;
- testes de migrations;
- testes de RLS;
- testes de Realtime;
- testes de recuperação;
- testes de schema.

---

# 16. CORREÇÕES POSITIVAS QUE DEVEM SER PRESERVADAS

| Alteração | Decisão |
|---|---|
| Motor canónico de recorrência | Preservar e corrigir |
| Propagação de erros em contratos | Preservar |
| Preservação de `is_exception` | Preservar |
| RPCs seguras de clientes | Recriar em migration nova |
| RPC de estado da fatura | Reconciliar e recriar |
| Fundação 067 | Extrair e testar |
| Remoção de `APPLY_ALL` | Integrar |
| Remoção do seed-demo | Integrar |
| Remoção de SQL financeiro solto | Integrar |
| Diagnóstico de commit/deploy | Adaptar |
| Revisão obrigatória | Preservar |
| Bloqueio da eliminação destrutiva | Preservar |
| Runner seguro do `master` | Preservar integralmente |
| Guardas 068/069 | Preservar integralmente |

---

# 17. ARQUITETURA CENTRAL OBRIGATÓRIA

```text
Interface
  ↓
Server Action fina
  ↓
Autenticação central
  ↓
Validação
  ↓
Caso de uso
  ↓
Regra de domínio
  ↓
RPC transacional ou repositório de leitura
  ↓
Auditoria + Outbox
  ↓
Snapshot autoritativo
  ↓
Revalidação de cache
  ↓
Realtime
  ↓
Outros utilizadores
```

## Estrutura recomendada

```text
src/
├── app/
│   ├── actions/
│   └── ...
├── domain/
│   ├── scheduling/
│   ├── billing/
│   ├── contracts/
│   ├── finance/
│   └── shared/
├── application/
│   ├── contracts/
│   ├── billing/
│   ├── clients/
│   └── finance/
├── infrastructure/
│   └── supabase/
├── lib/
│   ├── action-result.ts
│   ├── auth-guard.ts
│   ├── critical-fields.ts
│   ├── lisbon-time.ts
│   └── revalidate-business.ts
└── types/
```

## Regra de migração incremental

Não mover tudo de uma vez.

1. novas regras entram na estrutura central;
2. regras antigas são migradas quando a área for alterada;
3. wrappers preservam compatibilidade;
4. wrappers são removidos após zero referências;
5. nenhuma rota muda sem necessidade;
6. nenhuma action muda de assinatura sem adaptação da interface.

---

# 18. REGRAS OBRIGATÓRIAS DE DESENVOLVIMENTO

## 18.1 Uma regra, um módulo

- recorrência: `src/domain/scheduling/recurrence-engine.ts`;
- valor de serviço: `src/lib/service-value.ts`;
- distribuição da avença: `src/domain/billing/monthly-allocation.ts`;
- datas de Lisboa: `src/lib/lisbon-time.ts`;
- autenticação: `src/lib/auth-guard.ts`;
- revalidação: `src/lib/revalidate-business.ts`;
- resultados de actions: `src/lib/action-result.ts`.

## 18.2 Actions finas

Actions podem:

- autenticar;
- validar;
- chamar caso de uso;
- chamar RPC;
- revalidar;
- devolver snapshot.

Actions não podem:

- implementar recorrência;
- gerar números por contagem;
- duplicar cálculos;
- fazer compensação manual;
- ignorar erro;
- misturar leitura, escrita, auditoria e UI sem separação.

## 18.3 Escritas múltiplas exigem transação

Obrigatório para:

- contrato + local + serviços;
- serviço + caixa;
- fatura + itens;
- fatura + caixa;
- pausa + remoção;
- cliente + dependências.

## 18.4 Concorrência

Entidades editáveis devem utilizar:

```ts
mutationId: string;
expectedRevision: number;
```

## 18.5 Falha não é lista vazia

É proibido ignorar `error`.

## 18.6 Datas

Datas de negócio devem usar `Europe/Lisbon`.

## 18.7 Remoção

Nenhum código é removido sem prova.

## 18.8 Definition of Done

```text
git diff --check
npx tsc --noEmit
npm run lint
npm test
npm run build
```

Quando houver banco:

```text
migration review
rollback rehearsal
duas ligações
isolamento
backup
plano de rollback
```

---

# 19. NOTAS ATUAIS E METAS

| Área | Nota atual | Meta mínima | Meta prevista |
|---|---:|---:|---:|
| Segurança de produção | 9 | 7 | 9 |
| Runner de migrations | 9 | 7 | 9 |
| Isolamento multiempresa | 7 | 7 | 9 |
| Proteção laboral | 4 | 7 | 9 |
| Organização | 5 | 7 | 8 |
| Limpeza | 4 | 7 | 8 |
| Contratos | 3 | 7 | 8 |
| Calendário | 5 | 7 | 8 |
| Recorrência no `master` | 4 | 7 | 9 |
| Recorrência na branch | 7 | 7 | 9 |
| Geração de serviços | 4 | 7 | 8 |
| Cobrança diária | 5 | 7 | 8 |
| Faturas | 4 | 7 | 8 |
| Relatórios | 4 | 7 | 8 |
| Dashboard financeiro | 4 | 7 | 8 |
| Realtime | 3 | 7 | 8 |
| Cache | 6 | 7 | 8 |
| Unit tests | 6 | 7 | 8 |
| Integration tests | 3 | 7 | 8 |
| Observabilidade | 5 | 7 | 8 |
| Documentação | 3 | 7 | 8 |
| Reprodutibilidade código–schema | 3 | 7 | 8 |
| Segurança operacional do repositório | 5 | 7 | 8 |
| Atomicidade integrada | 4 | 7 | 8 |
| Outbox ligado ao negócio | 2 | 7 | 8 |

Notas finais só podem ser atribuídas após validação.

# 20. ORDEM CENTRAL DE IMPLEMENTAÇÃO

```text
FASE 0 — Inventário, proteção e limpeza segura
T00 → T01 → T02 → T03

FASE 1 — Segurança e fundações
T04 → T05 → T06

FASE 2 — Recorrência, contratos e calendário
T07 → T08 → T09 → T10

FASE 3 — Valores, pagamentos e faturas
T11 → T12 → T13

FASE 4 — Relatórios, Realtime e cache
T14 → T15 → T16

FASE 5 — Limpeza integral, testes e publicação
T17 → T18 → T19
```

A execução não deve saltar etapas. Uma task pode ser dividida em subtasks, mas não pode deixar dependências ocultas para uma task posterior.

---

## 20.1 ESTADO DA EXECUÇÃO — atualizado em 2026-08-07

> Esta secção regista **onde a execução está**. Não reescreve a história nem
> substitui as descrições das tasks abaixo — cada task mantém o texto original.
> Retoma completa da sessão: `docs/HANDOFF-2026-08-07.md`.

### Gate transversal de integridade de dados

> 🚨 **Ocorreu uma regressão financeira em produção**: pagamentos VARIÁVEIS
> deixaram de aparecer e as datas dos FIXOS ficaram iguais. A causa **não está
> determinada** (perda / sobrescrita / clonagem / query / UI).
>
> **Enquanto não existir diagnóstico read-only da base, nenhuma task pode
> reparar dados.** Proibido `UPDATE`, `DELETE`, `INSERT`, `UPSERT`, `TRUNCATE`,
> migration, backfill, `ensureMonth`, alteração de `due_date`/`source_id`,
> recriação de pagamentos ou qualquer write no Supabase real.
>
> Este gate aplica-se a **todas** as tasks, não só às financeiras. Qualquer
> alteração que toque em dados começa por capturar baseline e provar
> **BEFORE = AFTER** para tudo o que não faça parte explícita da alteração
> autorizada. Uma invariante inesperada a mudar → **ABORT / ROLLBACK**.

### Três estados distintos

Nenhuma task desta pilha está em produção. `master` continua em `e479367`.

| Estado | Significado |
|---|---|
| **Offline** | módulo puro, testado, **não ligado** a ecrã, cron ou schema |
| **Integração runtime** | ligado à aplicação, a correr |
| **Produção** | aplicado e validado ao vivo |

### Situação por task

| Task | Estado | PR | Bloqueio |
|---|---|---|---|
| T00–T06 | mescladas em `master` | #35–#45 | — |
| **T07** | **offline concluída** | #46 draft | 🔴 **snapshot real pendente** — sem o comparador executado, **não mergear** (quinzenal/3-em-3 podem mudar de paridade; 24/49 combinações teóricas) |
| **T08** | **offline concluída** | #47 draft | schema + runtime pendentes — SQL congelado em `supabase/frozen/`, **não aplicado** |
| **T09** | **offline concluída** | #47 draft | integração pendente — SQL atómico congelado, **não aplicado** |
| **T10** | **offline concluída** | #47 draft | integração realtime pendente — reconciliador não ligado aos 10 handlers |
| **T11** | **offline concluída** | **#50 draft** | integração pendente — nenhum consumidor ligado ao modelo canónico |
| **T12** | **não iniciada** | — | 🔴 **bloqueada** pelo diagnóstico financeiro (toca `services` + `cash_flow_entries` de forma transacional) |
| T13–T19 | não iniciadas | — | dependem das anteriores |

### Frente reservada — FINANCEIRO V2

Não faz parte da numeração T00–T19. Reservada, **não iniciada**. Aguarda:

- **A)** imagem da nova interface do Financeiro;
- **B)** diagnóstico read-only dos pagamentos.

Junta: proteção de dados · correção fixos × variáveis · identidade e idempotência
de pagamento recorrente · constraint anti-duplicados · preservação de `due_date`
· `source_id` seguro · nova UI · read model da T11 · queries autoritativas ·
realtime/invalidação · BEFORE × AFTER · rollback · testes.

> A nova UI **não calcula dinheiro**: consome o modelo canónico da T11.

### Pendências operacionais transversais

- **Incidente de credenciais aberto** — rotação por concluir; nenhuma credencial
  deve ser usada até haver evidência operacional do proprietário.
- **Migration 070 NÃO aplicada.**
- **Base descartável por criar** — pré-requisito para validar T07–T10 em runtime.
- **`npm audit`: 16 vulnerabilidades** (11 high). `next` é dependência direta e a
  correção exige major. **Não executar `npm audit fix --force`** — frente
  separada, não misturar com o modelo financeiro.

---

# 21. TASK T00 — INVENTÁRIO INTEGRAL DO REPOSITÓRIO

## Problema

Não existe prova automatizada de que todos os ficheiros, exports, funções e dependências foram analisados.

## Causa identificada

- lint permissivo;
- falta de grafo de imports;
- falta de relatório de módulos inalcançáveis;
- ausência de processo único de limpeza;
- falta de classificação formal de ficheiros;
- falta de baseline de warnings;
- impossibilidade de comprovar utilização apenas pela leitura de nomes.

## Arquivos envolvidos

- `package.json`;
- `eslint.config.mjs`;
- `tsconfig.json`;
- novo `scripts/audit-codebase.mjs`;
- novo `reports/code-audit.json`;
- novo `docs/code-audit/README.md`;
- todos os ficheiros TypeScript, JavaScript, SQL, JSON, Markdown e configuração.

## Funções, componentes, serviços ou tabelas envolvidos

- TypeScript Compiler API;
- ESLint;
- convenções de rotas Next.js;
- importação dinâmica;
- scripts Node.js;
- estrutura de migrations;
- configuração de CI.

## O que precisa ser corrigido

Criar uma fonte objetiva que mostre:

- quantos ficheiros existem;
- quantas linhas existem;
- quais são entradas de produção;
- quais são módulos alcançáveis;
- quais são módulos usados apenas em testes;
- quais são candidatos a código morto;
- quais são duplicações;
- quais são riscos de segurança;
- quais são padrões de data incorretos;
- quais consultas ignoram erros;
- quais actions fazem revalidação fora do helper central.

## Solução aplicada

Criar um auditor sem dependências pagas e sem dependências novas, usando o compilador TypeScript já instalado.

## O que será implementado

- varredura recursiva;
- leitura de AST;
- grafo de imports;
- deteção de duplicações exatas;
- deteção de funções idênticas;
- deteção de ficheiros inalcançáveis;
- deteção de `createAdminClient` em client component;
- deteção de `auth.signUp`;
- deteção de datas por `toISOString().slice`;
- deteção de `revalidatePath` disperso;
- deteção de artefactos perigosos;
- relatório JSON.

## O que precisa ser reorganizado

O inventário deverá criar uma matriz com os estados:

- manter;
- centralizar;
- substituir;
- remover;
- arquivar;
- standby.

## O que será removido

Nada durante o inventário.

## O que será mantido

Todos os candidatos até verificação manual e execução dos testes.

## O que ficou em standby

- remoção efetiva;
- análise de dependências npm;
- análise de imports dinâmicos externos;
- confirmação de scripts usados fora do repositório.

## O que ainda precisa ser feito

- executar o auditor no checkout;
- rever os resultados;
- criar tickets por candidato;
- comparar com build e rotas.

## Riscos

- falsos positivos;
- módulos carregados por convenção;
- imports construídos dinamicamente;
- ficheiros usados por scripts externos.

## Validação

- `npm run audit:code`;
- `npm run typecheck`;
- `npm run lint`;
- `npm test`;
- `npm run build`;
- revisão manual de cada candidato.

## Resultado esperado

Inventário de 100% da árvore com classificação rastreável.

## Resultado alcançado

Estrutura e código do auditor preparados; execução depende do checkout.

## Nota da área

- inicial: 4;
- meta: 8;
- nota final: pendente de execução.

---

# 22. TASK T01 — PADRÃO CENTRAL DE ENGENHARIA

## Problema

Atualizações futuras podem continuar a criar soluções isoladas, duplicadas ou incompatíveis.

## Causa identificada

- documentação acumulativa;
- ausência de padrão arquitetural único;
- mistura de histórico e instrução;
- PRs sem campos obrigatórios;
- regras de produção separadas das regras de desenvolvimento.

## Arquivos envolvidos

- `docs/ENGINEERING-STANDARD.md`;
- `docs/ARCHITECTURE.md`;
- `.github/pull_request_template.md`;
- `AGENTS.md`;
- `CLAUDE.md`;
- `docs/README.md`;
- documentos históricos.

## O que precisa ser corrigido

Criar uma hierarquia documental clara:

1. segurança de produção;
2. arquitetura atual;
3. padrão de engenharia;
4. estado atual;
5. histórico;
6. handoff.

## Solução aplicada

Criar documentos canónicos e transformar os históricos em arquivos de consulta.

## O que será implementado

- padrão de engenharia;
- arquitetura;
- template de PR;
- Definition of Done;
- critérios de limpeza;
- critérios de migration;
- critérios de concorrência;
- critérios de Realtime;
- critérios de rollback.

## O que precisa ser reorganizado

- `CLAUDE.md` deve deixar de ser um arquivo cumulativo de tudo;
- handoffs antigos devem ir para arquivo;
- `ESTADO-ATUAL.md` deve conter somente estado atual;
- incidentes devem ficar em histórico;
- regras ativas não devem aparecer em múltiplos locais.

## O que será removido

Somente instruções duplicadas depois da migração para o documento canónico.

## O que será mantido

Histórico de incidentes, decisões e migrações.

## Standby

Consolidação integral de todos os documentos depende do inventário completo.

## Riscos

- perder contexto;
- apagar uma decisão ainda válida;
- alterar instrução operacional sem revisão.

## Validação

- links internos;
- revisão manual;
- teste que procure comandos proibidos;
- teste que confirme o documento canónico;
- comparação com `master`.

## Resultado esperado

Qualquer pessoa que trabalhe no sistema saberá onde colocar cada tipo de código e como validar a alteração.

## Resultado alcançado

Conteúdo inicial do padrão e template preparados.

## Nota

3 → meta 8.

---

# 23. TASK T02 — GUARDAS DE QUALIDADE E BASELINE DE LIMPEZA

## Problema

Código morto, imports não usados e warnings podem continuar no repositório.

## Causa

A regra `@typescript-eslint/no-unused-vars` está configurada como warning.

## Arquivos

- `eslint.config.mjs`;
- `package.json`;
- `tsconfig.json`;
- CI;
- auditor.

## O que corrigir

Transformar a qualidade num gate sem quebrar o projeto de forma desorganizada.

## Ordem correta

1. executar lint atual;
2. guardar baseline;
3. corrigir warnings reais;
4. avaliar exceções;
5. elevar warning para error;
6. ativar `--max-warnings=0`;
7. avaliar `noUnusedLocals`;
8. avaliar `noUnusedParameters`;
9. integrar no CI.

## O que implementar

- `lint:strict`;
- `typecheck`;
- `quality`;
- relatório de warnings;
- teste de arquitetura.

## O que reorganizar

- remover `eslint-disable` desnecessários;
- trocar `any` por tipos;
- prefixar parâmetros intencionalmente não usados com `_`;
- evitar supressões globais.

## O que remover

Somente depois do baseline:

- imports não usados;
- variáveis não usadas;
- disables sem motivo;
- parâmetros mortos;
- helpers privados não referenciados.

## Standby

Ativar modo estrito antes de conhecer o baseline.

## Riscos

- bloquear CI;
- remover parâmetro exigido por interface;
- gerar refatoração não relacionada.

## Validação

- lint zero warnings;
- typecheck;
- build;
- testes;
- diff específico.

## Nota

4 → meta 8.

---

# 24. TASK T03 — REMOVER ARTEFACTOS PERIGOSOS

## Problema

Existem ficheiros que podem destruir, recriar ou popular uma base real.

## Causa

Ferramentas antigas de bootstrap permaneceram no repositório depois da evolução do sistema.

## Arquivos envolvidos

- `supabase/APPLY_ALL.sql`;
- `scripts/build-combined-sql.mjs`;
- `CRIAR_PAGAMENTOS.sql`;
- `src/app/api/seed-demo/route.ts`;
- componente do botão de seed;
- página que renderiza o botão;
- `supabase/seed.sql`;
- testes.

## O que corrigir

Eliminar caminhos acidentais para:

- `DROP ... CASCADE`;
- seed com service role;
- dados financeiros fixos;
- criação massiva em base partilhada.

## Solução

- remover builder destrutivo;
- remover SQL operacional;
- remover endpoint;
- remover botão;
- transformar seed em fixture;
- exigir base vazia;
- usar runner seguro;
- adicionar teste preventivo.

## O que implementar

Teste que falhe se os ficheiros perigosos reaparecerem.

## O que reorganizar

Fixtures de desenvolvimento devem ficar em diretório explícito e documentado.

## O que remover

Após busca de referências:

- `APPLY_ALL.sql`;
- builder;
- `CRIAR_PAGAMENTOS.sql`;
- endpoint;
- botão.

## O que manter

Capacidade de criar ambiente local descartável.

## Standby

Seed novo, caso seja necessário.

## Riscos

- fluxo local antigo deixar de funcionar;
- documentação apontar para script removido.

## Validação

- pesquisa de referências;
- base descartável;
- runner dry-run;
- build;
- smoke da configuração.

## Nota

5 → meta 8.

# 25. TASK T04 — PROTEGER CAMPOS LABORAIS E ADMINISTRATIVOS DE `profiles`

## Problema

As proteções atuais impedem alteração de `company_id` e `role`, mas outros campos administrativos podem permanecer alteráveis pela própria pessoa autenticada.

## Causa identificada

A migration 069 foi deliberadamente limitada a dois campos críticos e deixou os restantes como pendência.

## Arquivos envolvidos

- nova migration posterior à 069;
- `src/lib/auth-guard.ts`;
- `src/app/actions/colaboradores.ts`;
- `src/app/actions/csv-import.ts`;
- testes de isolamento;
- tipos gerados.

## Campos envolvidos

- `contracted_hours_month`;
- `hourly_rate`;
- `contract_start`;
- `contract_end`;
- `vacation_balance`;
- `status`;
- outros campos de gestão confirmados pelo schema real.

## O que precisa ser corrigido

Uma colaboradora autenticada não pode atualizar diretamente os próprios campos laborais através da API do Supabase.

## Solução

Criar trigger de proteção que permita mudança somente quando:

- `auth.role() = 'service_role'`; ou
- o ator é `admin`/`gestor`;
- o ator pertence à mesma empresa;
- `company_id` permanece inalterado.

## O que será implementado

- função trigger;
- trigger `BEFORE UPDATE`;
- erro com código estável;
- revogação de execute;
- testes estáticos;
- testes reais de RLS e trigger.

## O que precisa ser reorganizado

Todas as alterações de campos laborais devem passar por actions server-side autorizadas.

## O que será removido

Nenhuma coluna ou funcionalidade.

## O que será mantido

Edição pessoal dos campos não administrativos permitidos pela regra atual.

## Standby

Aplicação da migration.

## O que ainda precisa ser feito

Confirmar todos os nomes de colunas no schema real.

## Riscos

Bloquear uma action legítima caso ela não utilize service role ou contexto correto.

## Validação

- colaboradora tenta alterar e recebe erro;
- admin da mesma empresa consegue;
- gestor da mesma empresa consegue;
- utilizador de outra empresa não consegue;
- service role continua funcional;
- migrations desde zero;
- rollback.

## Resultado esperado

Integridade laboral protegida.

## Nota

4 → meta 9.

---

# 26. TASK T05 — PADRÃO ÚNICO DE RESULTADO DAS ACTIONS

## Problema

Actions devolvem estruturas diferentes e mensagens sem código estável.

## Causa

Cada action foi criada de forma independente.

## Arquivos envolvidos

- novo `src/lib/action-result.ts`;
- actions de clientes;
- actions de contratos;
- actions de calendário;
- actions de faturação;
- actions financeiras;
- componentes consumidores.

## O que corrigir

Padronizar:

- sucesso;
- falha;
- código;
- mensagem;
- detalhes;
- conflito;
- dados autoritativos.

## Solução

Criar:

```ts
ActionResult<T>
ActionSuccess<T>
ActionFailure
```

## O que implementar

- códigos estáveis;
- helper de sucesso;
- helper de falha;
- conversão de erro desconhecido;
- mapeamento de erros RPC;
- tratamento uniforme no frontend.

## O que reorganizar

Actions devem devolver `data`, não apenas `ok: true`, quando a base possui snapshot autoritativo.

## O que remover

Tipos locais duplicados depois da migração.

## O que manter

Mensagens específicas de negócio.

## Standby

Migração de todas as actions deve ocorrer por área, não num PR gigante.

## Riscos

Quebrar componentes que esperam formato antigo.

## Validação

- typecheck;
- testes de actions;
- smoke de formulários;
- adaptação progressiva.

## Nota

5 → meta 8.

---

# 27. TASK T06 — AUTENTICAÇÃO, AUTORIZAÇÃO E REVALIDAÇÃO CENTRAL

## Problema

Várias actions repetem autenticação, autorização e invalidação de cache.

## Causa

Evolução incremental sem camada comum obrigatória.

## Arquivos

- `src/lib/auth-guard.ts`;
- `src/lib/revalidate-business.ts`;
- todas as actions;
- testes.

## O que corrigir

- não confiar em `company_id` do cliente;
- eliminar `requireManager` locais;
- eliminar `createClient/createAdminClient` repetidos quando o helper atende;
- eliminar `revalidatePath` disperso;
- cobrir todas as áreas.

## Solução

Adotar `requireProfile` e uma matriz única de escopos.

## O que implementar

Escopos:

- dashboard;
- clientes;
- locais;
- contratos;
- calendário;
- cobranças;
- financeiro;
- relatórios;
- pendências;
- colaboradores;
- equipas;
- folha;
- tarefas.

## O que reorganizar

Cada action declara os escopos afetados.

## O que remover

Helpers locais somente depois de migrar todos os consumidores.

## O que manter

Guardas específicas adicionais de cada domínio.

## Standby

Revisão de todas as actions depende do inventário.

## Riscos

Revalidar páginas a mais e aumentar custo; revalidar páginas a menos e manter dados antigos.

## Validação

- teste estático contra `revalidatePath` fora do helper;
- smoke multiaba;
- smoke por área;
- build.

## Nota

6 → meta 8.

---

# 28. TASK T07 — MOTOR CANÓNICO DE RECORRÊNCIA

## Problema

Preview, geração real e cron podem calcular datas diferentes.

## Causa

Múltiplas implementações e regras locais.

## Arquivos envolvidos

- `src/domain/scheduling/recurrence-engine.ts`;
- `src/lib/contract-occurrences.ts`;
- `src/app/actions/contratos.ts`;
- formulário de contratos;
- cron;
- testes.

## Funções envolvidas

- `iterateOccurrences`;
- `occurrencesInRange`;
- `occurrencesFrom`;
- `getOccurrences`;
- preview local;
- gerador de serviços.

## O que corrigir

- mensal em múltiplos meses;
- dias 29/30/31;
- deslocamento de fim de semana;
- contratos personalizados antigos;
- exclusões;
- duplicação de datas;
- datas inválidas;
- mesma lógica em todos os consumidores.

## Solução

Uma única implementação pura no domínio.

## O que implementar

- clamp ao último dia;
- salto matemático;
- deduplicação;
- parsing estrito;
- wrapper temporário;
- testes de DST;
- teste em UTC;
- teste em Lisboa.

## O que reorganizar

Mover toda regra de recorrência para o domínio.

## O que remover

- cálculo local do formulário;
- lógica própria do cron;
- lógica própria da action;
- wrappers com lógica.

## O que manter

Assinaturas compatíveis através de wrapper.

## Standby

Recalcular ou migrar ocorrências futuras existentes, se necessário.

## Riscos

Alterar datas futuras já criadas.

## Validação

Matriz com:

- diário;
- semanal;
- quinzenal;
- triweekly;
- monthly;
- custom;
- 29;
- 30;
- 31;
- fevereiro;
- ano bissexto;
- fim de semana;
- exclusão;
- contrato futuro;
- contrato antigo;
- DST.

## Nota

4 no master / 7 na branch → meta 9.

---

# 29. TASK T08 — IDENTIDADE ÚNICA DE OCORRÊNCIA

## Problema

Duas execuções podem criar a mesma ocorrência lógica com referências diferentes.

## Causa

A deduplicação é feita por consulta prévia e não por constraint autoritativa.

## Arquivos e tabelas

- `services`;
- `contracts`;
- migration nova;
- tipos;
- cron;
- criação de contratos;
- duplicação de serviço;
- testes.

## Solução

Adicionar uma identidade lógica estável.

## Modelo recomendado

- `occurrence_date date`;
- opcional `occurrence_key text`;
- índice único parcial por empresa, contrato e ocorrência lógica.

## Ordem de migrations

1. adicionar coluna nullable;
2. preencher para dados elegíveis;
3. gerar relatório de duplicados;
4. resolver duplicados;
5. criar índice;
6. atualizar código;
7. tornar obrigatória para serviços recorrentes.

## O que implementar

- script de diagnóstico;
- script de reparação;
- constraint;
- `UPSERT`;
- contador de referências no banco.

## O que remover

Consultas “ver se existe” usadas como única garantia.

## O que manter

Checagem antecipada para UX, mas não como garantia final.

## Standby

Constraint final até analisar dados.

## Riscos

Dados históricos duplicados impedirem a migration.

## Validação

- duas ligações inserindo a mesma ocorrência;
- uma vence;
- outra recebe conflito controlado;
- nenhum duplicado.

## Nota

4 → meta 8.

---

# 30. TASK T09 — RPC ATÓMICA DE CONTRATOS

## Problema

Contrato, local e serviços são gravados em etapas independentes.

## Causa

As regras transacionais estão na action, não no banco.

## Arquivos envolvidos

- migration nova;
- `src/app/actions/contratos.ts`;
- domínio de recorrência;
- domínio de valores;
- tipos;
- componentes;
- testes.

## RPC proposta

```text
mutate_contract_atomic
```

## Entradas

- `p_contract_id`;
- `p_company_id`;
- `p_actor`;
- `p_payload`;
- `p_mutation_id`;
- `p_expected_revision`;
- `p_horizon_end`.

## Ordem da transação

1. validar utilizador;
2. validar empresa;
3. adquirir lock de mutação;
4. verificar idempotência;
5. bloquear local;
6. bloquear contrato;
7. validar revisão;
8. validar sobreposição;
9. atualizar local;
10. criar/atualizar contrato;
11. obter datas canónicas;
12. preservar exceções;
13. remover ocorrências inválidas;
14. atualizar ocorrências normais;
15. inserir ocorrências em falta;
16. obter referências;
17. gravar auditoria;
18. gravar outbox;
19. gravar recibo;
20. devolver snapshot.

## O que corrigir

Eliminar estado parcial e compensações.

## O que reorganizar

Action fica fina.

## O que remover

Depois da migração:

- `generateServicesForContract` da action;
- `updateFutureServiceValuesForContract`;
- `reconcileFutureServicesForContract`;
- compensação manual;
- contador em memória.

## O que manter

- validações puras;
- helpers de domínio;
- `is_exception`;
- read-after-write durante transição.

## Standby

SQL final até schema real.

## Riscos

Maior mudança de domínio; exige rollout expand/contract.

## Validação

- criação;
- edição;
- conflito;
- retry;
- pausa;
- cancelamento;
- reativação;
- duas sessões;
- falha forçada no meio;
- zero estado parcial.

## Nota

3 → meta 8.

---

# 31. TASK T10 — PAUSA, CANCELAMENTO, REATIVAÇÃO E CRON

## Problema

O estado do contrato e as ocorrências podem ficar divergentes.

## Causa

Operações separadas e geração assíncrona sem garantia final.

## Arquivos

- actions de intervenções;
- cancellations;
- cron;
- `background_jobs`;
- migrations;
- testes.

## Solução

- usar RPC de contrato;
- reativar gerando imediatamente;
- cron com lease;
- heartbeat;
- idempotência;
- UPSERT;
- resultado por contrato.

## O que implementar

Campos de job:

- `locked_at`;
- `locked_by`;
- `heartbeat_at`;
- `attempt`;
- `last_error`;
- `next_retry_at`.

## O que remover

- fire-and-forget;
- dedupe somente em memória;
- falha transformada em zero.

## O que manter

Cron mensal como mecanismo complementar.

## Standby

Reestruturação dos jobs depende do schema atual.

## Riscos

Jobs antigos presos; dupla execução durante rollout.

## Validação

- duas instâncias;
- lease expirado;
- retry;
- reativação;
- pausa;
- rollback.

## Nota

4 → meta 8.

# 32. TASK T11 — MODELO ÚNICO DE VALORES, IVA E AVENÇAS

## Problema

A fórmula principal de valor do serviço começou a ser centralizada, mas a divisão da avença mensal continua repetida em:

- cobrança diária;
- relatórios;
- dashboard financeiro;
- detalhes operacionais;
- possivelmente faturas e exportações.

## Causa identificada

Cada página precisou mostrar um valor e implementou a própria interpretação.

## Impacto

O mesmo contrato pode apresentar:

- valor diferente no calendário;
- valor diferente no relatório;
- valor diferente na cobrança;
- valor diferente na fatura;
- soma com diferença de cêntimos;
- distribuição diferente conforme o número de serviços concluídos.

## Arquivos envolvidos

- `src/lib/service-value.ts`;
- novo `src/domain/billing/monthly-allocation.ts`;
- `src/app/actions/daily-billing.ts`;
- `src/app/actions/reports.ts`;
- `src/app/actions/financial-dashboard.ts`;
- actions de faturas;
- componentes;
- exportações PDF/CSV;
- testes.

## Conceitos obrigatórios

| Conceito | Definição |
|---|---|
| Contratado | Valor previsto pelo contrato |
| Agendado | Valor alocado às ocorrências planeadas |
| Realizado | Valor alocado às ocorrências concluídas |
| Faturado | Valor emitido em faturas |
| Recebido | Valor confirmado em caixa |
| Em aberto | Faturado menos recebido |
| Vencido | Valor vencido não recebido |
| Custo | Despesa ou folha reconhecida |
| Margem | Receita definida menos custos definidos |

## O que precisa ser corrigido

- não chamar realizado de receita;
- não chamar fatura pendente de recebido;
- não distribuir avença de forma diferente em cada tela;
- não perder cêntimos;
- não depender somente das visitas concluídas para representar o contrato.

## Solução

Criar um módulo puro que distribua o valor mensal em cêntimos, com ordem determinística.

## O que será implementado

- `allocateMonthlyAmount`;
- `sumMonthlyAllocations`;
- DTO de valor;
- helper de IVA;
- testes de soma;
- testes de ordem;
- testes de valor zero;
- testes com 3, 7, 11 e 31 ocorrências.

## O que precisa ser reorganizado

Todos os consumidores devem chamar o mesmo módulo ou um read model que já utilize o módulo.

## O que será removido

- divisões locais;
- `fixed_price / count` repetido;
- arredondamento local;
- lógica de IVA duplicada.

## O que será mantido

`calculateServiceValue` como fonte do valor base do serviço não mensal.

## Standby

Decisão de negócio para proporcionalidade de contratos iniciados ou terminados no meio do mês.

## Riscos

Alterar números apresentados em relatórios antigos.

## Validação

- soma exata;
- comparação entre telas;
- comparação com fatura;
- teste em cêntimos;
- snapshot.

## Resultado esperado

Um único valor para cada conceito, em todas as telas.

## Nota

5 → meta 8.

---

# 33. TASK T12 — PAGAMENTO DE SERVIÇO ATÓMICO

## Problema

A action atual pode atualizar o pagamento no serviço e falhar ao atualizar o caixa.

## Causa

Duas escritas separadas.

## Arquivos e tabelas

- `services`;
- `cash_flow_entries`;
- `audit_logs`;
- outbox;
- migration nova;
- `daily-billing.ts`;
- tipos;
- componentes;
- testes.

## RPC proposta

```text
set_service_payment_atomic
```

## Entradas

- serviço;
- empresa;
- ator;
- novo estado;
- valor recebido;
- mutation ID;
- revisão esperada.

## Ordem

1. autorizar;
2. adquirir lock;
3. verificar idempotência;
4. bloquear serviço;
5. validar revisão;
6. calcular valor;
7. atualizar serviço;
8. criar, atualizar ou remover caixa;
9. auditar;
10. outbox;
11. recibo;
12. snapshot.

## O que corrigir

Eliminar serviço pago sem caixa e caixa sem estado correspondente.

## O que implementar

- RPC;
- migration;
- action fina;
- hook com mutation ID;
- revisão na UI;
- testes.

## O que reorganizar

`computeServiceBillingValue` deve usar domínio central.

## O que remover

`syncServicePaymentCashFlow` da action depois do rollout.

## O que manter

Mensagens e UX atuais, adaptadas ao conflito de revisão.

## Standby

Confirmação das constraints de caixa.

## Riscos

Duplicar movimento durante transição.

## Validação

- 0%;
- 50%;
- 100%;
- valor manual;
- avença;
- retry;
- duas sessões;
- reversão;
- falha forçada.

## Nota

5 → meta 8.

---

# 34. TASK T13 — GERAÇÃO ATÓMICA DE FATURAS

## Problema

Cabeçalho, itens, número e lote não são atómicos.

## Causa

Geração implementada na action através de várias queries.

## Arquivos e tabelas

- `invoices`;
- `invoice_items`;
- contador de documentos;
- contratos;
- serviços;
- clientes;
- audit;
- outbox;
- action;
- tipos;
- testes.

## RPC proposta

```text
generate_client_invoice_atomic
```

## O que a RPC deve fazer

1. autorizar;
2. bloquear contador;
3. verificar idempotência;
4. verificar fatura do período;
5. carregar contratos;
6. carregar serviços;
7. aplicar regra de avença;
8. calcular impostos;
9. recusar documento vazio;
10. gerar número;
11. inserir cabeçalho;
12. inserir itens;
13. auditar;
14. outbox;
15. recibo;
16. snapshot.

## O que corrigir

- avença sem serviço concluído;
- documento vazio;
- itens parciais;
- número duplicado;
- lote parcialmente silencioso.

## O que implementar

- resultado por cliente;
- resultado global;
- código de erro por cliente;
- retry seguro;
- regra de proporcionalidade documentada.

## O que reorganizar

Separar preparação de linhas, persistência e apresentação.

## O que remover

- `count + 1`;
- inserts separados na action;
- ignore de erro dos itens;
- retorno antecipado incorreto.

## O que manter

Interface de geração, com resultado detalhado.

## Standby

Decisão fiscal e de proporcionalidade.

## Riscos

Numeração fiscal; compatibilidade com documentos já emitidos.

## Validação

- avença pura;
- serviço avulso;
- misto;
- sem itens;
- dois geradores;
- retry;
- imposto;
- cliente já faturado.

## Nota

4 → meta 8.

---

# 35. TASK T14 — RELATÓRIOS OPERACIONAIS E FINANCEIROS

## Problema

Relatórios misturam conceitos e ignoram alguns erros de consulta.

## Causa

Agregações foram implementadas diretamente na action.

## Impacto

A cliente pode ver:

- números que não atualizam como esperado;
- receita diferente da fatura;
- avença invisível;
- absentismo fora do intervalo;
- comparação mensal inconsistente;
- divergência diária e mensal.

## Arquivos

- `src/app/actions/reports.ts`;
- novo domínio/read model;
- views ou RPCs;
- componentes;
- PDF;
- CSV;
- testes.

## Erros identificados

- queries sem tratamento de `error`;
- ausência contada integralmente;
- receita baseada em serviço concluído;
- avença dividida pelo concluído;
- contrato sem visita invisível;
- nomenclatura financeira ambígua.

## Solução

Criar read model central.

## Retorno mínimo

- contratado;
- agendado;
- realizado;
- faturado;
- recebido;
- pendente;
- vencido;
- despesas;
- folha;
- margem;
- serviços;
- cancelamentos;
- faltas;
- horas;
- absentismo;
- atualização;
- erros de integridade.

## O que implementar

- DTO único;
- consultas com erro;
- interseção de datas;
- agregação no banco quando apropriado;
- comparação diária;
- comparação mensal;
- exportação baseada no mesmo DTO.

## O que reorganizar

A action deve orquestrar, não calcular tudo.

## O que remover

Mapas duplicados e fórmulas locais depois do read model.

## O que manter

Filtros e apresentação existentes.

## Standby

Materialized view somente se medições mostrarem necessidade.

## Riscos

Mudança de significado dos cartões.

## Validação

- comparação manual com amostra;
- contrato mensal;
- serviço avulso;
- ausência parcial;
- fatura;
- caixa;
- exportação.

## Nota

4 → meta 8.

---

# 36. TASK T15 — DASHBOARD FINANCEIRO

## Problema

O dashboard financeiro usa definições inconsistentes de receita, custo e projeção.

## Causa

Cálculo independente dos relatórios e cobrança.

## Pontos identificados

- faturas não canceladas somadas como receita;
- custos limitados a salário líquido;
- datas baseadas no fuso do processo;
- projeção com numerador e divisor incompatíveis;
- conceitos operacionais misturados com financeiros.

## Arquivos

- `financial-dashboard.ts`;
- read model financeiro;
- componentes;
- tipos;
- testes.

## Solução

O dashboard deve consumir a mesma fonte dos relatórios financeiros.

## O que implementar

- receita faturada;
- receita recebida;
- valor em aberto;
- custo;
- margem;
- projeção com método explícito;
- timezone Lisboa;
- atualização.

## O que remover

Cálculos locais.

## O que manter

Layout e interação, salvo ajustes necessários.

## Standby

Definição final de custo operacional completo.

## Riscos

Utilizador perceber mudança nos números; será necessário explicar a nova definição.

## Validação

Comparar cada KPI com a fonte.

## Nota

4 → meta 8.

---

# 37. TASK T16 — REALTIME, OUTBOX E CACHE

## Problema

`revalidatePath` atualiza o cache do servidor, mas não garante atualização imediata em outros browsers.

## Causa

Falta de sistema Realtime autoritativo ligado às mutações.

## Arquivos e tabelas

- outbox;
- sync state;
- tipos;
- cliente Realtime;
- calendário;
- contratos;
- clientes;
- financeiro;
- health;
- testes.

## Solução

1. mutação grava evento;
2. evento recebe sequência por empresa;
3. cliente recebe evento privado;
4. cliente verifica sequência;
5. lacuna dispara resync;
6. mutação local aplica snapshot;
7. outros clientes atualizam;
8. cache é revalidado.

## O que implementar

- subscription por empresa;
- `lastSequence`;
- resync;
- escopos;
- descarte de revisão antiga;
- timeout;
- reconexão;
- health real.

## O que reorganizar

Separar:

- cache;
- estado local;
- Realtime;
- resync.

## O que remover

Refresh manual como mecanismo principal.

## O que manter

`router.refresh` como fallback pontual e revalidação server-side.

## Standby

Teste de dois clientes.

## Riscos

Eventos perdidos; eventos duplicados; canal incorreto; vazamento multiempresa.

## Validação

- duas sessões;
- duas empresas;
- offline;
- reconexão;
- lacuna;
- evento duplicado;
- revisão antiga.

## Nota

3 → meta 8.

---

# 38. TASK T17 — LIMPEZA DE 100% DOS FICHEIROS

## Problema

O projeto acumulou código e documentos de várias fases.

## Objetivo

Rever 100% dos ficheiros e classificar cada um.

## Estados

```text
MANTER
CENTRALIZAR
SUBSTITUIR
REMOVER
ARQUIVAR
STANDBY
```

## Grupos de revisão

### Código TypeScript/JavaScript

- imports;
- exports;
- variáveis;
- parâmetros;
- funções;
- classes;
- hooks;
- componentes;
- actions;
- rotas;
- tipos;
- interfaces;
- schemas;
- comentários;
- disables;
- logs.

### Banco

- migrations;
- functions;
- triggers;
- policies;
- grants;
- indexes;
- constraints;
- seeds;
- scripts;
- snapshots.

### Documentação

- estado;
- handoff;
- histórico;
- runbooks;
- decisões;
- instruções.

### Dependências

- runtime;
- dev;
- scripts;
- transitive;
- duplicadas;
- não utilizadas.

## Processo por ficheiro

1. abrir;
2. entender responsabilidade;
3. localizar entradas;
4. localizar saídas;
5. localizar referências;
6. localizar efeitos;
7. verificar testes;
8. verificar produção;
9. classificar;
10. alterar;
11. testar;
12. registar resultado.

## O que remover

Somente itens comprovados.

## Standby

Itens com referência externa não confirmada.

## Riscos

Remover convenção automática ou integração externa.

## Validação

Relatório por ficheiro e CI completo.

## Nota

4 → meta 8.

---

# 39. TASK T18 — TESTES, INTEGRAÇÃO E CI

## Unitários

- recorrência;
- valores;
- IVA;
- avença;
- datas;
- validações;
- transições;
- mapeamentos.

## Integração

- RPCs;
- migrations desde zero;
- migrations sobre snapshot;
- RLS;
- triggers;
- permissions;
- Realtime;
- cache.

## Concorrência

- mesma revisão;
- mesma mutação;
- mutações diferentes;
- dois geradores;
- duas faturas;
- dois pagamentos;
- duas atualizações de contrato.

## Regressão

- avença não desaparece;
- `undefined` não vira `null`;
- exceção não é sobrescrita;
- pausa remove;
- reativação gera;
- mensal gera vários meses;
- 31 não transborda;
- avença fatura sem visita;
- caixa permanece consistente;
- relatório coincide com fatura;
- Realtime recupera lacuna.

## Gates

```text
lint
typecheck
unit
integration
migration rehearsal
security
architecture
build
```

## O que implementar

GitHub Actions com jobs separados e artefactos.

## Standby

Testes de integração dependem de base descartável.

## Riscos

Testes frágeis e lentos.

## Validação

Execução limpa repetida.

## Nota

Unitário 6 → 8; integração 3 → 8.

---

# 40. TASK T19 — PUBLICAÇÃO SEGURA

## Problema

Uma alteração tecnicamente correta ainda pode causar incidente se publicada na ordem errada.

## Solução

Cada PR deve:

- nascer do `master`;
- ser pequena;
- ser draft;
- tratar uma task;
- listar ficheiros;
- listar tabelas;
- listar riscos;
- listar rollback;
- mostrar testes reais;
- não aplicar migration automaticamente;
- não fazer merge automático;
- não fazer deploy automático.

## Ordem de rollout

```text
expandir schema
validar schema
aplicar com autorização
confirmar objetos
publicar consumidor
monitorizar
migrar dados
remover compatibilidade
```

## Nota

Segurança atual 9; manter 9.

# 41. ORDEM DE PULL REQUESTS

## PR 1 — Inventário, padrão e guardas

- T00;
- T01;
- parte segura de T02;
- sem migration;
- sem alteração funcional.

## PR 2 — Remoção de artefactos perigosos

- T03;
- sem migration;
- sem alteração de regra de negócio.

## PR 3 — Proteção de `profiles`

- T04;
- migration isolada;
- testes reais.

## PR 4 — Motor de recorrência

- T07;
- sem migration;
- wrapper;
- testes.

## PR 5 — Fundação de mutações e outbox

- reconciliar 066/067;
- preservar 068/069;
- tipos;
- health;
- testes de duas sessões.

## PR 6 — Clientes e estado de fatura

- RPCs reconciliadas;
- migration nova;
- actions finas;
- interface idempotente.

## PR 7 — Identidade de ocorrências

- migration em fases;
- diagnóstico;
- constraint;
- contador.

## PR 8 — Contratos atómicos

- RPC;
- action;
- calendário;
- testes.

## PR 9 — Pagamentos

- serviço + caixa.

## PR 10 — Faturas

- documento + itens + número.

## PR 11 — Relatórios

- read model;
- exportações.

## PR 12 — Realtime

- consumidor;
- sequência;
- resync.

## PR 13 — Limpeza final

- somente candidatos comprovados;
- sem mudança funcional intencional.

---

# 42. CÓDIGO PREPARADO — `docs/ENGINEERING-STANDARD.md`

```md
# Padrão de Engenharia — Mó Limpezas

Este documento define como qualquer funcionalidade, correção, refatoração,
migration ou limpeza deve ser implementada.

## 1. Prioridades

1. Não interromper utilizadores ativos.
2. Preservar integridade e isolamento.
3. Manter compatibilidade entre código e banco.
4. Evitar múltiplas fontes da mesma regra.
5. Preferir alterações pequenas, reversíveis e testáveis.

## 2. Estrutura

- `src/domain`: regras puras.
- `src/application`: casos de uso.
- `src/infrastructure`: acesso a dados.
- `src/app/actions`: adaptadores.
- `src/components`: apresentação.
- `supabase/migrations`: append-only.

## 3. Server Actions

Uma Server Action deve:

1. autenticar;
2. validar;
3. chamar caso de uso ou RPC;
4. mapear resultado;
5. revalidar;
6. devolver snapshot ou erro.

É proibido:

- recorrência na action;
- cálculo financeiro duplicado;
- compensação manual;
- número por contagem;
- autorização alternativa.

## 4. Banco

- migrations são append-only;
- nunca editar migration aplicada;
- múltiplas tabelas exigem RPC;
- RPC recebe company, actor, mutation e revision;
- RPC valida ator;
- auditoria e outbox na transação;
- código consumidor só depois do objeto.

## 5. Concorrência

- revision obrigatória;
- mutation ID reutilizado;
- conflito não vira sucesso;
- constraint final no banco.

## 6. Datas

- usar Lisboa;
- recorrência é data civil;
- timestamps com offset;
- proibido decidir hoje com Date no servidor.

## 7. Valores

- valor de serviço central;
- avença central;
- relatórios separam conceitos;
- componentes não recalculam.

## 8. Cache e Realtime

- revalidação central;
- outbox;
- sequência;
- lacuna exige resync;
- snapshot local.

## 9. Erros

- verificar error;
- falha não é vazio;
- códigos estáveis;
- não expor segredos.

## 10. Limpeza

Remover somente após:

1. imports;
2. referências;
3. convenção Next;
4. dinâmicos;
5. testes;
6. smoke.

## 11. Testes

- unitário;
- regressão;
- integração;
- concorrência;
- isolamento.

## 12. PR

Cada PR apresenta:

- problema;
- causa;
- escopo;
- ficheiros;
- tabelas;
- alterações;
- removidos;
- mantidos;
- standby;
- riscos;
- testes;
- rollback;
- nota.

## 13. Definition of Done

- diff check;
- typecheck;
- lint;
- test;
- build;
- sem warnings;
- sem alteração não relacionada;
- rollback;
- autorização.
```

---

# 43. CÓDIGO PREPARADO — `.github/pull_request_template.md`

```md
## Task

ID:
Área:
Nota antes:
Nota pretendida:

## Problema

## Causa

## Escopo

### Arquivos

-

### Funções/componentes

-

### Tabelas/RPCs/migrations

-

## Implementação

## Removido

-

## Mantido

-

## Standby

-

## Compatibilidade

- [ ] Não remove funcionalidade ativa
- [ ] Compatível com o schema publicado
- [ ] Preserva dados
- [ ] Mantém isolamento
- [ ] Mantém exceções
- [ ] Não cria regra duplicada

## Concorrência

- [ ] expected_revision
- [ ] mutation_id
- [ ] constraint
- [ ] teste concorrente

## Cache e Realtime

- [ ] revalidação
- [ ] outbox
- [ ] snapshot
- [ ] recuperação

## Validação

- [ ] diff
- [ ] typecheck
- [ ] lint
- [ ] test
- [ ] build
- [ ] regressão
- [ ] integração
- [ ] isolamento
- [ ] smoke

## Riscos

-

## Rollback

-

## Resultado

Nota:
Evidências:
```

---

# 44. CÓDIGO PREPARADO — `src/lib/action-result.ts`

```ts
export type ActionErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "REVISION_CONFLICT"
  | "MUTATION_REUSE_CONFLICT"
  | "DATA_ACCESS_ERROR"
  | "INTEGRITY_ERROR"
  | "INTERNAL_ERROR";

export interface ActionFailure {
  ok: false;
  code: ActionErrorCode;
  error: string;
  details?: Record<string, unknown>;
}

export interface ActionSuccess<T> {
  ok: true;
  data: T;
}

export type ActionResult<T> =
  | ActionSuccess<T>
  | ActionFailure;

export function actionSuccess<T>(
  data: T,
): ActionSuccess<T> {
  return { ok: true, data };
}

export function actionFailure(
  code: ActionErrorCode,
  error: string,
  details?: Record<string, unknown>,
): ActionFailure {
  return details
    ? { ok: false, code, error, details }
    : { ok: false, code, error };
}

export function unknownActionFailure(
  value: unknown,
  fallback = "Ocorreu um erro inesperado.",
): ActionFailure {
  if (value instanceof Error) {
    return actionFailure(
      "INTERNAL_ERROR",
      value.message || fallback,
    );
  }

  return actionFailure(
    "INTERNAL_ERROR",
    fallback,
  );
}
```

---

# 45. CÓDIGO PREPARADO — `src/lib/revalidate-business.ts`

```ts
import { revalidatePath } from "next/cache";

export type BusinessScope =
  | "dashboard"
  | "clientes"
  | "locais"
  | "contratos"
  | "calendario"
  | "cobrancas"
  | "financeiro"
  | "relatorios"
  | "pendencias"
  | "colaboradores"
  | "equipas"
  | "folha_pagamento"
  | "tarefas";

const STATIC_PATHS:
Record<BusinessScope, readonly string[]> = {
  dashboard: ["/dashboard"],
  clientes: ["/dashboard/clientes"],
  locais: ["/dashboard/locais"],
  contratos: ["/dashboard/contratos"],
  calendario: ["/dashboard/calendario"],
  cobrancas: ["/dashboard/cobrancas"],
  financeiro: ["/dashboard/financeiro"],
  relatorios: ["/dashboard/relatorios"],
  pendencias: ["/dashboard/pendencias"],
  colaboradores: ["/dashboard/colaboradores"],
  equipas: ["/dashboard/equipas"],
  folha_pagamento: ["/dashboard/folha-pagamento"],
  tarefas: ["/dashboard/tarefas"],
};

export interface RevalidateBusinessOptions {
  scopes: readonly BusinessScope[];
  clientId?: string | null;
  collaboratorId?: string | null;
}

export function revalidateBusinessPaths(
  options: RevalidateBusinessOptions,
): void {
  const paths = new Set<string>();

  for (const scope of options.scopes) {
    for (const path of STATIC_PATHS[scope]) {
      paths.add(path);
    }
  }

  if (
    options.clientId &&
    options.scopes.some((scope) =>
      [
        "clientes",
        "locais",
        "contratos",
        "calendario",
        "cobrancas",
      ].includes(scope),
    )
  ) {
    paths.add(
      `/dashboard/clientes/${options.clientId}`,
    );
  }

  if (
    options.collaboratorId &&
    options.scopes.some((scope) =>
      [
        "colaboradores",
        "folha_pagamento",
      ].includes(scope),
    )
  ) {
    paths.add(
      `/dashboard/colaboradores/${options.collaboratorId}`,
    );
  }

  for (const path of paths) {
    revalidatePath(path);
  }
}
```

---

# 46. CÓDIGO PREPARADO — `src/domain/billing/monthly-allocation.ts`

```ts
export interface MonthlyAllocation<TKey> {
  key: TKey;
  amount: number;
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

function fromCents(value: number): number {
  return value / 100;
}

export function allocateMonthlyAmount<TKey>(
  monthlyAmount: number,
  orderedKeys: readonly TKey[],
): MonthlyAllocation<TKey>[] {
  if (
    !Number.isFinite(monthlyAmount) ||
    monthlyAmount < 0
  ) {
    throw new Error("Valor mensal inválido.");
  }

  if (orderedKeys.length === 0) {
    return [];
  }

  const totalCents = toCents(monthlyAmount);
  const baseCents = Math.floor(
    totalCents / orderedKeys.length,
  );
  const remainder =
    totalCents % orderedKeys.length;

  return orderedKeys.map(
    (key, index) => ({
      key,
      amount: fromCents(
        baseCents +
          (index < remainder ? 1 : 0),
      ),
    }),
  );
}

export function sumMonthlyAllocations<TKey>(
  allocations:
    readonly MonthlyAllocation<TKey>[],
): number {
  const cents = allocations.reduce(
    (total, allocation) =>
      total + toCents(allocation.amount),
    0,
  );

  return fromCents(cents);
}
```

Teste:

```ts
import { describe, expect, it } from "vitest";
import {
  allocateMonthlyAmount,
  sumMonthlyAllocations,
} from "@/domain/billing/monthly-allocation";

describe("allocateMonthlyAmount", () => {
  it("mantém soma exata", () => {
    const result =
      allocateMonthlyAmount(
        100,
        ["a", "b", "c"],
      );

    expect(result).toEqual([
      { key: "a", amount: 33.34 },
      { key: "b", amount: 33.33 },
      { key: "c", amount: 33.33 },
    ]);

    expect(
      sumMonthlyAllocations(result),
    ).toBe(100);
  });

  it("aceita zero", () => {
    expect(
      allocateMonthlyAmount(
        0,
        ["a", "b"],
      ),
    ).toEqual([
      { key: "a", amount: 0 },
      { key: "b", amount: 0 },
    ]);
  });

  it("recusa inválido", () => {
    expect(() =>
      allocateMonthlyAmount(
        Number.NaN,
        ["a"],
      ),
    ).toThrow();

    expect(() =>
      allocateMonthlyAmount(
        -1,
        ["a"],
      ),
    ).toThrow();
  });
});
```

# 47. CÓDIGO PREPARADO — MIGRATION DE CAMPOS LABORAIS

O número definitivo deve ser confirmado no momento da implementação. Nome de referência:

```text
070_guard_profile_managed_fields.sql
```

```sql
-- ============================================================================
-- Proteção dos campos laborais e administrativos de public.profiles
-- ============================================================================

CREATE OR REPLACE FUNCTION
public.fn_guard_profile_managed_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_role text;
  v_actor_company uuid;
  v_managed_fields_changed boolean;
BEGIN
  -- Fluxos server-side previamente autorizados continuam funcionais.
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  v_managed_fields_changed :=
       NEW.contracted_hours_month
         IS DISTINCT FROM
       OLD.contracted_hours_month
    OR NEW.hourly_rate
         IS DISTINCT FROM
       OLD.hourly_rate
    OR NEW.contract_start
         IS DISTINCT FROM
       OLD.contract_start
    OR NEW.contract_end
         IS DISTINCT FROM
       OLD.contract_end
    OR NEW.vacation_balance
         IS DISTINCT FROM
       OLD.vacation_balance
    OR NEW.status
         IS DISTINCT FROM
       OLD.status;

  IF NOT v_managed_fields_changed THEN
    RETURN NEW;
  END IF;

  v_actor_role :=
    public.get_my_role();

  v_actor_company :=
    public.get_my_company_id();

  IF NOT (
    v_actor_role IN ('admin', 'gestor')
    AND v_actor_company = OLD.company_id
    AND NEW.company_id = OLD.company_id
  ) THEN
    RAISE EXCEPTION
      'PROFILE_MANAGED_FIELDS_BLOCKED: campos laborais exigem admin/gestor da própria empresa'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
trg_guard_profile_managed_fields
ON public.profiles;

CREATE TRIGGER
trg_guard_profile_managed_fields
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION
public.fn_guard_profile_managed_fields();

REVOKE ALL ON FUNCTION
public.fn_guard_profile_managed_fields()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
public.fn_guard_profile_managed_fields()
TO service_role;
```

## Testes necessários

```ts
it("protege todos os campos geridos", () => {
  for (const field of [
    "contracted_hours_month",
    "hourly_rate",
    "contract_start",
    "contract_end",
    "vacation_balance",
    "status",
  ]) {
    expect(sql).toContain(`NEW.${field}`);
    expect(sql).toContain(`OLD.${field}`);
  }
});

it("mantém service role", () => {
  expect(sql).toContain(
    "auth.role() = 'service_role'",
  );
});

it("exige admin ou gestor da mesma empresa", () => {
  expect(sql).toContain("get_my_role()");
  expect(sql).toContain("get_my_company_id()");
  expect(sql).toContain(
    "NEW.company_id = OLD.company_id",
  );
});
```

Além dos testes estáticos, são obrigatórios testes reais numa base descartável.

---

# 48. CÓDIGO PREPARADO — MOTOR CANÓNICO DE RECORRÊNCIA

Arquivo:

```text
src/domain/scheduling/recurrence-engine.ts
```

```ts
import type { ScheduleDay } from "@/types/database";

export const DOW_TO_KEY:
Record<number, ScheduleDay["day"]> = {
  0: "sun",
  1: "mon",
  2: "tue",
  3: "wed",
  4: "thu",
  5: "fri",
  6: "sat",
};

const CADENCE_WEEKS:
Readonly<Record<string, number>> = {
  weekly: 1,
  biweekly: 2,
  triweekly: 3,
};

const SHIFTED_FREQUENCIES =
  new Set(["monthly", "custom"]);

const DAY_MS =
  24 * 60 * 60 * 1000;

const MAX_SHIFT_DAYS = 2;
const MAX_DAILY_STEPS = 20 * 366;
const MAX_MONTHLY_STEPS = 20 * 12;

export interface RecurrenceContract {
  frequency: string;
  weekdays: number[] | null;
  interval_days: number;
  schedule_days: ScheduleDay[];
  starts_on: string;
  ends_on: string | null;
  excluded_dates?: string[] | null;
}

export interface RecurrenceOccurrence {
  date: Date;
  schedule: ScheduleDay;
}

function parseDateOnly(
  value: string,
): Date | null {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return null;
  }

  const [year, month, day] =
    value.split("-").map(Number);

  const parsed =
    new Date(year, month - 1, day);

  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed;
}

function atMidnight(
  date: Date,
): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
}

function addDays(
  date: Date,
  amount: number,
): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + amount,
  );
}

function dateOrdinal(
  date: Date,
): number {
  return Math.floor(
    Date.UTC(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
    ) / DAY_MS,
  );
}

function daysInMonth(
  year: number,
  monthIndex: number,
): number {
  return new Date(
    year,
    monthIndex + 1,
    0,
  ).getDate();
}

function monthlyTargetDate(
  year: number,
  monthIndex: number,
  requestedDay: number,
): Date {
  const clampedDay = Math.min(
    requestedDay,
    daysInMonth(year, monthIndex),
  );

  return new Date(
    year,
    monthIndex,
    clampedDay,
  );
}

export function shiftToNextBusinessDay(
  date: Date,
): Date {
  const shifted = new Date(date);
  const dayOfWeek = shifted.getDay();

  if (dayOfWeek === 6) {
    shifted.setDate(
      shifted.getDate() + 2,
    );
  } else if (dayOfWeek === 0) {
    shifted.setDate(
      shifted.getDate() + 1,
    );
  }

  return shifted;
}

export function toDateStr(
  date: Date,
): string {
  const year = date.getFullYear();
  const month = String(
    date.getMonth() + 1,
  ).padStart(2, "0");

  const day = String(
    date.getDate(),
  ).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function firstCustomCursor(
  contractStart: Date,
  lowerBound: Date,
  stepDays: number,
): Date {
  const earliestRelevantBase =
    addDays(
      lowerBound,
      -MAX_SHIFT_DAYS,
    );

  const difference = Math.max(
    0,
    dateOrdinal(earliestRelevantBase) -
      dateOrdinal(contractStart),
  );

  const completedSteps = Math.max(
    0,
    Math.floor(
      difference / stepDays,
    ),
  );

  return addDays(
    contractStart,
    completedSteps * stepDays,
  );
}

export function* iterateOccurrences(
  contract: RecurrenceContract,
  from: Date,
): Generator<
  RecurrenceOccurrence,
  void,
  void
> {
  const defaultSchedule =
    contract.schedule_days?.[0];

  if (!defaultSchedule) {
    return;
  }

  const contractStart =
    parseDateOnly(contract.starts_on);

  if (!contractStart) {
    return;
  }

  const contractEnd =
    contract.ends_on
      ? parseDateOnly(contract.ends_on)
      : null;

  if (
    contract.ends_on &&
    !contractEnd
  ) {
    return;
  }

  const excluded =
    new Set(
      contract.excluded_dates ?? [],
    );

  const normalizedFrom =
    atMidnight(from);

  const lowerBound =
    normalizedFrom > contractStart
      ? normalizedFrom
      : atMidnight(contractStart);

  function passesEndAndExclusion(
    date: Date,
  ): boolean {
    return (
      (!contractEnd ||
        date <= contractEnd) &&
      !excluded.has(toDateStr(date))
    );
  }

  if (
    contract.frequency === "daily"
  ) {
    const cursor =
      new Date(lowerBound);

    for (
      let index = 0;
      index < MAX_DAILY_STEPS;
      index++
    ) {
      if (
        contractEnd &&
        cursor > contractEnd
      ) {
        return;
      }

      const dayOfWeek =
        cursor.getDay();

      if (
        dayOfWeek !== 0 &&
        dayOfWeek !== 6 &&
        passesEndAndExclusion(cursor)
      ) {
        yield {
          date: new Date(cursor),
          schedule: defaultSchedule,
        };
      }

      cursor.setDate(
        cursor.getDate() + 1,
      );
    }

    return;
  }

  if (
    Object.prototype
      .hasOwnProperty.call(
        CADENCE_WEEKS,
        contract.frequency,
      )
  ) {
    const cadence =
      CADENCE_WEEKS[
        contract.frequency
      ];

    const weekdays = [
      ...new Set(
        contract.weekdays ?? [],
      ),
    ].filter(
      (day) =>
        Number.isInteger(day) &&
        day >= 0 &&
        day <= 6,
    );

    if (weekdays.length === 0) {
      return;
    }

    const startWeekNumber =
      Math.floor(
        dateOrdinal(contractStart) / 7,
      );

    const cursor =
      new Date(lowerBound);

    for (
      let index = 0;
      index < MAX_DAILY_STEPS;
      index++
    ) {
      if (
        contractEnd &&
        cursor > contractEnd
      ) {
        return;
      }

      const dayOfWeek =
        cursor.getDay();

      if (
        weekdays.includes(dayOfWeek)
      ) {
        const currentWeekNumber =
          Math.floor(
            dateOrdinal(cursor) / 7,
          );

        const isCorrectWeek =
          cadence === 1 ||
          (
            currentWeekNumber -
            startWeekNumber
          ) % cadence === 0;

        if (
          isCorrectWeek &&
          passesEndAndExclusion(cursor)
        ) {
          const dayKey =
            DOW_TO_KEY[dayOfWeek];

          const schedule =
            contract.schedule_days
              .find(
                (candidate) =>
                  candidate.day === dayKey,
              ) ?? defaultSchedule;

          yield {
            date: new Date(cursor),
            schedule,
          };
        }
      }

      cursor.setDate(
        cursor.getDate() + 1,
      );
    }

    return;
  }

  if (
    contract.frequency === "monthly"
  ) {
    const requestedDay =
      contractStart.getDate();

    const contractStartMonth =
      new Date(
        contractStart.getFullYear(),
        contractStart.getMonth(),
        1,
      );

    let monthCursor =
      new Date(
        lowerBound.getFullYear(),
        lowerBound.getMonth(),
        1,
      );

    if (
      monthCursor <
      contractStartMonth
    ) {
      monthCursor =
        contractStartMonth;
    }

    const usedDates =
      new Set<string>();

    for (
      let index = 0;
      index < MAX_MONTHLY_STEPS;
      index++
    ) {
      if (
        contractEnd &&
        monthCursor > contractEnd
      ) {
        return;
      }

      const baseDate =
        monthlyTargetDate(
          monthCursor.getFullYear(),
          monthCursor.getMonth(),
          requestedDay,
        );

      const target =
        shiftToNextBusinessDay(
          baseDate,
        );

      const targetKey =
        toDateStr(target);

      if (
        target >= lowerBound &&
        target >= contractStart &&
        passesEndAndExclusion(target) &&
        !usedDates.has(targetKey)
      ) {
        usedDates.add(targetKey);

        yield {
          date: target,
          schedule: defaultSchedule,
        };
      }

      monthCursor =
        new Date(
          monthCursor.getFullYear(),
          monthCursor.getMonth() + 1,
          1,
        );
    }

    return;
  }

  if (
    contract.frequency === "custom"
  ) {
    const stepDays = Math.min(
      365,
      Math.max(
        1,
        Number.isFinite(
          contract.interval_days,
        )
          ? Math.floor(
              contract.interval_days,
            )
          : 1,
      ),
    );

    const cursor =
      firstCustomCursor(
        contractStart,
        lowerBound,
        stepDays,
      );

    const usedDates =
      new Set<string>();

    for (
      let index = 0;
      index < MAX_DAILY_STEPS;
      index++
    ) {
      if (
        contractEnd &&
        cursor > contractEnd
      ) {
        return;
      }

      const shifted =
        shiftToNextBusinessDay(
          cursor,
        );

      const shiftedKey =
        toDateStr(shifted);

      if (
        shifted >= lowerBound &&
        shifted >= contractStart &&
        passesEndAndExclusion(
          shifted,
        ) &&
        !usedDates.has(shiftedKey)
      ) {
        usedDates.add(shiftedKey);

        yield {
          date: new Date(shifted),
          schedule: defaultSchedule,
        };
      }

      cursor.setDate(
        cursor.getDate() +
          stepDays,
      );
    }
  }
}

export function occurrencesInRange(
  contract: RecurrenceContract,
  rangeStart: Date,
  rangeEnd: Date,
): RecurrenceOccurrence[] {
  if (rangeEnd < rangeStart) {
    return [];
  }

  const results:
    RecurrenceOccurrence[] = [];

  const tolerantEnd =
    SHIFTED_FREQUENCIES.has(
      contract.frequency,
    )
      ? addDays(
          rangeEnd,
          MAX_SHIFT_DAYS,
        )
      : rangeEnd;

  for (
    const occurrence of
      iterateOccurrences(
        contract,
        rangeStart,
      )
  ) {
    if (
      occurrence.date >
      tolerantEnd
    ) {
      break;
    }

    if (
      occurrence.date >=
      rangeStart
    ) {
      results.push(occurrence);
    }
  }

  return results;
}

export function occurrencesFrom(
  contract: RecurrenceContract,
  from: Date,
  count: number,
): RecurrenceOccurrence[] {
  if (
    !Number.isInteger(count) ||
    count <= 0
  ) {
    return [];
  }

  const results:
    RecurrenceOccurrence[] = [];

  for (
    const occurrence of
      iterateOccurrences(
        contract,
        from,
      )
  ) {
    results.push(occurrence);

    if (
      results.length >= count
    ) {
      break;
    }
  }

  return results;
}
```

Wrapper:

```ts
import {
  DOW_TO_KEY,
  occurrencesInRange,
  shiftToNextBusinessDay,
  toDateStr,
  type RecurrenceContract,
  type RecurrenceOccurrence,
} from "@/domain/scheduling/recurrence-engine";

export {
  DOW_TO_KEY,
  shiftToNextBusinessDay,
  toDateStr,
};

export type OccurrenceContract =
  RecurrenceContract;

export function getOccurrences(
  contract: OccurrenceContract,
  rangeStart: Date,
  rangeEnd: Date,
): RecurrenceOccurrence[] {
  return occurrencesInRange(
    contract,
    rangeStart,
    rangeEnd,
  );
}
```

# 49. TESTES PREPARADOS — RECORRÊNCIA

Arquivo:

```text
src/__tests__/recurrence-engine-edge-cases.test.ts
```

```ts
import {
  describe,
  expect,
  it,
} from "vitest";

import {
  occurrencesFrom,
  occurrencesInRange,
  toDateStr,
  type RecurrenceContract,
} from "@/domain/scheduling/recurrence-engine";

const schedule = [{
  day: "all" as const,
  start_time: "09:00",
  duration_min: 120,
  team_id: null,
}];

function contract(
  overrides:
    Partial<RecurrenceContract> = {},
): RecurrenceContract {
  return {
    frequency: "monthly",
    weekdays: null,
    interval_days: 1,
    schedule_days: schedule,
    starts_on: "2026-01-31",
    ends_on: null,
    excluded_dates: [],
    ...overrides,
  };
}

describe(
  "recurrence engine — limites",
  () => {
    it(
      "limita dia 31 ao último dia",
      () => {
        const occurrences =
          occurrencesInRange(
            contract(),
            new Date(2026, 0, 1),
            new Date(2026, 5, 30),
          );

        expect(
          occurrences.map(
            (item) =>
              toDateStr(item.date),
          ),
        ).toEqual([
          "2026-02-02",
          "2026-03-02",
          "2026-03-31",
          "2026-04-30",
          "2026-06-01",
          "2026-06-30",
        ]);
      },
    );

    it(
      "salta contratos antigos",
      () => {
        const occurrences =
          occurrencesFrom(
            contract({
              frequency: "custom",
              interval_days: 7,
              starts_on: "2000-01-03",
            }),
            new Date(2026, 7, 1),
            3,
          );

        expect(
          occurrences,
        ).toHaveLength(3);

        expect(
          occurrences[0].date >=
            new Date(2026, 7, 1),
        ).toBe(true);
      },
    );

    it(
      "não duplica fim de semana",
      () => {
        const occurrences =
          occurrencesInRange(
            contract({
              frequency: "custom",
              interval_days: 1,
              starts_on: "2026-08-01",
            }),
            new Date(2026, 7, 1),
            new Date(2026, 7, 5),
          );

        const dates =
          occurrences.map(
            (item) =>
              toDateStr(item.date),
          );

        expect(
          new Set(dates).size,
        ).toBe(dates.length);
      },
    );

    it(
      "ignora data inválida",
      () => {
        expect(
          occurrencesFrom(
            contract({
              starts_on:
                "72026-01-01",
            }),
            new Date(2026, 0, 1),
            3,
          ),
        ).toEqual([]);
      },
    );

    it(
      "respeita exclusão deslocada",
      () => {
        const occurrences =
          occurrencesFrom(
            contract({
              excluded_dates: [
                "2026-02-02",
              ],
            }),
            new Date(2026, 0, 1),
            1,
          );

        expect(
          toDateStr(
            occurrences[0].date,
          ),
        ).toBe("2026-03-02");
      },
    );
  },
);
```

---

# 50. SCRIPTS RECOMENDADOS NO `package.json`

Substituir somente o objeto `scripts`, depois de validar os caminhos existentes:

```json
{
  "scripts": {
    "dev": "next dev",
    "prebuild": "npx tsx scripts/check-env.ts && npx tsx scripts/audit-security.ts && node scripts/stamp-sw.mjs",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "lint:strict": "eslint . --max-warnings=0",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "audit:code": "node scripts/audit-codebase.mjs",
    "audit:code:json": "node scripts/audit-codebase.mjs --output reports/code-audit.json",
    "audit:code:strict": "node scripts/audit-codebase.mjs --fail-on-high-confidence",
    "quality": "npm run lint && npm run typecheck && npm test && npm run build"
  }
}
```

---

# 51. AUDITOR INTEGRAL DO CÓDIGO

Arquivo:

```text
scripts/audit-codebase.mjs
```

O script deve ser executado antes de qualquer remoção.

```js
#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const args = process.argv.slice(2);

const FAIL_ON_HIGH_CONFIDENCE =
  args.includes(
    "--fail-on-high-confidence",
  );

function readArgument(flag) {
  const index =
    args.indexOf(flag);

  return index >= 0
    ? args[index + 1] ?? null
    : null;
}

const OUTPUT =
  readArgument("--output");

const IGNORED_DIRECTORIES =
  new Set([
    ".git",
    ".next",
    ".vercel",
    "node_modules",
    "out",
    "build",
    "coverage",
  ]);

const TEXT_EXTENSIONS =
  new Set([
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".sql",
    ".md",
    ".css",
    ".scss",
    ".html",
    ".yml",
    ".yaml",
    ".sh",
    ".ps1",
  ]);

const NEXT_ENTRY_NAMES =
  new Set([
    "page.ts",
    "page.tsx",
    "layout.ts",
    "layout.tsx",
    "route.ts",
    "route.tsx",
    "loading.ts",
    "loading.tsx",
    "error.ts",
    "error.tsx",
    "global-error.ts",
    "global-error.tsx",
    "not-found.ts",
    "not-found.tsx",
    "template.ts",
    "template.tsx",
    "default.ts",
    "default.tsx",
  ]);

function normalizePath(value) {
  return value
    .split(path.sep)
    .join("/");
}

function relative(value) {
  return normalizePath(
    path.relative(ROOT, value),
  );
}

function walk(
  directory,
  output = [],
) {
  for (
    const name of
      fs.readdirSync(directory)
  ) {
    if (
      IGNORED_DIRECTORIES
        .has(name)
    ) {
      continue;
    }

    const absolute =
      path.join(directory, name);

    const stat =
      fs.statSync(absolute);

    if (stat.isDirectory()) {
      walk(absolute, output);
    } else {
      output.push(absolute);
    }
  }

  return output;
}

function lineNumber(
  sourceFile,
  position,
) {
  return sourceFile
    .getLineAndCharacterOfPosition(
      position,
    ).line + 1;
}

function isInsideProject(
  fileName,
) {
  const root =
    normalizePath(ROOT) + "/";

  return normalizePath(fileName)
    .startsWith(root);
}

function isTestFile(
  fileName,
) {
  const value =
    normalizePath(fileName);

  return (
    value.includes(
      "/__tests__/",
    ) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/
      .test(value)
  );
}

function isProductionEntry(
  fileName,
) {
  const rel = relative(fileName);
  const base =
    path.basename(fileName);

  if (
    rel === "src/proxy.ts" ||
    rel === "src/middleware.ts" ||
    rel ===
      "src/instrumentation.ts" ||
    rel ===
      "src/instrumentation-client.ts"
  ) {
    return true;
  }

  return (
    rel.startsWith("src/app/") &&
    NEXT_ENTRY_NAMES.has(base)
  );
}

function sha256(content) {
  return crypto
    .createHash("sha256")
    .update(content)
    .digest("hex");
}

const allFiles = walk(ROOT);

const textFiles =
  allFiles.filter((file) =>
    TEXT_EXTENSIONS.has(
      path.extname(file)
        .toLowerCase(),
    ),
  );

const configPath =
  ts.findConfigFile(
    ROOT,
    ts.sys.fileExists,
    "tsconfig.json",
  );

if (!configPath) {
  throw new Error(
    "tsconfig.json não encontrado.",
  );
}

const configRead =
  ts.readConfigFile(
    configPath,
    ts.sys.readFile,
  );

if (configRead.error) {
  throw new Error(
    ts.flattenDiagnosticMessageText(
      configRead.error.messageText,
      "\n",
    ),
  );
}

const parsedConfig =
  ts.parseJsonConfigFileContent(
    configRead.config,
    ts.sys,
    ROOT,
  );

const program =
  ts.createProgram({
    rootNames:
      parsedConfig.fileNames,
    options:
      parsedConfig.options,
  });

const sourceFiles =
  program.getSourceFiles()
    .filter(
      (sourceFile) =>
        isInsideProject(
          sourceFile.fileName,
        ) &&
        !sourceFile
          .isDeclarationFile,
    );

const diagnostics =
  ts.getPreEmitDiagnostics(
    program,
  ).map((diagnostic) => {
    const file =
      diagnostic.file;

    const location =
      file &&
      diagnostic.start != null
        ? {
            file:
              relative(
                file.fileName,
              ),
            line:
              lineNumber(
                file,
                diagnostic.start,
              ),
          }
        : null;

    return {
      code:
        diagnostic.code,
      category:
        ts.DiagnosticCategory[
          diagnostic.category
        ],
      message:
        ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          "\n",
        ),
      location,
    };
  });

const graph = new Map();

function resolveModule(
  sourceFile,
  moduleName,
) {
  const result =
    ts.resolveModuleName(
      moduleName,
      sourceFile.fileName,
      parsedConfig.options,
      ts.sys,
    );

  const resolved =
    result.resolvedModule
      ?.resolvedFileName;

  if (
    !resolved ||
    !isInsideProject(resolved) ||
    resolved.includes(
      "/node_modules/",
    )
  ) {
    return null;
  }

  return normalizePath(resolved);
}

for (
  const sourceFile of
    sourceFiles
) {
  const sourceKey =
    normalizePath(
      sourceFile.fileName,
    );

  const dependencies =
    new Set();

  function visit(node) {
    let moduleName = null;

    if (
      (
        ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node)
      ) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(
        node.moduleSpecifier,
      )
    ) {
      moduleName =
        node.moduleSpecifier.text;
    }

    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(
        node.arguments[0],
      )
    ) {
      if (
        node.expression.kind ===
        ts.SyntaxKind.ImportKeyword
      ) {
        moduleName =
          node.arguments[0].text;
      }

      if (
        ts.isIdentifier(
          node.expression,
        ) &&
        node.expression.text ===
          "require"
      ) {
        moduleName =
          node.arguments[0].text;
      }
    }

    if (moduleName) {
      const resolved =
        resolveModule(
          sourceFile,
          moduleName,
        );

      if (resolved) {
        dependencies.add(
          resolved,
        );
      }
    }

    ts.forEachChild(
      node,
      visit,
    );
  }

  visit(sourceFile);

  graph.set(
    sourceKey,
    dependencies,
  );
}

function collectReachable(
  entries,
) {
  const visited =
    new Set();

  const pending =
    [...entries];

  while (
    pending.length > 0
  ) {
    const current =
      pending.pop();

    if (
      !current ||
      visited.has(current)
    ) {
      continue;
    }

    visited.add(current);

    for (
      const dependency of
        graph.get(current) ?? []
    ) {
      if (
        !visited.has(
          dependency,
        )
      ) {
        pending.push(
          dependency,
        );
      }
    }
  }

  return visited;
}

const productionEntries =
  sourceFiles
    .filter((file) =>
      isProductionEntry(
        file.fileName,
      ),
    )
    .map((file) =>
      normalizePath(
        file.fileName,
      ),
    );

const testEntries =
  sourceFiles
    .filter((file) =>
      isTestFile(
        file.fileName,
      ),
    )
    .map((file) =>
      normalizePath(
        file.fileName,
      ),
    );

const productionReachable =
  collectReachable(
    productionEntries,
  );

const allReachable =
  collectReachable([
    ...productionEntries,
    ...testEntries,
  ]);

const unreachableProductionModules =
  sourceFiles
    .filter((file) => {
      const normalized =
        normalizePath(
          file.fileName,
        );

      return (
        relative(file.fileName)
          .startsWith("src/") &&
        !isTestFile(
          file.fileName,
        ) &&
        !isProductionEntry(
          file.fileName,
        ) &&
        !productionReachable
          .has(normalized)
      );
    })
    .map((file) =>
      relative(file.fileName),
    )
    .sort();

const testOnlyModules =
  sourceFiles
    .filter((file) => {
      const normalized =
        normalizePath(
          file.fileName,
        );

      return (
        relative(file.fileName)
          .startsWith("src/") &&
        !productionReachable
          .has(normalized) &&
        allReachable
          .has(normalized)
      );
    })
    .map((file) =>
      relative(file.fileName),
    )
    .sort();

const duplicateFilesByHash =
  new Map();

for (
  const file of textFiles
) {
  const rel = relative(file);

  if (
    rel ===
      "package-lock.json" ||
    rel.endsWith(".map")
  ) {
    continue;
  }

  const content =
    fs.readFileSync(
      file,
      "utf8",
    );

  if (
    content.trim().length < 80
  ) {
    continue;
  }

  const hash =
    sha256(content);

  const group =
    duplicateFilesByHash
      .get(hash) ?? [];

  group.push(rel);

  duplicateFilesByHash
    .set(hash, group);
}

const exactDuplicateFiles =
  [
    ...duplicateFilesByHash
      .values(),
  ]
    .filter(
      (group) =>
        group.length > 1,
    )
    .sort(
      (a, b) =>
        a[0].localeCompare(
          b[0],
        ),
    );

const directRevalidatePath = [];
const adminClientInClientComponent = [];
const publicSignupCalls = [];
const dateRiskCandidates = [];

for (
  const sourceFile of
    sourceFiles
) {
  const rel =
    relative(
      sourceFile.fileName,
    );

  const content =
    sourceFile.getFullText();

  if (
    rel !==
      "src/lib/revalidate-business.ts" &&
    /\brevalidatePath\s*\(/
      .test(content)
  ) {
    directRevalidatePath
      .push(rel);
  }

  if (
    /^\s*["']use client["'];/m
      .test(content) &&
    /\bcreateAdminClient\b/
      .test(content)
  ) {
    adminClientInClientComponent
      .push(rel);
  }

  if (
    /\.auth\.signUp\s*\(/
      .test(content)
  ) {
    publicSignupCalls
      .push(rel);
  }

  if (
    rel !==
      "src/lib/lisbon-time.ts" &&
    (
      /\.toISOString\(\)\.slice\(0,\s*10\)/
        .test(content) ||
      /\.toISOString\(\)\.split\(["']T["']\)\[0\]/
        .test(content)
    )
  ) {
    dateRiskCandidates
      .push(rel);
  }
}

const dangerousArtifacts = [
  "supabase/APPLY_ALL.sql",
  "scripts/build-combined-sql.mjs",
  "CRIAR_PAGAMENTOS.sql",
  "src/app/api/seed-demo/route.ts",
].filter((rel) =>
  fs.existsSync(
    path.join(ROOT, rel),
  ),
);

const totalLines =
  textFiles.reduce(
    (sum, file) =>
      sum +
      fs.readFileSync(
        file,
        "utf8",
      ).split(/\r?\n/).length,
    0,
  );

const report = {
  generatedAt:
    new Date().toISOString(),
  root: ROOT,
  summary: {
    repositoryFiles:
      allFiles.length,
    textFiles:
      textFiles.length,
    sourceFiles:
      sourceFiles.length,
    textLines:
      totalLines,
    typescriptDiagnostics:
      diagnostics.length,
    productionEntries:
      productionEntries.length,
    unreachableProductionModules:
      unreachableProductionModules
        .length,
    exactDuplicateFileGroups:
      exactDuplicateFiles.length,
  },
  highConfidence: {
    dangerousArtifacts,
    adminClientInClientComponent,
    publicSignupCalls,
  },
  reviewRequired: {
    unreachableProductionModules,
    testOnlyModules,
    exactDuplicateFiles,
    directRevalidatePath:
      [
        ...new Set(
          directRevalidatePath,
        ),
      ].sort(),
    dateRiskCandidates:
      [
        ...new Set(
          dateRiskCandidates,
        ),
      ].sort(),
  },
  diagnostics,
};

const serialized =
  JSON.stringify(
    report,
    null,
    2,
  );

if (OUTPUT) {
  const absoluteOutput =
    path.resolve(
      ROOT,
      OUTPUT,
    );

  fs.mkdirSync(
    path.dirname(
      absoluteOutput,
    ),
    { recursive: true },
  );

  fs.writeFileSync(
    absoluteOutput,
    serialized + "\n",
    "utf8",
  );

  console.log(
    `Relatório gravado em ${relative(absoluteOutput)}`,
  );
} else {
  console.log(serialized);
}

const highConfidenceCount =
  dangerousArtifacts.length +
  adminClientInClientComponent.length +
  publicSignupCalls.length;

if (
  FAIL_ON_HIGH_CONFIDENCE &&
  (
    highConfidenceCount > 0 ||
    diagnostics.some(
      (diagnostic) =>
        diagnostic.category ===
          "Error",
    )
  )
) {
  process.exitCode = 1;
}
```

O auditor é uma base. Depois da primeira execução, deve ser ampliado com as categorias que aparecerem no repositório real.

# 52. PADRÃO OBRIGATÓRIO PARA O REGISTO DE CADA TASK

Cada task deve manter um ficheiro ou secção com os seguintes campos.

```md
# Task TXX — Nome

## Estado

- Planeada
- Em análise
- Em implementação
- Em revisão
- Em validação
- Standby
- Concluída

## Área

## Nota inicial

## Nota alvo

## Nota final

## Problema

## Causa comprovada

## Hipóteses ainda não confirmadas

## Impacto

## Arquivos envolvidos

## Funções envolvidas

## Componentes envolvidos

## Serviços envolvidos

## Tabelas envolvidas

## RPCs envolvidas

## Triggers envolvidos

## Policies envolvidas

## Migrations envolvidas

## Dependências

## Solução técnica

## Ordem de implementação

## Código adicionado

## Código alterado

## Código removido

## Código centralizado

## Código mantido

## Compatibilidade

## Integração com banco

## Integração com cache

## Integração com Realtime

## Integração com utilizadores ativos

## Riscos

## Mitigações

## Testes unitários

## Testes de integração

## Testes de concorrência

## Testes de regressão

## Smoke tests

## Rollback

## Standby

## Pendências

## Resultado alcançado

## Evidências

## Aprovação
```

Uma task não pode ser marcada como concluída apenas porque o código foi escrito.

---

# 53. REGRA PARA CÓDIGO COMPLETO

Sempre que uma task exigir código:

1. identificar o ficheiro;
2. mostrar imports adicionados;
3. mostrar imports removidos;
4. mostrar trecho atual;
5. mostrar início da substituição;
6. mostrar fim da substituição;
7. apresentar código completo;
8. explicar chamadas;
9. explicar tipos;
10. explicar erros;
11. explicar testes;
12. explicar integração;
13. explicar rollback.

Quando não for seguro apresentar um ficheiro completo:

- indicar âncora exata;
- indicar função;
- indicar linhas aproximadas;
- mostrar antes;
- mostrar depois;
- explicar por que o resto deve permanecer.

---

# 54. REGRA PARA MIGRATIONS

Toda migration deve conter:

- objetivo;
- pré-condições;
- objetos alterados;
- impacto;
- comportamento em dados existentes;
- transação;
- idempotência de DDL quando apropriado;
- grants;
- revokes;
- RLS;
- rollback;
- diagnóstico;
- rehearsal;
- checksum;
- compatibilidade;
- ordem de deploy.

É proibido:

- editar migration aplicada;
- aplicar checkpoint congelado;
- fazer `DROP ... CASCADE` em produção;
- usar seed operacional;
- aplicar migration juntamente com código consumidor sem confirmar ordem;
- confiar apenas em teste de string;
- ignorar schema real.

---

# 55. REGRA PARA TESTES DE CONCORRÊNCIA

Os seguintes cenários devem utilizar duas ligações reais:

## Revisão

- ligação A lê revisão 4;
- ligação B altera para 5;
- ligação A tenta gravar com 4;
- resultado: conflito;
- estado final: alteração B preservada.

## Idempotência

- A envia mutation X;
- timeout;
- A envia mutation X novamente;
- resultado: mesmo recibo;
- apenas uma mutação.

## Reutilização indevida

- A envia mutation X com payload 1;
- A envia mutation X com payload 2;
- resultado: conflito de hash.

## Ocorrência

- A e B geram o mesmo contrato;
- apenas uma ocorrência.

## Fatura

- A e B geram o mesmo período;
- apenas uma fatura.

## Pagamento

- A e B alteram o mesmo pagamento;
- revisão decide o vencedor;
- caixa permanece consistente.

---

# 56. REGRA PARA REALTIME

Realtime deve ser considerado concluído somente quando demonstrar:

- isolamento por empresa;
- sequência ordenada;
- evento duplicado seguro;
- evento antigo descartado;
- lacuna detetada;
- resync executado;
- reconexão;
- browser em background;
- duas abas;
- dois utilizadores;
- atualização do calendário;
- atualização do contrato;
- atualização do financeiro;
- atualização dos relatórios;
- nenhuma exposição cruzada.

---

# 57. REGRA PARA RELATÓRIOS

Todo relatório deve declarar:

- fonte;
- período;
- timezone;
- definição do indicador;
- estado da atualização;
- data da última atualização;
- filtros;
- tratamento de cancelados;
- tratamento de impostos;
- tratamento de avenças;
- tratamento de valores manuais;
- tratamento de pagamentos parciais;
- arredondamento;
- limites;
- erros.

Nenhum relatório pode chamar de “receita” um valor que não corresponda à definição indicada.

---

# 58. REGRA PARA LIMPEZA

## Prova mínima para remover um import

- ESLint;
- TypeScript;
- busca;
- build.

## Prova mínima para remover uma função

- zero referências;
- não exportada ou export sem consumidores;
- não usada dinamicamente;
- testes;
- build;
- smoke.

## Prova mínima para remover um componente

- zero imports;
- não é rota;
- não é carregado dinamicamente;
- não é registado por configuração;
- build;
- navegação.

## Prova mínima para remover um ficheiro SQL

- não é migration aplicada necessária;
- não é runbook;
- não é fixture;
- não é usado por script;
- não é necessário para recuperação;
- conteúdo arquivado quando histórico.

## Prova mínima para remover dependência

- zero imports;
- zero require;
- zero scripts;
- zero config;
- build;
- teste.

---

# 59. STANDBY

## Standby A — RPC completa de contratos

Depende de:

- schema real;
- triggers;
- functions;
- constraints;
- migrations;
- dados existentes;
- teste PostgreSQL.

## Standby B — RPC de pagamentos

Depende de:

- índice de caixa;
- revisão em serviços;
- regras de sinal;
- regras de valor manual;
- compatibilidade com avença.

## Standby C — Geração atómica de fatura

Depende de:

- regra de proporcionalidade;
- regra fiscal;
- numeração;
- notas de crédito;
- contratos alterados após rascunho.

## Standby D — Realtime

Depende de:

- migration reconciliada;
- canal;
- duas sessões;
- resync;
- tipos.

## Standby E — Remoção efetiva

Depende do auditor e build.

## Standby F — Nota final

Depende de evidências.

## Standby G — Ferramenta externa

Qualquer ferramenta não disponível deve ser registada com:

- necessidade;
- alternativa gratuita;
- bloqueio;
- impacto;
- tarefa dependente.

---

# 60. RESULTADO ALCANÇADO ATÉ ESTE DOCUMENTO

## Concluído

- reavaliação dos 96 ficheiros relacionados;
- separação do estado da atomicidade;
- identificação das RPCs prontas;
- identificação das RPCs congeladas;
- identificação do bloqueio de contratos;
- arquitetura central;
- ordem de execução;
- tasks;
- padrão de desenvolvimento;
- padrão de PR;
- padrão de migration;
- padrão de concorrência;
- padrão de Realtime;
- padrão de limpeza;
- notas;
- riscos;
- standbys;
- códigos iniciais;
- migration inicial;
- motor de recorrência corrigido;
- distribuição de avença;
- revalidação central;
- action result;
- auditor.

## Não concluído

- checkout integral;
- execução do auditor;
- classificação real de 100%;
- alteração do repositório;
- branch;
- commits;
- PR;
- lint;
- typecheck;
- testes;
- build;
- migrations;
- staging;
- deploy;
- validação de produção.

## Regra de honestidade

Nenhuma nota deve ser artificialmente elevada.

Uma área só alcança nota 7 ou superior quando:

- implementação aplicada;
- testes aprovados;
- integração validada;
- risco mitigado;
- regressão ausente;
- documentação atualizada;
- funcionamento conjunto comprovado.

---

# 61. FRASE FINAL OFICIAL

> A solução de atomicidade não está por começar. Ela já possui uma fundação forte e RPCs de boa qualidade, mas está fragmentada entre schema parcial, checkpoints congelados, código de branch e migrations ainda não aplicadas. Clientes e estado de fatura estão próximos de uma solução correta; contratos, calendário, geração de faturas e Realtime ainda não estão transacionais de ponta a ponta. A branch inteira não deve ser mesclada, aplicada ou publicada. O trabalho deve ser extraído em pequenas entregas a partir do `master` atual, seguindo a arquitetura, a ordem de tasks e as regras definidas neste documento.

---

# 62. AUTORIZAÇÃO RECOMENDADA PARA INICIAR A EXECUÇÃO

```text
Crie uma branch nova a partir do master atual.

Implemente as Tasks T00, T01, T02 e T03.

Faça commits separados por task.

Abra um PR draft.

Não faça merge.

Não faça deploy.

Não execute migrations.

Não altere produção.

Apresente os testes reais executados, todos os ficheiros alterados, todos os ficheiros removidos, os riscos e o rollback.
```

---

# 63. CHECKLIST FINAL DO PROJETO

## Inventário

- [ ] 100% dos ficheiros inventariados
- [ ] 100% das linhas contabilizadas
- [ ] entradas Next.js identificadas
- [ ] imports dinâmicos identificados
- [ ] scripts identificados
- [ ] dependências externas identificadas

## Limpeza

- [ ] imports não usados removidos
- [ ] variáveis não usadas removidas
- [ ] funções mortas removidas
- [ ] duplicações centralizadas
- [ ] módulos inalcançáveis revistos
- [ ] ficheiros obsoletos removidos
- [ ] documentos arquivados
- [ ] dependências não usadas removidas
- [ ] artefactos perigosos removidos

## Segurança

- [ ] profiles protegidos
- [ ] company isolada
- [ ] role protegida
- [ ] campos laborais protegidos
- [ ] service role restrita
- [ ] policies revistas
- [ ] grants revistos
- [ ] triggers revistos

## Recorrência

- [ ] motor canónico
- [ ] preview canónico
- [ ] cron canónico
- [ ] vários meses
- [ ] dias 29/30/31
- [ ] fevereiro
- [ ] ano bissexto
- [ ] DST
- [ ] contrato antigo
- [ ] exclusões
- [ ] exceções

## Contratos

- [ ] revision
- [ ] mutation ID
- [ ] RPC
- [ ] local e contrato juntos
- [ ] ocorrências juntas
- [ ] pausa
- [ ] cancelamento
- [ ] reativação
- [ ] snapshot
- [ ] auditoria
- [ ] outbox

## Calendário

- [ ] ocorrência única
- [ ] referência transacional
- [ ] reschedule atómico
- [ ] conflito
- [ ] exceção manual
- [ ] Realtime
- [ ] cache

## Faturação

- [ ] pagamento atómico
- [ ] caixa atómico
- [ ] estado da fatura atómico
- [ ] fatura e itens atómicos
- [ ] número seguro
- [ ] avença sem serviço
- [ ] proporcionalidade
- [ ] retry
- [ ] concorrência

## Relatórios

- [ ] conceitos separados
- [ ] erros tratados
- [ ] absentismo por interseção
- [ ] avenças presentes
- [ ] diário
- [ ] mensal
- [ ] faturado
- [ ] recebido
- [ ] custos
- [ ] margem
- [ ] exportação coerente

## Realtime

- [ ] outbox ligado
- [ ] sequência
- [ ] canal privado
- [ ] última sequência
- [ ] lacuna
- [ ] resync
- [ ] reconexão
- [ ] duas empresas
- [ ] duas sessões
- [ ] eventos duplicados

## Testes

- [ ] lint sem warnings
- [ ] typecheck
- [ ] unit
- [ ] integration
- [ ] concurrency
- [ ] RLS
- [ ] migrations
- [ ] Realtime
- [ ] regression
- [ ] build
- [ ] smoke
- [ ] rollback

## Resultado

- [ ] todas as áreas com nota mínima 7
- [ ] evidências anexadas
- [ ] documentação atual
- [ ] nenhuma funcionalidade retirada
- [ ] nenhuma alteração isolada
- [ ] arquitetura central respeitada

