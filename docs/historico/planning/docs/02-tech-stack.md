# Stack Tecnológica — Decisões e Justificações

## Visão Geral

```
┌─────────────────────────────────────────────────────────┐
│                    UTILIZADORES                          │
│          Admin/Gestor (Web)   Colaborador (Mobile)       │
└──────────────┬───────────────────────┬───────────────────┘
               │                       │
┌──────────────▼───────────────────────▼───────────────────┐
│              FRONTEND — Next.js 15 (TypeScript)           │
│         Tailwind CSS + shadcn/ui + FullCalendar           │
│              PWA (service worker + manifest)              │
└──────────────────────────┬────────────────────────────────┘
                           │ API Routes / Server Actions
┌──────────────────────────▼────────────────────────────────┐
│                  BACKEND — Supabase                        │
│   PostgreSQL  │  Auth  │  Realtime  │  Storage  │  Edge Fn │
└───────────────────────────────────────────────────────────┘
               │                       │
    ┌──────────▼──────┐    ┌───────────▼────────┐
    │   Mapbox GL JS  │    │  Web Push API       │
    │   (mapas/rotas) │    │  (notificações)     │
    └─────────────────┘    └────────────────────┘
```

---

## Decisões por Camada

### Frontend: Next.js 15

**Por quê Next.js em vez de React + Vite (como EVOXE)?**

| Critério | React + Vite | Next.js 15 |
|----------|-------------|-----------|
| Dashboards complexos | Bom | Melhor (Server Components) |
| API própria | Precisa Express separado | API Routes incluídas |
| SEO | Fraco (SPA) | Excelente (SSR) |
| Performance | Boa | Melhor (streaming SSR) |
| Curva de aprendizado | Já conheces | Muito similar |
| Deploy | Vercel ✓ | Vercel ✓ (otimizado) |

O módulo financeiro e os relatórios beneficiam muito de Server Components — processamento pesado fica no servidor, não no browser.

**Configuração:**
```
next.config.ts
├── PWA plugin (next-pwa)
├── Image optimization
└── Environment variables
```

---

### Estilo: Tailwind CSS + shadcn/ui

Mesma stack do EVOXE. Zero curva de aprendizado.

**Componentes shadcn/ui que vão ser usados:**
- `Calendar`, `DatePicker` — seleção de datas
- `Table` — relatórios, listagens
- `Dialog`, `Sheet` — formulários laterais
- `Select`, `Combobox` — dropdowns com pesquisa
- `Badge` — estados dos serviços
- `Tabs` — navegação interna
- `Command` — pesquisa global

---

### Calendário: FullCalendar

**Por quê FullCalendar?**
- É o standard da indústria para este tipo de interface
- Suporta: semana, dia, mês, timeline (colunas por recurso = equipas)
- Drag & Drop nativo
- Eventos com cores e clique
- Licença: **MIT** (gratuito) para o core, premium para algumas views
- A **ResourceTimeline view** (colunas por equipa) requer licença premium: ~$200/ano
  - Alternativa: implementar view personalizada com CSS Grid (mais trabalho, mas gratuito)
  - **Decisão:** Começar com view semanal standard, upgrade para ResourceTimeline se necessário

**Package:** `@fullcalendar/react` + `@fullcalendar/daygrid` + `@fullcalendar/timegrid` + `@fullcalendar/interaction`

---

### Backend/Base de Dados: Supabase

**Por quê Supabase?**
- Já familiar do projeto EVOXE
- PostgreSQL — robusto, relacional, suporta queries complexas para relatórios
- Auth integrado (multi-role com RLS)
- Realtime — para o painel de equipas em tempo real
- Storage — para fotos de locais e documentos
- Edge Functions — para jobs agendados (gerar recorrências)
- Preço acessível para início

**Row Level Security (RLS) — Estratégia:**
```sql
-- Colaborador só vê os próprios serviços
-- Gestor vê tudo dentro da empresa
-- Admin tem acesso irrestrito
```

**Realtime — Usos:**
- Painel de gestão atualiza quando colaborador faz clock-in
- Notificação quando serviço é alterado
- Vista de mapa atualiza posição das equipas

---

### Mapas: Mapbox GL JS

**Por quê Mapbox em vez de Google Maps?**

