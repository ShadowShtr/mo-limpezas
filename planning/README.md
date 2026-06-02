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


## Passos
FASE 1 — Fundação
Bloco 1.1 — Setup
2. Reorganizar repo: mover docs/wireframes/README para pasta planning/
3. Inicializar Next.js 15 + TypeScript na raiz do repo mo-limpezas
4. Instalar Tailwind CSS v4 + shadcn/ui com tema verde #16A34A
5. Instalar Supabase (@supabase/supabase-js + @supabase/ssr) e criar lib/supabase/
6. Criar .env.local + .gitignore + verificar deploy automático no Vercel

Bloco 1.2 — Base de Dados
7. Migration: companies + company_settings (company_id em todas as tabelas)
8. Migration: profiles (colaboradores, roles, contrato, valor hora, skills)
9. Migration: clients + locations (GPS, código acesso, preço/hora)
10. Migration: teams + team_members
11. Migration: contracts (array [{dia, hora, duracao, equipa_id}] por dia)
12. Migration: services + service_reinforcements (reference_number sequencial) + service_price_audit
13. Migration: timesheets + absences + vacation_requests
14. Migration: invoices + invoice_items + payroll_records
15. Migration: notifications + push_subscriptions
16. Configurar RLS policies por role + trigger criar profile no registo
17. Criar seed.sql: 1 empresa, 3 equipas, 6 colaboradores, 5 clientes, 10 locais

