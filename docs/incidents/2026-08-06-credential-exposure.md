# Incidente de credenciais — 2026-08-06

> Documento público e sanitizado. Não contém, e nunca deve conter, chaves,
> tokens, senhas, connection strings, project refs, identificadores de
> utilizador, endereços de email pessoais ou endereços IP. Só quantidades,
> tipos, nomes de variáveis, datas, commits e estados.

## 1. Estado

Incidente identificado num repositório público.

A árvore atual foi limpa e recebeu um scanner preventivo, mas a remoção dos
valores do código **não revoga** credenciais que já foram publicadas no
histórico.

O incidente só pode ser considerado encerrado após a rotação, revogação e
revisão operacional descritas neste documento.

## 2. Período de exposição conhecido

Primeira exposição identificada:

- 2026-06-03

Data da identificação e resposta:

- 2026-08-06

O repositório permaneceu público durante o período analisado.

## 3. Classes de credenciais expostas

Foram identificadas três classes independentes:

1. chave secreta privilegiada do Supabase;
2. token pessoal do Supabase;
3. senha da base de dados Postgres.

Também foram encontradas senhas por omissão utilizadas por scripts de criação
de contas.

Nenhum valor é reproduzido neste documento.

## 4. Presença no histórico público

Resultados sanitizados da análise:

| Classe | Commits identificados |
|---|---:|
| Chave secreta privilegiada | 4 |
| Senha Postgres | 4 |
| Token pessoal | 2 |

A remoção da árvore atual não elimina os valores de commits antigos, clones,
caches ou indexações externas.

## 5. Correções já concluídas no código

Merge de segurança:

- PR #43
- head validado: `77b73bc`
- merge no master: `abbaefda`

Concluído:

- script administrativo com credenciais removido;
- credenciais redigidas dos documentos atuais;
- senhas por omissão removidas dos scripts;
- uso obrigatório de `SEED_PASSWORD` e `SEED_EMAIL`;
- fixtures reais substituídas por valores sintéticos;
- scanner de segredos criado;
- scanner integrado ao CI antes dos testes;
- scanner configurado para não imprimir valores;
- análise de todos os ficheiros de texto versionados;
- binários ignorados por conteúdo;
- validação de marcadores aplicada apenas ao valor capturado;
- allowlists genéricas removidas;
- testes contra bypass adicionados.

Estado da árvore no momento do registo:

- `npm run secrets:scan`: zero achados;
- 464 ficheiros de texto analisados;
- CI verde no SHA `77b73bc`;
- master limpo após `abbaefda`.

## 6. Superfície da chave privilegiada

A chave é fornecida exclusivamente através da variável:

`SUPABASE_SERVICE_ROLE_KEY`

Consumidores mapeados:

- 1 ponto de entrada no runtime da aplicação;
- 20 scripts administrativos ou operacionais.

Não existem cópias literais atuais da chave.

Atualizar a variável cobre os consumidores, mas os ambientes devem ser tratados
separadamente:

- Vercel Production;
- Vercel Preview;
- Vercel Development;
- `.env.local`;
- máquinas ou processos que executem os scripts.

Um build verde de Preview **não prova** que a chave está configurada, porque o
build de Preview pode continuar com variáveis ausentes. É obrigatória uma
operação administrativa real de validação.

## 7. Superfície da senha Postgres

Variáveis aceites:

- `SUPABASE_DB_URL`;
- `DATABASE_URL`, apenas como fallback.

Consumidores mapeados:

- `scripts/run-migrations.mjs`;
- `scripts/restore-from-history.mjs`.

Estas variáveis são necessárias apenas nos ambientes de operadores que executam
migrations ou restauros.

Não devem ser adicionadas à Vercel sem um consumidor real.

Após a alteração da senha, o teste seguro é:

```bash
set -a
. ./.env.local
set +a

echo "$NEXT_PUBLIC_SUPABASE_URL"
node scripts/run-migrations.mjs
```

As duas variáveis devem estar presentes:

- `NEXT_PUBLIC_SUPABASE_URL`;
- `SUPABASE_DB_URL` ou `DATABASE_URL`.

O resultado esperado deve identificar visualmente o projeto correto, o host
correto e o modo dry-run.

Executar sem argumentos. Não utilizar `--apply`.

## 8. Contas criadas com senha por omissão

Foram identificadas três contas:

| Quantidade | Papel |
|---:|---|
| 2 | administradores |
| 1 | colaborador |

Os identificadores completos são mantidos fora do repositório público.

As duas contas administrativas utilizam endereços locais não entregáveis e não
conseguem receber recuperação por email.

Tratamento necessário:

- alterar a senha diretamente no painel ou bloquear as contas;
- encerrar sessões;
- não apagar antes de analisar relações e referências;
- tratar a conta pessoal separadamente e confirmar a troca com a pessoa
  legítima.

## 9. Estado operacional pendente

