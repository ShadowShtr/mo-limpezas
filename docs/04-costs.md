# Custos — Setup e Mensais

## Resumo Executivo

| Fase | Custo Setup | Custo Mensal |
|------|------------|-------------|
| Desenvolvimento (tiers gratuitos) | €0 | €0–€12 |
| Produção pequena escala (<50 users) | ~€15 único | ~€24–74/mês |
| Produção média escala (50–200 users) | ~€15 único | ~€80–150/mês |

---

## Serviços e Preços

### 1. Supabase

| Plano | Preço | Limites |
|-------|-------|---------|
| Free | €0 | 500MB DB, 1GB storage, 50MB/hora bandwidth, 50.000 MAUs |
| Pro | $25/mês (~€23) | 8GB DB, 100GB storage, sem limite MAUs, backups diários |

**Recomendação:** Free para desenvolvimento, Pro em produção.

**Custo extra possível:**
- DB > 8GB: $0.125/GB extra
- Storage > 100GB: $0.021/GB extra
- Para uma empresa de limpeza média: não deve ultrapassar os limites Pro tão cedo

---

### 2. Vercel

| Plano | Preço | Limites |
|-------|-------|---------|
| Hobby | €0 | 100GB bandwidth, builds ilimitadas, 1 membro |
| Pro | $20/mês (~€18) | 1TB bandwidth, equipa colaborativa, analytics avançado |

**Recomendação:** Hobby para início. Pro apenas se ultrapassar bandwidth ou precisar de mais de 1 programador.

---

### 3. Mapbox

| Utilização | Preço |
|-----------|-------|
| Até 25.000 map loads/mês | Grátis |
| Além disso | $5 por 1000 loads |
| Directions API (rotas) | $1 por 1000 reqs (primeiros 100k/mês grátis) |
| Geocoding (morada→GPS) | $0.75 por 1000 reqs (primeiros 100k/mês grátis) |

**Para uma empresa com 50 locais e 10 gestores a usar mapas:**
- Map loads estimados: ~500/dia × 30 = 15.000/mês → **grátis**
- Geocoding: apenas quando se regista um novo local → **grátis**
- Rotas: ~50 cálculos/dia × 30 = 1.500/mês → **grátis**

---

### 4. Domínio

| Opção | Preço |
|-------|-------|
| molimpezas.pt | ~€10–15/ano (~€1/mês) |
| molimpezas.com | ~€10–15/ano (~€1/mês) |

**Registar em:** GoDaddy, Namecheap, ou FCCN (domínios .pt portugueses)

---

### 5. FullCalendar Premium (opcional)

| Opção | Preço |
|-------|-------|
| Versão standard (MIT) | Grátis |
| Premium (ResourceTimeline view) | ~$200/ano (~€185) |

A view "colunas por equipa" (como no ServiSync) requer a licença Premium.

**Alternativas:**
- Pagar a licença: €185/ano (~€15/mês) — recomendado para a melhor UX
- Implementar view personalizada com CSS Grid: grátis mas mais trabalho de desenvolvimento

---

### 6. SMS / OTP (opcional)

Se quiser que os colaboradores façam login via SMS:

| Serviço | Preço |
|---------|-------|
| Twilio (SMS) | ~$0.05/SMS enviado |
| Supabase Phone Auth (usa Twilio) | Incluído se configurado com a própria chave Twilio |

**Para 20 colaboradores com login mensal:** ~€1/mês — irrelevante.
Mas para OTP por SMS em cada acesso: pode acumular.

**Recomendação:** Magic Link por email (grátis, Supabase inclui) em vez de SMS.

---

### 7. App Store / Google Play (Fase 2 — app nativa)

| Plataforma | Custo |
|-----------|-------|
| Apple Developer Program | $99/ano (~€92) |
| Google Play Console | $25 único (~€23) |

Apenas relevante se decidir fazer app nativa na Fase 2.

---

## Tabela Consolidada — Produção

### Cenário Base (pequena empresa, PWA)

| Serviço | Plano | Custo/mês |
|---------|-------|-----------|
| Supabase | Pro | €23 |
| Vercel | Hobby | €0 |
| Mapbox | Free | €0 |
| Domínio | .pt | €1 |
| FullCalendar Premium | — | €15 |
| **TOTAL** | | **€39/mês** |

### Cenário com SMS e mais features

| Serviço | Plano | Custo/mês |
|---------|-------|-----------|
| Supabase | Pro | €23 |
| Vercel | Pro | €18 |
| Mapbox | Pago (uso moderado) | €10 |
| Domínio | .pt | €1 |
| FullCalendar Premium | — | €15 |
| Twilio SMS | ~50 SMS/mês | €3 |
| **TOTAL** | | **€70/mês** |

---

## Comparação com ServiSync

O ServiSync cobra por empresa/mês. Não publicam preços (é contacto direto), mas estimativas de mercado para software deste tipo em Portugal:

| Solução | Custo Mensal |
|---------|-------------|
| ServiSync (estimativa) | €150–400/mês |
| **Solução própria** | **€39–70/mês** |

**Poupança estimada:** €110–360/mês (€1.320–4.320/ano) + controlo total sobre as funcionalidades.

---

## Custo de Desenvolvimento

O desenvolvimento em si é feito com Claude Code — o custo é o tempo de sessões.

Não há custo de servidor durante o desenvolvimento (tiers gratuitos cobrem tudo).

---

## Setup Inicial (pagamentos únicos)

| Item | Custo |
|------|-------|
| Domínio (1º ano) | €12 |
| Google Play (se app nativa) | €23 |
| Apple Developer (se app nativa) | €92/ano |
| **Mínimo sem app nativa** | **€12** |
