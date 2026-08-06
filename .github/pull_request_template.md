## Task

- **ID:**
- **Área:**
- **Nota antes:**
- **Nota pretendida:**

## Problema

## Causa

## Escopo

### Ficheiros

-

### Funções / componentes

-

### Tabelas / RPCs / migrations

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
- [ ] Mantém isolamento entre empresas
- [ ] Mantém exceções (`is_exception`) e histórico fechado
- [ ] Não cria regra duplicada

## Concorrência

- [ ] `expected_revision`
- [ ] `mutation_id` reutilizado em retries
- [ ] Constraint na base
- [ ] Teste concorrente

> Marcar `n/a` quando a alteração não escreve na base.

## Cache e Realtime

- [ ] Revalidação pelo helper central
- [ ] Outbox
- [ ] Snapshot autoritativo devolvido
- [ ] Recuperação de lacunas

## Validação

- [ ] `git diff --check`
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Regressão
- [ ] Integração
- [ ] Isolamento
- [ ] Smoke test da área

## Riscos

-

## Rollback

-

## Resultado

- **Nota:**
- **Evidências:**

---

- [ ] Li a **REGRA ZERO** em `AGENTS.md`
- [ ] Esta PR **não** faz deploy, não aplica migrations e não altera produção
