# Sistema de Design — Plataforma Escala

> Referência visual: Posnik POS dashboard. Mesmo padrão, cor verde em vez de roxo.

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

## Fonte de Inspiração

Posnik POS dashboard — layout de referência aprovado pelo user.
Aplicar exatamente os mesmos padrões substituindo roxo (#6366F1) por verde (#16A34A).
