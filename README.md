# Mó Limpezas — Plataforma de Gestão Operacional

> **Este repositório contém apenas o planeamento.** Nenhum código foi escrito ainda.  
> Cada vez que voltar a discutir a ideia, leia este repositório para retomar de onde parou.

---

## O que é isto?

Uma plataforma web + mobile para gerir uma empresa de limpeza em equipa — baseada nas funcionalidades do ServiSync, adaptada para a **Mó Limpezas**.

A plataforma resolve os problemas diários de uma empresa com múltiplas equipas, múltiplos locais e serviços recorrentes:

- Saber **onde está cada equipa** a cada hora do dia
- **Gerir horários e agendamentos** sem esquecer nada
- Dar aos colaboradores acesso à **escala no telemóvel**
- Controlar **presenças, férias e faltas** automaticamente
- Ter uma visão **financeira completa**: receitas, custos, margens
- **Gerar faturas** e fechar o mês sem Excel

---

## Índice de Documentação

| Ficheiro | Conteúdo |
|----------|----------|
| [docs/01-features.md](docs/01-features.md) | Todas as funcionalidades detalhadas |
| [docs/02-tech-stack.md](docs/02-tech-stack.md) | Tecnologias escolhidas e justificação |
| [docs/03-database-schema.md](docs/03-database-schema.md) | Esquema completo da base de dados |
| [docs/04-costs.md](docs/04-costs.md) | Custos mensais e de setup |
| [docs/05-roadmap.md](docs/05-roadmap.md) | Fases de desenvolvimento e timeline |
| [docs/06-difficulty.md](docs/06-difficulty.md) | O que Claude faz vs o que o user faz |
| [docs/07-financial-module.md](docs/07-financial-module.md) | Especificação do módulo financeiro |
| [wireframes/screens.md](wireframes/screens.md) | Descrição dos ecrãs principais |

---

## Stack Tecnológica (Resumo)

```
Frontend:   Next.js 15 + TypeScript + Tailwind CSS + shadcn/ui
Backend:    Supabase (PostgreSQL + Auth + Realtime + Storage)
Calendário: FullCalendar (React)
Mapas:      Mapbox GL JS
Mobile:     PWA (Fase 1) → React Native + Expo (Fase 2 opcional)
Deploy:     Vercel
```

---

## Custo Mensal Estimado

| Fase | Custo/mês |
|------|-----------|
| Desenvolvimento / Teste | €0 (tiers gratuitos) |
| Produção (pequena escala) | ~€24–74/mês |
| Produção (escala média) | ~€100–150/mês |

---

## Estado Atual do Projeto

- [x] Definição de funcionalidades
- [x] Escolha da stack tecnológica
- [x] Esquema da base de dados (draft)
- [x] Roadmap de desenvolvimento
- [x] Módulo financeiro definido
- [x] Fluxos operacionais confirmados (calendário, app, substituições, relatórios)
- [x] Identidade do produto: **Escala**, cor verde `#16A34A`
- [ ] Sub. férias/natal: junho/novembro ou diluído? ← pendente (menor)
- [ ] Horas extra: acréscimo percentual? ← pendente (menor)
- [ ] Início do desenvolvimento ← **PRÓXIMO PASSO**

---

## Decisões Principais Tomadas

Ver [docs/08-decisions-log.md](docs/08-decisions-log.md) para o registo completo de todas as decisões.

| Tema | Decisão |
|------|---------|
| Produto | **Escala** — verde `#16A34A`, multi-empresa desde o início (`company_id`) |
| Colaboradores | Funcionários com contrato, mesmo valor hora para todos |
| Sub. alimentação | Transferência no salário — `dias × €9,60` configurável |
| Faturação | Por serviço, IVA 23%, contabilista emite a fatura legal |
| Calendário | Contratos Fixos + Serviços Pontuais. Editar = só aquela ocorrência. |
| App mobile | Core do sistema — relógio de ponto GPS (Registar Entrada / Saída) |
| Notificações | Push na app (principal) + Email (fallback) |
| Substituições | Gestor escolhe da lista → notifica. Sem cobertura = alerta ao gestor. |

## Perguntas Menores em Aberto

1. **Sub. férias/natal:** Pagos em junho/novembro (padrão PT) ou diluídos mensalmente?
2. **Horas extra:** Existe acréscimo percentual além do contratado?

---

## Como retomar este projeto

1. Leia este README
2. Veja o estado em "Estado Atual do Projeto" acima
3. Leia os docs relevantes para a sessão
4. Continue a partir das perguntas em aberto

---

*Última atualização: 2026-06-02*
