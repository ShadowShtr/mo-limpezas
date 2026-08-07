# Padrão de Engenharia — Mó Limpezas

Este documento define como qualquer funcionalidade, correção, refatoração,
migration ou limpeza deve ser implementada neste repositório.

É **canónico**: quando outro documento contradisser este, este prevalece — com
uma única exceção, a **REGRA ZERO** de [`../AGENTS.md`](../AGENTS.md), que está
acima de tudo o resto.

Origem: Task T01 do [plano mestre](PLANO-MESTRE.md).

---

## 1. Prioridades

Por esta ordem, sempre:

1. Não interromper utilizadores ativos.
2. Preservar integridade e isolamento entre empresas.
3. Manter compatibilidade entre código e base de dados.
4. Evitar múltiplas fontes da mesma regra.
5. Preferir alterações pequenas, reversíveis e testáveis.

Quando duas prioridades colidem, ganha a de número mais baixo.

## 2. Estrutura

| Diretório | Responsabilidade |
|---|---|
| `src/domain` | Regras puras. Sem I/O, sem Supabase, sem React. Testáveis isoladamente. |
| `src/application` | Casos de uso — orquestram domínio e infraestrutura. |
| `src/infrastructure` | Acesso a dados e serviços externos. |
| `src/app/actions` | Adaptadores finos entre a interface e os casos de uso. |
| `src/components` | Apresentação. Não calcula regras de negócio. |
| `src/lib` | Utilitários partilhados e helpers centrais. |
| `supabase/migrations` | **Append-only.** |

A migração para esta estrutura é incremental (secção 17 do plano mestre): regras
novas nascem aqui; regras antigas migram quando a área for alterada; wrappers
preservam compatibilidade e são removidos quando não houver referências.

## 3. Server Actions

Uma Server Action deve, por esta ordem:

1. autenticar;
2. validar a entrada;
3. chamar um caso de uso ou uma RPC;
4. mapear o resultado para o formato padrão;
5. revalidar cache através do helper central;
6. devolver o snapshot autoritativo ou um erro com código estável.

É proibido numa Server Action:

- implementar recorrência;
- duplicar cálculo financeiro;
- fazer compensação manual de escritas parciais;
- gerar números de documento por contagem;
- implementar autorização alternativa à central;
- devolver ao utilizador a mensagem de erro crua do Supabase.

### Formato do resultado

Uma action devolve `ActionResult<T>` de [`../src/lib/action-result.ts`](../src/lib/action-result.ts).
É a **única** fonte deste formato — não criar um segundo.

```ts
if (resultado.ok) {
  // resultado.data
} else {
  // resultado.error.code    → para decidir
  // resultado.error.message → para mostrar
  // resultado.error.fieldErrors → opcional, para assinalar campos
}
```

A mensagem é para ler; o **código** é para decidir. Ramificar por texto de
mensagem torna a interface refém da redação.

Falhas técnicas passam por `internalFailure(contexto, causa)`: o detalhe real
vai para o log do servidor e o utilizador recebe uma mensagem genérica. Nomes
de tabelas, colunas e restrições nunca chegam ao ecrã.

### Adoção gradual

As actions migram **uma área de cada vez**, nunca todas de uma vez, e nunca
numa PR que também mude comportamento. Por migração:

1. inventariar os consumidores (componentes, toasts, redirecionamentos, testes);
2. migrar a action e os seus consumidores na **mesma** PR;
3. preservar as mensagens de negócio — o utilizador não deve notar a mudança;
4. só usar adaptador de compatibilidade se uma action tiver consumidores que
   não caibam na PR; marcá-lo como temporário e registá-lo para remoção.

Enquanto houver actions por migrar, os dois formatos coexistem. Isso é
esperado e temporário — o que não pode acontecer é nascer um terceiro.

| Área | Estado |
|---|---|
| `saveCompanySettings` | ✅ migrada (piloto, T05) |
| Restantes actions | formato antigo, a migrar por área |

## 4. Base de dados

- migrations são **append-only**;
- nunca editar uma migration já aplicada — corrige-se com uma nova;
- escrita em múltiplas tabelas exige uma RPC transacional;
- a RPC recebe `company_id`, ator, `mutation_id` e `expected_revision`;
- a RPC valida o ator dentro da própria transação, nunca confia no cliente;
- auditoria e outbox gravam **dentro** da transação;
- o código consumidor só entra depois de o objeto existir na base.

## 5. Concorrência

- `expected_revision` é obrigatória em entidades editáveis;
- o `mutation_id` nasce na interface e é reutilizado em retries;
- conflito de revisão **nunca** é convertido em sucesso;
- a garantia final é uma constraint na base, não uma consulta prévia.

## 6. Datas

