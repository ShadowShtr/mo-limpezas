# Dificuldade — O que Claude faz vs O que o User faz

## Nível Global do Projeto: 8/10

Este é um projeto ambicioso mas completamente realizável. A complexidade vem da profundidade das regras de negócio (não da tecnologia em si).

---

## O que Claude faz sozinho (90–95% do projeto)

### Base de Dados e Backend
- ✅ Esquema completo das tabelas (SQL)
- ✅ Row Level Security policies (segurança por role)
- ✅ Supabase Edge Functions (jobs automáticos)
- ✅ Toda a lógica de negócio: cálculo de preços, recorrências, substituições
- ✅ Triggers de base de dados (ex: atualizar `updated_at` automaticamente)
- ✅ Views e queries complexas para relatórios

### Frontend Web (Admin/Gestor)
- ✅ Layout completo com sidebar e navegação
- ✅ Todas as páginas de listagem, criação, edição
- ✅ Calendário com FullCalendar (drag & drop, cores, eventos)
- ✅ Formulários com validação (react-hook-form + zod)
- ✅ Dashboard financeiro com gráficos (recharts)
- ✅ Relatórios com exportação PDF

### App do Colaborador (PWA)
- ✅ Layout mobile-first
- ✅ Ecrãs de escala, detalhe de serviço
- ✅ Clock-in / clock-out com geolocalização
- ✅ Instalação no homescreen (manifest + service worker)
- ✅ Notificações push

### Mapas
- ✅ Integração Mapbox
- ✅ Pins de serviços no mapa
- ✅ Cálculo de rotas por equipa

### Deploy e Infraestrutura
- ✅ Configuração Next.js + Vercel
- ✅ Variáveis de ambiente
- ✅ CI/CD (push → deploy automático)

---

## O que o User precisa fazer

### Setup Único (antes de começar)

| Tarefa | Dificuldade | Tempo estimado | Instruções fornecidas por Claude |
|--------|------------|----------------|----------------------------------|
| Criar conta Supabase (supabase.com) | ⭐ Fácil | 5 min | Sim, passo a passo |
| Criar projeto Supabase | ⭐ Fácil | 5 min | Sim |
| Criar conta Vercel (vercel.com) | ⭐ Fácil | 5 min | Sim |
| Criar conta Mapbox (mapbox.com) | ⭐ Fácil | 5 min | Sim |
| Criar repositório GitHub | ⭐ Fácil | 2 min | Sim |
| Comprar domínio | ⭐ Fácil | 10 min | Sim |
| Ligar Vercel ao GitHub | ⭐ Fácil | 5 min | Sim |

### Durante o Desenvolvimento

| Tarefa | Quando | Motivo |
|--------|--------|--------|
| Copiar API keys do Supabase para o projeto | Fase 1 | Só o user tem acesso às credenciais |
| Adicionar token Mapbox ao .env | Fase 4 | Idem |
| Testar funcionalidades com dados reais | Após cada fase | User conhece o negócio real |
| Validar cálculos de salário | Fase 5 | User sabe as regras específicas da empresa |
| Inserir dados reais (colaboradores, locais) | Fase 6 | User tem esses dados |
| Aprovar UX/design | A cada fase | Gosto pessoal do user |

### Decisões Estratégicas (a qualquer momento)

| Decisão | Impacto |
|---------|---------|
| SMS vs email para login colaboradores | Custo mensal |
| FullCalendar Premium ou view custom | €185/ano ou mais desenvolvimento |
| App nativa na Fase 2? | Muito mais complexidade |
| Multi-empresa / SaaS? | Muda arquitetura toda |
| Integração com contabilidade? | Complexidade adicional |

---

## Dificuldade por Módulo

### Calendário + Drag & Drop — 7/10
**Por quê é difícil:** A lógica de "colunas por equipa" não é standard no FullCalendar gratuito. Drag entre equipas (muda a equipa do serviço) tem edge cases.

**Como resolvemos:** FullCalendar com a ResourceTimeline view (premium) ou implementação CSS Grid personalizada.

---

### Serviços Recorrentes — 8/10
**Por quê é difícil:** A lógica de "editar só esta ocorrência" vs "editar todas as futuras" é notoriamente complexa (o Google Calendar leva anos a afinar isso). Há muitos edge cases:
- E se mudares a hora de uma ocorrência individual?
- E se apagares o template mas houver ocorrências passadas já concluídas?
- E se moveres uma ocorrência para fora do padrão?

**Como resolvemos:** Modelo de "exceções" — cada ocorrência tem `is_exception = true` quando editada individualmente. O sistema mantém o template mas respeita exceções.

---

### Módulo Financeiro — 8/10
**Por quê é difícil:** As regras de cálculo de salários em Portugal têm nuances: subsídio alimentação, horas extra com acréscimo, IRS e Segurança Social (se quisermos ir fundo), férias com subsídio, etc.

**Como resolvemos:** Implementamos o básico (horas × valor/hora + ajustes manuais) e adicionamos complexidade só se o user precisar. A fórmula base cobre 80% dos casos.

---

### Gestão de Absentismo + Substituição — 7/10
**Por quê é difícil:** O motor de sugestão de substitutos precisa de verificar: disponibilidade, competências, conflitos de horário, e ordenar por "melhor fit". É um algoritmo simples mas com muitas condições.

**Como resolvemos:** Query PostgreSQL com múltiplos filtros + scoring simples.

---

### Registo de Ponto com GPS — 6/10
**Por quê não é mais difícil:** A browser Geolocation API funciona bem em HTTPS. A validação de proximidade é uma fórmula de distância (Haversine) simples.

**Caveat:** Em alguns browsers no iOS, a precisão GPS pode ser baixa dentro de edifícios. Implementamos aviso, não bloqueio.

---

### Mapa + Rotas — 7/10
**Por quê é difícil:** A Mapbox Directions API retorna rotas complexas. Otimizar a sequência de visitas (problema do caixeiro-viajante) é NP-completo para N grande.

**Como resolvemos:** Para N pequeno (5–15 serviços por dia por equipa), usamos um algoritmo greedy simples: sempre vai ao serviço mais próximo do atual. Resolve 90% dos casos práticos.

---

### Multi-role Auth — 6/10
**Por quê não é mais difícil:** Supabase tem RLS e JWT claims. O padrão é estabelecido.

---

### PWA + Web Push — 6/10
**Por quê é moderado:** O setup inicial das VAPID keys e do service worker é chato mas é um problema resolvido com boa documentação.

---

## O que pode correr mal (riscos)

| Risco | Probabilidade | Mitigação |
|-------|--------------|-----------|
| Lógica de recorrência com bugs | Alta | Testes unitários extensivos |
| GPS impreciso dentro de edifícios | Média | Aviso em vez de bloqueio |
| FullCalendar Premium caro | Baixa | Alternativa CSS Grid disponível |
| App Store rejeitar app nativa | Baixa | PWA já funciona, nativa é opcional |
| Mudança de requisitos a meio | Média | Arquitetura modular facilita adições |
| User não consegue fazer setup | Baixa | Claude guia passo a passo |

---

## Conclusão

**O user não precisa de saber programar** para este projeto acontecer.

As únicas coisas que o user faz são:
1. Criar contas em serviços online (5 min cada)
2. Copiar/colar API keys quando pedido
3. Testar e dar feedback
4. Tomar decisões estratégicas de negócio

O resto é Claude.
