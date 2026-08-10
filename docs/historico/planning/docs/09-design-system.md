# Sistema de Design — Plataforma Escala

> Duas referências visuais aprovadas:
> - **Posnik** — layout limpo e moderno para páginas operacionais (calendário, CRUD, app mobile)
> - **Analytics Dashboard** — layout denso com múltiplos gráficos para relatórios e dashboard financeiro

---

## Paleta de Cores

```
Primária (verde):
  --green-50:   #F0FDF4   ← backgrounds suaves, sidebar item hover
  --green-100:  #DCFCE7   ← badges, highlights
  --green-500:  #22C55E   ← ícones, indicadores positivos
  --green-600:  #16A34A   ← COR PRINCIPAL — botões, sidebar ativo, links
  --green-700:  #15803D   ← sidebar background, hover em botões
  --green-800:  #166534   ← textos sobre fundo verde

Neutros:
  --bg:         #F8FAFC   ← fundo geral da app
  --card:       #FFFFFF   ← fundo dos cards
  --border:     #E2E8F0   ← bordas suaves
  --text-main:  #0F172A   ← texto principal
  --text-sub:   #64748B   ← texto secundário, labels
  --text-muted: #94A3B8   ← placeholder, texto desativado

Semânticas:
  --success:    #16A34A   ← concluído, positivo
  --warning:    #F59E0B   ← em curso, atenção
  --danger:     #DC2626   ← cancelado, negativo, conflito
  --info:       #3B82F6   ← informação, neutro
```

---

## Tipografia

```
Font: Inter (Google Fonts)

Hierarquia:
  Título página:    28px, font-weight 700, color --text-main
  Título card:      16px, font-weight 600, color --text-main
  KPI número:       32px, font-weight 700, color --text-main
  KPI label:        12px, font-weight 500, color --text-sub, uppercase
  Corpo:            14px, font-weight 400, color --text-main
  Caption / muted:  12px, font-weight 400, color --text-muted
```

---

## Componentes Base

### Cards
```css
background: #FFFFFF
border: 1px solid #E2E8F0
border-radius: 12px
box-shadow: 0 1px 3px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.03)
padding: 20px 24px
```

### Botão Primário
```css
background: #16A34A
color: #FFFFFF
border-radius: 8px
padding: 10px 20px
font-weight: 600
font-size: 14px
hover: background #15803D
```

### Botão Secundário (outline)
```css
background: transparent
border: 1.5px solid #16A34A
color: #16A34A
border-radius: 8px
padding: 10px 20px
hover: background #F0FDF4
```

### Sidebar
```css
width: 240px
background: #FFFFFF
border-right: 1px solid #E2E8F0

Item normal:
  color: #64748B
  padding: 10px 16px
  border-radius: 8px
  icon + texto

Item ativo:
  background: #F0FDF4
  color: #16A34A
  font-weight: 600
  border-left: 3px solid #16A34A
```

### Cards de Métricas (KPIs)
```
Ícone colorido (verde/amarelo/azul) no canto superior
Número grande (32px bold)
Label pequeno abaixo (12px, uppercase, muted)
Indicador de tendência: ↑ 8.2% (verde se positivo, vermelho se negativo)
```

### Badges / Estado dos Serviços
```
Agendado:   bg #F0FDF4, text #16A34A,  dot verde
Em curso:   bg #FFFBEB, text #D97706,  dot amarelo
Concluído:  bg #F0FDF4, text #15803D,  dot verde escuro
Cancelado:  bg #FEF2F2, text #DC2626,  dot vermelho
Sem cobertura: bg #FEF2F2, text #DC2626, dot vermelho
```

### Gráficos (Recharts)
```
Linha: stroke #16A34A, strokeWidth 2
Área: fill gradiente de #16A34A (100% opacidade) → #16A34A (0% opacidade)
Grid: stroke #F1F5F9, strokeDasharray "4 4"
Tooltip: bg branco, sombra suave, borda #E2E8F0
```

### Tabelas
```
Header: bg #F8FAFC, text #64748B, font 12px uppercase
Linha: border-bottom 1px solid #F1F5F9
Hover linha: bg #F8FAFC
Células: padding 12px 16px, font 14px
```

---

## Layout Geral

### Desktop (≥ 1024px)
```
┌──────────────┬────────────────────────────────────┐
│   Sidebar    │  Header (logo + search + notif + user) │
│   240px      ├────────────────────────────────────┤
│   fixo       │                                    │
│              │   Conteúdo principal               │
│              │   padding: 24px 32px               │
│              │   max-width: 1400px                │
│              │                                    │
└──────────────┴────────────────────────────────────┘
```

### Mobile (< 768px — app colaboradora)
```
┌────────────────────────┐
│  Header simples        │
│  (logo + notificações) │
├────────────────────────┤
│                        │
│   Conteúdo             │
│   padding: 16px        │
│                        │
├────────────────────────┤
│  Bottom Navigation     │
│  [Home] [Escala] [EU]  │
└────────────────────────┘
```

---

## Princípios de UX

1. **Fundo neutro, cards brancos** — nunca usar verde como fundo de página
2. **Verde só em ações e destaques** — botões, ativo, positivo. Não colorir texto corrido.
3. **Sombras suaves** — nunca sombras pesadas. Elevação discreta.
4. **Espaçamento generoso** — padding mínimo 16px dentro de cards
5. **Ícones Lucide** — consistência com o projeto EVOXE já familiar
6. **Animações mínimas** — transitions 150ms ease-in-out. Sem animações decorativas.
7. **Densidade média** — não tão compacto que pareça Excel, não tão espaçado que pareça landing page