- datas de negócio usam `Europe/Lisbon` (`src/lib/lisbon-time.ts`);
- recorrência é data civil, não instante
  (`src/domain/scheduling/civil-date.ts`);
- a regra de recorrência vive **só** em
  `src/domain/scheduling/recurrence-engine.ts` — nenhum consumidor, preview ou
  cron pode recalcular datas por sua conta;
- aritmética de calendário nunca por milissegundos: somar `7 * 24 * 3600 *
  1000` desloca-se com o horário de verão;
- timestamps gravados com offset correto;
- é proibido decidir "hoje" com `new Date()` no servidor — o processo corre em
  UTC na Vercel.

## 7. Valores

- o valor do serviço vem de um módulo central;
- a distribuição da avença mensal vem de um módulo central;
- relatórios separam os conceitos (contratado, agendado, realizado, faturado,
  recebido, em aberto, vencido, custo, margem);
- componentes apresentam, não recalculam.

## 8. Cache e Realtime

- revalidação passa pelo helper central;
- mutações publicam no outbox;
- eventos têm sequência por empresa;
- uma lacuna na sequência obriga a resync;
- o cliente reconcilia com o snapshot autoritativo, não com estado local.

## 9. Erros

- verificar sempre o `error` de qualquer consulta;
- uma falha **não** é uma lista vazia;
- códigos de erro estáveis, mensagens legíveis;
- nunca expor segredos, chaves ou dados de outra empresa.

## 10. Limpeza

Remover só depois de verificar, por esta ordem:

1. imports;
2. referências estáticas em todo o repositório;
3. convenções automáticas do Next.js;
4. imports dinâmicos e `require`;
5. utilização em testes;
6. smoke test da área afetada.

`npm run audit:code` produz os candidatos. Candidato não é prova — ver
[`code-audit/README.md`](code-audit/README.md).

## 11. Testes

| Tipo | Prova |
|---|---|
| Unitário | A regra pura está correta. |
| Regressão | O bug corrigido não volta. |
| Integração | O código e a base concordam. |
| Concorrência | Duas sessões em simultâneo não corrompem estado. |
| Isolamento | Uma empresa não vê nem altera dados de outra. |

Um teste que procura uma string num ficheiro SQL não prova que a função existe
na base, nem que funciona. Testes estáticos são úteis como guarda, nunca como
evidência de comportamento.

## 12. Pull Requests

Cada PR apresenta: problema, causa, escopo, ficheiros, tabelas, alterações,
removidos, mantidos, standby, riscos, testes executados, rollback e nota da área.

O template em [`../.github/pull_request_template.md`](../.github/pull_request_template.md)
é obrigatório.

## 13. Definition of Done

```bash
git diff --check
npm run quality    # typecheck + lint:strict + test + build
```

`npm run quality` **não** corre o auditor — `npm run audit:code` é uma
ferramenta de inventário. Mas `npm run audit:code:strict` faz parte do gate:
corre no CI, e falha se aparecer um risco de confiança alta.

### O que corre automaticamente

`.github/workflows/quality.yml` corre em cada pull request, sem segredos:

```text
npm ci
npm run typecheck
npm run lint:strict
npm test
npm run audit:code:strict
```

`npm run build` fica **fora** do CI: o `prebuild` valida variáveis de ambiente
reais, e é essa ausência que permite o workflow não ter segredo nenhum. A
Vercel continua a construir cada pull request — o build está coberto, noutro
sítio.

Correr `npm run quality` localmente antes de abrir a PR continua a ser a
Definition of Done; o CI é a rede, não a substituição.

### Relatório de auditoria versionado

`reports/code-audit.json` é um inventário versionado e o CI nunca o reescreve —
compara-o com a árvore e falha se divergirem.

Qualquer PR que altere o que o auditor contabiliza (ficheiros novos ou
apagados, linhas de texto — **incluindo documentação**) tem de terminar com:

```bash
npm run audit:code:json
```

Isto é das **últimas** operações antes dos gates finais: se a PR ainda
acrescentar documentação depois de regenerar, o relatório volta a ficar
desatualizado e é preciso regenerar outra vez.

O PR #44 mostrou o custo de saltar este passo: acrescentou um documento sem
regenerar o relatório e deixou o `master` vermelho. Só não se viu logo porque
o CI desse merge nem chegou a arrancar — o runner não foi adquirido — e a
quebra ficou escondida até à execução seguinte.

Mais: sem warnings novos, sem alterações não relacionadas, plano de rollback
escrito e — quando a alteração toca produção — autorização explícita do dono na
conversa atual.

Quando houver base de dados envolvida, acrescenta-se:

```text
migration review
rollback rehearsal
duas ligações em simultâneo
teste de isolamento
backup
plano de rollback
```
