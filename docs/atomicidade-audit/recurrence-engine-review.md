# Revisão do motor canónico de recorrência

Status: correção local confirmada; ainda não prova publicação.

## Defeito corrigido

A implementação mensal anterior calculava somente o mês de início do intervalo. Como a geração pedia vários meses, um contrato mensal podia produzir apenas uma ocorrência.

## Implementação

- motor puro em `src/domain/scheduling/recurrence-engine.ts`;
- wrapper de compatibilidade em `src/lib/contract-occurrences.ts`;
- preview do formulário usa o mesmo motor;
- fluxos existentes herdam a correção pelo import canónico.

## Testes

Os testes cobrem:

- mensal em vários meses;
- semanal, quinzenal e três em três semanas;
- personalizado e diário;
- exclusões, ordenação e ausência de duplicados;
- transições horárias de março/outubro em Portugal;
- preview por contagem.

## Limitação restante

O motor e alguns chamadores ainda usam `Date`. A próxima correção deve representar datas civis sem depender do fuso do processo e executar a suíte em UTC e Lisboa.

## Fora de alcance desta correção

- atomicidade de contrato/serviços;
- outbox e Realtime;
- reconciliação do schema;
- aplicação de migrations.

Os checkpoints de atomicidade permanecem congelados e protegidos pela política de migrations.