| Critério | Google Maps | Mapbox |
|----------|------------|--------|
| Preço free tier | $200 crédito/mês | 25.000 map loads/mês grátis |
| Preço depois do free | $7/1000 loads | $5/1000 loads |
| Qualidade dos mapas | Excelente | Excelente |
| Customização | Limitada | Total (vector tiles) |
| Routing API | $5/1000 reqs | $1/1000 reqs |
| SDK React | Bom | Muito bom (react-map-gl) |

Para uma empresa pequena/média em Portugal: Mapbox grátis cobre facilmente.

**Usos na plataforma:**
- Vista de mapa com pins de serviços
- Geocoding (morada → coordenadas)
- Routing (rotas otimizadas por equipa)
- Validação de ponto (colaborador está no local?)

**Package:** `react-map-gl` + `@mapbox/mapbox-sdk`

---

### PWA (Progressive Web App)

A app do colaborador é uma PWA — funciona no browser do telemóvel, instalável no ecrã inicial, funciona offline (para ver escala sem internet).

**Funcionalidades PWA:**
- Service Worker: cache de páginas para offline
- Web App Manifest: instalação no homescreen
- Push Notifications: via Web Push API + Supabase Edge Functions
- Geolocation API: para registo de ponto

**Por quê não React Native agora?**
1. Mesma codebase = menos trabalho
2. Sem aprovação App Store (que pode demorar semanas)
3. GPS funciona via browser em HTTPS
4. Notificações push funcionam via Web Push
5. Pode-se migrar para nativo depois com código React reutilizável

---

### Notificações: Web Push + Supabase Edge Functions

**Fluxo:**
1. Colaborador instala a PWA → browser pede permissão de notificações
2. Browser gera um "push subscription" (endpoint único)
3. Subscription é guardada no Supabase
4. Quando gestor cria/altera serviço → Edge Function dispara → notificação push

**Serviço:** [web-push](https://github.com/web-push-libs/web-push) npm package

---

### Deploy: Vercel

Mesma plataforma do EVOXE. Suporta Next.js na perfeição (são da mesma empresa).

**Configuração:**
- Branch `main` → deploy automático em produção
- Branch `dev` → deploy em preview (URL temporária para testes)
- Variáveis de ambiente geridas no painel Vercel

---

### Autenticação: Supabase Auth

**Roles implementados via:**
1. Supabase Auth (gestão de utilizadores)
2. Tabela `profiles` com campo `role` (admin, gestor, colaborador)
3. RLS policies baseadas no role
4. Middleware Next.js para proteção de rotas

**Login Colaborador:**
- Email + password (simples e universal)
- Ou Magic Link por email (sem password)
- SMS OTP: requer Twilio (custo adicional ~$0.05/SMS) — decidir depois

---

## Decisões Adiadas

| Decisão | Opções | Quando decidir |
|---------|--------|----------------|
| SMS notifications | Twilio ($) vs apenas push | Antes da Fase 3 |
| App nativa | React Native + Expo vs manter PWA | Após Fase 3, com feedback real |
| Software contabilidade | Moloni / InvoiceXpress / nenhum | Antes da Fase 5 |
| FullCalendar Premium | Comprar licença ($200/ano) vs view custom | Início da Fase 2 |

---

## Dependências Principais (package.json previsto)

```json
{
  "dependencies": {
    "next": "^15.0.0",
    "@supabase/supabase-js": "^2.x",
    "@supabase/ssr": "^0.x",
    "tailwindcss": "^4.x",
    "@fullcalendar/react": "^6.x",
    "@fullcalendar/daygrid": "^6.x",
    "@fullcalendar/timegrid": "^6.x",
    "@fullcalendar/interaction": "^6.x",
    "react-map-gl": "^7.x",
    "@mapbox/mapbox-sdk": "^0.x",
    "jspdf": "^2.x",
    "date-fns": "^3.x",
    "zod": "^3.x",
    "react-hook-form": "^7.x"
  }
}
```

---

## Variáveis de Ambiente Necessárias

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=       # apenas server-side

# Mapbox
NEXT_PUBLIC_MAPBOX_TOKEN=

# Web Push (VAPID keys — geradas uma vez)
NEXT_PUBLIC_VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=

# App
NEXT_PUBLIC_APP_URL=https://molimpezas.pt
```