Bloco 1.3 — Autenticação
18. Página /login (email + password) + recuperação de password para gestores
19. Magic link para colaboradoras + fluxo de convite (gestor cria → email enviado automaticamente)
20. Middleware Next.js: proteger rotas /dashboard/* e /app/* por role
21. Ecrã de primeiro acesso da colaboradora: boas-vindas + instruções para instalar PWA

Bloco 1.4 — Layout e Navegação
22. Dashboard operacional /dashboard: visão do dia (serviços hoje, sem cobertura, alertas, colaboradoras no terreno)
23. Centro de notificações: sino no header com lista de alertas recentes (sem cobertura, fora do raio GPS, clock-out em falta)
24. Sidebar: navegação completa + Header: avatar, nome, sino de notificações, logout
25. Layout /dashboard: sidebar + header + conteúdo + loading skeletons + 404

Bloco 1.5 — CRUD Colaboradores
26. Página /colaboradores: tabela, pesquisa, filtros, paginação
27. Sheet criar/editar colaborador: todos os campos + upload foto + gestão de skills + reenviar convite
28. Detalhe do colaborador: histórico de presenças, férias, pagamentos + exportação PDF
29. Inicialização de saldo de férias: campo editável por colaborador para definir saldo inicial ao arrancar o sistema

Bloco 1.6 — CRUD Clientes
30. Página /clientes: tabela, pesquisa + sheet criar/editar + histórico de serviços ao clicar

Bloco 1.7 — CRUD Locais
31. Página /locais: tabela + sheet com geocoding morada → GPS + histórico de serviços do local

Bloco 1.8 — CRUD Equipas
32. Página /equipas: cards com cor + sheet criar/editar + selector de membros + vista de disponibilidade semanal
33. ✅ Commit + push Fase 1 completa → verificar deploy Vercel

FASE 2 — Calendário e Agendamento
Bloco 2.1 — Contratos Fixos
34. Página /contratos: lista de contratos fixos ativos com cliente, equipa e padrão
35. Formulário criar/editar contrato: local, padrão recorrente, equipa diferente por dia da semana
36. Preview de próximas ocorrências + pausar/reativar/cancelar contrato

Bloco 2.2 — Calendário Base
37. Instalar dnd-kit + date-fns para o calendário personalizado
38. Construir componente calendário: CSS Grid com colunas por equipa e linhas por hora (07h–22h)
39. Renderizar serviços como blocos coloridos por estado + navegação entre semanas (passado e futuro)

Bloco 2.3 — Criar e Gerir Serviços
40. Clicar em célula vazia → formulário rápido + cálculo automático de preço + reforços avulso
41. Painel lateral ao clicar no serviço: detalhes completos + editar + cancelar + ver clock-ins + referência #0042
42. Gestão de estado pelo gestor: cancelar serviço, marcar como falta, fechar clock-out esquecido com hora correta

Bloco 2.4 — Interações no Calendário
43. Drag & drop: reagendar (só aquela ocorrência) + drag horizontal muda equipa
44. Deteção e alerta visual de conflito de horário na mesma equipa

Bloco 2.5 — Geração Automática
45. Supabase Edge Function: gerar ocorrências do mês seguinte a partir dos contratos fixos
46. Cron dia 25 + alerta ao gestor se houver conflitos gerados + notificação no centro de alertas
47. ✅ Commit + push Fase 2 completa

FASE 3 — App da Colaboradora (PWA)
Bloco 3.1 — Layout Mobile
48. Layout mobile /app/*: bottom navigation (Home, Escala, Perfil) + deteção automática mobile vs desktop

Bloco 3.2 — Ecrãs da Colaboradora
49. Ecrã Home: serviços do dia em ordem cronológica com estado visual
50. Ecrã detalhe: morada, hora, instruções, código acesso, colegas + botão Navegar (Google Maps)
51. Ecrã escala semanal pessoal + ecrã perfil (horas do mês, saldo férias, dados pessoais)

Bloco 3.3 — Registo de Ponto
52. Botão Registar Entrada: clock-in com GPS + timestamp + aviso se longe do local
53. Botão Registar Saída: clock-out com GPS + duração calculada
54. Painel gestor tempo real: lista de estado + mapa com último clock-in (Supabase Realtime)

Bloco 3.4 — PWA + Notificações + Google Calendar
55. PWA: Web App Manifest + Service Worker (cache offline para escala)
56. Web Push: VAPID keys + subscriptions + notificações (novo serviço, alteração, cancelamento, lembrete 1h)
57. Google Calendar API: criar/atualizar evento no Google Calendar ao criar/alterar serviço
58. ✅ Commit + push Fase 3 completa

FASE 4 — Operações Avançadas
Bloco 4.1 — Absentismo e Substituição
59. Registo de falta: tipos de ausência + impacto na escala (serviço sem cobertura → alerta)
60. Motor de substituição: filtrar por skills + disponibilidade + sem conflito → gestor escolhe → notifica substituta

Bloco 4.2 — Mapa de Férias
61. Mapa de férias anual: grelha colaboradoras × dias + pedido via app + aprovação + saldo automático
62. Alerta de férias simultâneas: avisar gestor quando muitas colaboradoras pedem a mesma semana

Bloco 4.3 — Vista em Mapa
63. Vista em mapa: pins por equipa (Mapbox) + filtros por data/equipa/estado
64. Botão Calcular Rotas: rota otimizada por equipa via Mapbox Directions + tempo de deslocamento

Bloco 4.4 — Relatórios
65. Relatório de horas: totais mensais por colaboradora + grelha diária ao clicar (horas contratadas vs trabalhadas, ocupação %, pontualidade)
66. Relatório de absentismo + serviços concluídos vs cancelados + receita por cliente
67. Extrato mensal por cliente: PDF com lista de serviços + total a pagar + exportação CSV de todos os relatórios
68. ✅ Commit + push Fase 4 completa

FASE 5 — Módulo Financeiro
Bloco 5.1 — Folha de Pagamento
69. Folha de pagamento: cálculo automático (horas × valor/hora + sub. alimentação + hora extra − faltas) + ajustes manuais + PDF por colaboradora

Bloco 5.2 — Faturação a Clientes
70. Documento de cobrança por serviço: numeração automática + IVA 23% + estados (rascunho/pendente/pago) + PDF + CSV

Bloco 5.3 — Dashboard Financeiro
71. Dashboard financeiro: KPIs (receita, custos, margem) + gráfico 12 meses + projeção do mês
72. ✅ Commit + push Fase 5 completa

FASE 6 — Produção
Importação por CSV: colaboradoras, clientes e locais a partir de Excel
Configurar emails transacionais (Resend): convites, notificações, extratos mensais automáticos
Anti-hibernação Supabase Free: cron job que faz ping a cada 5 dias
Página de Configurações: valor hora, sub. alimentação, % hora extra, IVA, raio GPS, logo empresa, fuso horário
Testes com dados reais da Mó Limpezas + ajustes finais de UX
✅ Commit final + deploy em produção → sistema pronto a usar


---

*Última atualização: 2026-06-02*