| Item | Estado |
|---|---|
| Chave secreta antiga eliminada | Pendente |
| Chave nova instalada e testada | Pendente |
| Token pessoal revogado | Pendente |
| Senha Auth e sessões tratadas | Pendente |
| Três contas identificadas | Concluído |
| Contas alteradas ou bloqueadas | Pendente |
| Senha Postgres confirmada como senha da base | Concluído |
| Consumidores da senha Postgres mapeados | Concluído |
| Senha Postgres alterada | Pendente |
| Variáveis locais atualizadas | Pendente |
| Dry-run aprovado | Pendente |
| Logs desde 2026-06-03 revistos | Pendente |

Não marcar nenhum item como concluído sem evidência operacional do
proprietário.

## 10. Ordem obrigatória de encerramento

1. criar uma nova chave secreta;
2. atualizar todos os ambientes consumidores;
3. fazer novos deployments;
4. testar uma operação administrativa em Production;
5. testar uma operação administrativa em Preview;
6. testar uma operação administrativa local;
7. eliminar a chave antiga;
8. revogar o token pessoal;
9. alterar a senha Postgres;
10. atualizar as variáveis dos operadores;
11. executar o dry-run sem escrita;
12. alterar ou bloquear as três contas;
13. encerrar as sessões dessas contas;
14. rever os registos desde 2026-06-03;
15. decidir sobre visibilidade e limpeza do histórico.

A limpeza do histórico nunca substitui a rotação.

## 11. Revisão dos registos

Período mínimo:

- 2026-06-03 até 2026-08-06;
- prolongar até à data efetiva da rotação.

Rever:

- operações administrativas de Auth;
- criação, alteração e exclusão de utilizadores;
- mudanças de senha;
- alterações em perfis;
- mudanças de empresa ou papel;
- configurações da empresa;
- contratos;
- serviços;
- faturas;
- pagamentos;
- horários e volumes anormais;
- IPs desconhecidos;
- operações entre empresas.

Preservar evidências antes de qualquer limpeza.

## 12. Estado do plano mestre

Enquanto o incidente não estiver encerrado:

- T07 permanece parada;
- migration 070 não pode ser aplicada;
- base descartável ainda precisa ser criada;
- ensaio 12/12 não foi executado;
- ensaio 36/36 não foi executado;
- smoke T05/T06 não foi executado;
- nenhuma task funcional nova deve ser iniciada.

## 13. Ponto de retomada

Depois do encerramento documentado do incidente:

1. criar projeto Supabase descartável;
2. configurar ambiente de ensaio separado;
3. aplicar migrations 001–070 apenas na base descartável;
4. executar a verificação 12/12;
5. executar o ensaio de rollback 36/36;
6. executar o smoke T05/T06;
7. guardar evidências;
8. solicitar autorização separada para aplicar a 070 em produção;
9. somente depois iniciar T07.

## 14. Critério de encerramento

O incidente só será encerrado quando existir confirmação objetiva de:

```text
chave antiga eliminada:
nova chave instalada e testada:
token pessoal revogado:
contas Auth tratadas e sessões encerradas:
senha Postgres alterada:
variáveis dos operadores atualizadas:
dry-run aprovado:
logs revistos:
anomalias encontradas:
medidas tomadas:
responsável:
data/hora:
```

Não guardar valores de credenciais neste registo.

## 15. Registo lateral — falha de infraestrutura do CI (2026-08-06)

Não faz parte do incidente de credenciais. Registado aqui apenas para que a
falha não seja confundida com regressão de código durante a resposta.

| Campo | Valor |
|---|---|
| SHA | `bb0ee3c` (merge do PR #44 no master) |
| Estado | Falha de infraestrutura |
| Sintoma | GitHub-hosted runner não adquirido |
| Fase da falha | `Set up job`, antes do primeiro step do workflow |

Nada do repositório chegou a correr:

| Etapa | Executada |
|---|---|
| Checkout | não |
| `npm ci` | não |
| `secrets:scan` | não |
| typecheck | não |
| lint | não |
| testes | não |
| auditoria | não |

Contexto:

- último CI completo conhecido: SHA `77b73bc` — sucesso;
- alterações entre `77b73bc` e o merge do #44: documentação sanitizada,
  nenhuma alteração funcional;
- o PR #44 adicionou um único ficheiro e não tocou no workflow, nas
  dependências nem em código executável;
- `.github/workflows/quality.yml` usa `runs-on: ubuntu-latest`; o primeiro
  step real é `Checkout`;
- o mesmo sintoma ocorreu nos merges dos PRs #41 e #42.

Decisão:

- não modificar o workflow por causa desta falha;
- não alterar `runs-on`, timeouts, `actions/checkout`, `actions/setup-node`,
  versão de Node ou cache;
- não introduzir self-hosted runner nem outro sistema operativo — seria
  mascarar uma falha externa com complexidade permanente;
- reexecutar o workflow quando houver hosted runner disponível.

Critério de recuperação: se a execução entrar no step `Checkout`, o problema
de provisionamento terminou e o resultado volta a ter valor como CI do
código.

Verificação local entretanto disponível (não substitui o CI):
`npm run secrets:scan` na árvore de `bb0ee3c` — 465 ficheiros analisados,
zero achados.