---

## Fontes de Inspiração

**Referência 1 — Posnik POS dashboard**
Usado em: páginas operacionais (calendário, CRUD, app mobile, contratos)
Padrão: cards brancos limpos, KPIs simples, sidebar com texto

**Referência 2 — Analytics Dashboard (gradient)**
Usado em: relatórios, dashboard financeiro, dashboard operacional do gestor
Padrão: multi-chart denso, gradientes de acento, sidebar icon-only escura

---

## Referência 2 — Analytics Dashboard Detalhado

### Conceito
Layout de alta densidade de dados, pensado para o gestor que precisa de ver
muitas métricas de uma vez. Múltiplos gráficos em grelha, com gradientes verdes
como acento sobre fundo claro. Tradução: rosa/roxo → verde #16A34A.

### Sidebar (versão densa / analytics)
```
Largura: 64px — só ícones, sem texto
Fundo: #1E293B (cinza escuro / quase preto)
Ícones: brancos, 20px
Item ativo: ícone verde #16A34A + fundo #16A34A20 (verde 12% opacidade)
Separador: linha sutil entre grupos de ícones
```

### Grelha de Cards (layout analytics)
```
Grid: 12 colunas com gap 16px
Cards pequenos (3 col): KPIs simples
Cards médios (6 col): gráficos de área ou barras
Cards grandes (9-12 col): gráficos de linha ou tabelas
Cards podem ter alturas diferentes — layout masonry-like
```

### Tipos de Gráfico e Como Aplicar

**Gráfico de Área (área preenchida)**
```
Uso: receita ao longo do tempo, horas trabalhadas por semana
Linha: stroke #16A34A, strokeWidth 2
Área fill: gradiente vertical
  topo: #16A34A com 40% opacidade
  base: #16A34A com 0% opacidade
Data points: círculos vazios com borda #16A34A, fill branco
```

**Gráfico de Linha Multi-série**
```
Uso: comparar meses, horas contratadas vs trabalhadas
Série 1: #16A34A (verde principal)
Série 2: #F59E0B (âmbar)
Série 3: #3B82F6 (azul)
Pontos nos dados: círculos sólidos 5px
Grid horizontal: linhas tracejadas #F1F5F9
```

**Gráfico de Barras Verticais**
```
Uso: receita por cliente, serviços por equipa
Barras: fill #16A34A, border-radius 4px no topo
Hover: fill #15803D
Barras múltiplas: verde + âmbar + azul com gap entre grupos
```

**Gráfico de Barras Horizontais (progress)**
```
Uso: ocupação % por colaboradora, absentismo por equipa
Fundo da barra: #F1F5F9
Preenchimento: gradiente #22C55E → #16A34A
Label esquerdo: nome, Label direito: percentagem
```

**Gráfico de Pizza / Donut**
```
Uso: distribuição de receita por cliente, tipos de ausência
Fatias: verde #16A34A, âmbar #F59E0B, azul #3B82F6, cinza #94A3B8
Centro do donut: valor total em destaque
Legenda: abaixo ou à direita, dots coloridos + label
```

**Dot Matrix / Scatter**
```
Uso: mapa de férias simplificado, presença por dia
Pontos: 8px círculos
Presente: #16A34A
Ausente: #DC2626
Férias: #3B82F6
Fim de semana: #E2E8F0
```

### Cards com Gradiente de Acento
Usados em 1-2 cards por página para destaque visual.
```
Fundo: gradiente linear 135deg, #16A34A → #4ADE80
Texto: branco
Usado para: KPI mais importante da página, alerta positivo
NÃO usar para alertas negativos (usar vermelho) nem em mais de 2 cards por página
```

### Tooltip dos Gráficos
```css
background: #FFFFFF
border: 1px solid #E2E8F0
border-radius: 8px
padding: 10px 14px
box-shadow: 0 4px 12px rgba(0,0,0,0.08)
font-size: 12px
linha de valor: font-weight 600, color #0F172A
linha de label: color #64748B
```

### Header da Página Analytics
```
Título da página: 24px bold
Subtítulo / período: dropdown de seleção de mês/ano ou intervalo de datas
Ações: botões Exportar PDF e Exportar CSV alinhados à direita
Separador: border-bottom 1px #E2E8F0 com margin-bottom 24px
```

---

## Qual Referência Usar em Cada Página

| Página | Referência | Motivo |
|--------|-----------|--------|
| Dashboard operacional (home) | Analytics | Muitas métricas de um relance |
| Calendário | Posnik | Limpo, foco nas equipas |
| Contratos Fixos | Posnik | Lista + formulário |
| Colaboradores / Clientes / Locais | Posnik | Tabelas CRUD |
| Equipas | Posnik | Cards visuais |
| App mobile colaboradora | Posnik | Simplicidade no telemóvel |
| Painel tempo real | Analytics | Múltiplas equipas, mapa |
| Vista em mapa | Analytics | Dados geoespaciais |
| Relatório de horas | Analytics | Grelha + gráficos |
| Relatório absentismo | Analytics | Barras + dot matrix |
| Dashboard financeiro | Analytics | KPIs + gráficos múltiplos |
| Mapa de férias | Analytics | Dot matrix por dia |
