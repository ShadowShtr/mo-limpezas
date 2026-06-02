# Wireframes — Descrição dos Ecrãs Principais

> Descrições textuais detalhadas dos ecrãs. Design visual será definido durante o desenvolvimento.
> Paleta de cores: a definir com o user (sugestão: laranja/vermelho como ServiSync, ou cor da Mó Limpezas).

---

## Layout Geral (Web — Admin/Gestor)

```
┌────────────────────────────────────────────────────────────────┐
│ SIDEBAR (220px)          │  CONTEÚDO PRINCIPAL                  │
│                          │                                      │
│ [Logo Mó Limpezas]       │  [Header: título da página]          │
│                          │  [Breadcrumb]                        │
│ ─────────────────        │                                      │
│ 📅 Calendário            │  [Conteúdo da página]                │
│ 👥 Equipas               │                                      │
│ 🏢 Clientes              │                                      │
│ 📍 Locais                │                                      │
│ 👤 Colaboradores         │                                      │
│ 🗺️  Mapa                 │                                      │
│ ─────────────────        │                                      │
│ 💰 Financeiro            │                                      │
│   ↳ Faturação            │                                      │
│   ↳ Pagamentos           │                                      │
│   ↳ Dashboard            │                                      │
│ ─────────────────        │                                      │
│ 📊 Relatórios            │                                      │
│ ⚙️  Configurações        │                                      │
│ ─────────────────        │                                      │
│ [Avatar] João Silva  ⬇   │                                      │
└──────────────────────────┴──────────────────────────────────────┘
```

---

## Ecrã 1: Calendário (Principal)

```
┌─────────────────────────────────────────────────────────────────┐
│ Calendário                    [< Semana]  27 Jan – 2 Fev 2025  [Semana >]
│ [+ Novo Serviço]   [Filtrar: Todas Equipas ▼]  [Vista: Semana ▼]
├──────────┬──────────┬──────────┬──────────┬──────────┬──────────┤
│          │ Equipa 1 │ Equipa 2 │ Equipa 3 │ Equipa 4 │ Equipa 5 │
│          │ (verde)  │ (laranja)│ (azul)   │ (roxo)   │ (teal)   │
├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤
│ 08:00    │          │          │          │          │          │
│ 09:00    │ ████████ │          │          │          │          │
│          │ Edif. A  │          │          │          │          │
│          │ 09:00-11 │          │          │          │          │
│ 10:00    │          │ ████████ │          │          │          │
│          │          │ Loja B   │          │          │          │
│ 11:00    │          │          │ ████████ │          │          │
│          │          │          │ Apt. C   │          │          │
│ 12:00    │          │          │          │          │          │
│ 13:00    │ ████████ │          │          │ ████████ │          │
│          │ Edif. D  │          │          │ Escola E │          │
│ 14:00    │          │          │          │          │          │
│ 15:00    │          │ ████████ │          │          │ ████████ │
│          │          │ Hotel F  │          │          │ Clín. G  │
└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘
```

**Legenda de cores dos blocos:**
- Verde claro = agendado
- Amarelo = em curso (clock-in feito)
- Verde escuro = concluído
- Vermelho = cancelado / falta
- Cinza = sem equipa

**Ao clicar num bloco:**
→ Abre painel lateral com detalhes + botões: Editar, Cancelar, Ver no Mapa

---

## Ecrã 2: Criar/Editar Serviço (Formulário lateral)

```
┌────────────────────────────────────┐
│ Novo Serviço               [X]     │
├────────────────────────────────────┤
│ Cliente *                          │
│ [Pesquisar cliente...        ▼]    │
│                                    │
│ Local *                            │
│ [Pesquisar local...          ▼]    │
│                                    │
│ Data *          Hora início *      │
│ [05/02/2025]    [09:00     ]       │
│                                    │
│ Duração *                          │
│ [02:00  ] hh:mm                    │
│                                    │
│ Equipa *                           │
│ [Selecionar equipa...        ▼]    │
│                                    │
│ Nº Colaboradores                   │
│ [  2  ] (afeta preço)              │
│                                    │
│ ─────────────────────────────────  │
│ Preço calculado: €60,00            │
│ (2h × €15/h × 2 pessoas)          │
│ [ ] Override manual: [_______]     │
│                                    │
│ ─────────────────────────────────  │
│ Recorrência                        │
│ (•) Único   ( ) Recorrente         │
│                                    │
│ [Se recorrente: mostra opções]     │
│                                    │
│ Notas                              │
│ [________________________]         │
│ [________________________]         │
│                                    │
│ [Cancelar]        [Criar Serviço]  │
└────────────────────────────────────┘
```

---

## Ecrã 3: Recorrência (expande no formulário)

```
│ Recorrência                        │
│ ( ) Único   (•) Recorrente         │
│                                    │
│ Frequência *                       │
│ [Semanal                    ▼]     │
│                                    │
│ Dias da semana *                   │
│ [Dom] [Seg✓] [Ter] [Qua✓] [Qui]   │
│ [Sex✓] [Sab]                       │
│                                    │
│ Data início *    Data fim          │
│ [05/01/2025]     [31/12/2025]      │
│                  □ Sem data fim    │
│                                    │
│ Prévia:                            │
│ Seg 06/01, Qua 08/01, Sex 10/01   │
│ Seg 13/01, Qua 15/01, ... (+48)   │
```

---

## Ecrã 4: App Colaborador — Home (Mobile)

```
┌─────────────────────────┐
│ ≡  Mó Limpezas    🔔 1  │
├─────────────────────────┤
│ Bom dia, Ana! 👋         │
│ Segunda, 27 Jan 2025    │
├─────────────────────────┤
│ HOJE — 2 serviços       │
│                         │
│ ┌─────────────────────┐ │
│ │ 09:00 – 11:00       │ │
│ │ 🏢 Edifício Central  │ │
│ │ Rua do Comércio, 10  │ │
│ │ Equipa 01            │ │
│ │ [Ver detalhes]       │ │
│ └─────────────────────┘ │
│                         │
│ ┌─────────────────────┐ │
│ │ 14:00 – 16:00       │ │
│ │ 🏠 Apartamento B     │ │
│ │ Av. da República, 5  │ │
│ │ Equipa 01            │ │
│ │ [Ver detalhes]       │ │
│ └─────────────────────┘ │
│                         │
├─────────────────────────┤
│ [🏠 Home] [📅 Escala] [👤] │
└─────────────────────────┘
```

---

## Ecrã 5: App Colaborador — Detalhe Serviço (Mobile)

```
┌─────────────────────────┐
│ ← Voltar                │
├─────────────────────────┤
│ Edifício Central        │
│ Seg, 27 Jan · 09:00     │
├─────────────────────────┤
│ 📍 Rua do Comércio, 10  │
│    Lisboa               │
│ [🗺 Navegar]            │
├─────────────────────────┤
│ ⏱ 2 horas              │
│ 👥 2 pessoas            │
│ 🔑 Código porta: 4521   │
├─────────────────────────┤
│ INSTRUÇÕES              │
│ Limpar entrada, escadas │
│ e corredor. Usar limpa  │
│ vidros nos espelhos.    │
├─────────────────────────┤
│ EQUIPA                  │
│ 👤 Ana Martins (você)   │
│ 👤 Rui Costa            │
├─────────────────────────┤
│                         │
│  ┌─────────────────┐   │
│  │ ▶ INICIAR       │   │
│  │   SERVIÇO       │   │
│  └─────────────────┘   │
│                         │
└─────────────────────────┘
```

*Após clock-in, o botão muda para "TERMINAR SERVIÇO"*

---

## Ecrã 6: Mapa (Web)

```
┌──────────────────────────────────────────────────────────┐
│ Vista Mapa                                               │
│ [Data: 27 Jan 2025] [Equipa: Todas ▼] [Calcular Rotas]  │
├──────────────────────────────────────────────────────────┤
│                                                          │
│     [MAPA MAPBOX]                                        │
│                                                          │
│   📍(verde) Edif. A - Equipa 1 - 09:00                  │
│        📍(verde) Loja B - Equipa 1 - 13:00              │
│   📍(laranja) Hotel C - Equipa 2 - 10:00                │
│                                                          │
│   [Se "Calcular Rotas" clicado: linhas coloridas         │
│    conectando os pins de cada equipa em sequência]       │
│                                                          │
├──────────────────────────────────────────────────────────┤
│ LEGENDA                                                  │
│ 🟢 Equipa 1: 3 serviços · ~45 min deslocamento          │
│ 🟠 Equipa 2: 2 serviços · ~30 min deslocamento          │
└──────────────────────────────────────────────────────────┘
```

---

## Ecrã 7: Mapa de Férias

```
┌────────────────────────────────────────────────────────────────────┐
│ Mapa de Férias — 2025          [Ano: 2025 ▼]  [+ Marcar Férias]  │
├───────────────┬────────────────────────────────────────────────────┤
│ Colaborador   │ Jan          │ Fev          │ Mar          │ ...   │
│               │01 02 03 ... │01 02 03 ... │               │       │
├───────────────┼─────────────┼─────────────┼───────────────┼───────┤
│ Ana Martins   │             │ 🟢🟢🟢🟢🟢  │               │       │
│ (22 - 5 = 17) │             │ 03-07 Fev    │               │       │
├───────────────┼─────────────┼─────────────┼───────────────┼───────┤
│ Rui Costa     │ 🟡🟡🟡🟡🟡  │             │               │       │
│ (22 - 5 = 17) │ pendente    │             │               │       │
├───────────────┼─────────────┼─────────────┼───────────────┼───────┤
│ Maria Silva   │             │             │ 🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢  │
│ (22 - 10 = 12)│             │             │ 03-14 Mar     │       │
└───────────────┴─────────────┴─────────────┴───────────────┴───────┘

🟢 = Aprovado   🟡 = Pendente   🔴 = Rejeitado
```

---

## Ecrã 8: Dashboard Financeiro

```
┌──────────────────────────────────────────────────────────────────┐
│ Financeiro — Janeiro 2025           [Mês ▼] [Exportar CSV]      │
├───────────────┬───────────────┬───────────────┬──────────────────┤
│ RECEITA       │ CUSTOS        │ MARGEM BRUTA  │ SERVIÇOS         │
│ €12.450       │ €7.200        │ €5.250 (42%)  │ 87 concluídos    │
│ ↑ 8% vs dez  │ ↑ 3% vs dez  │ ↑ 5% vs dez  │                  │
├───────────────┴───────────────┴───────────────┴──────────────────┤
│                                                                  │
│  [Gráfico Barras: Receita vs Custos — últimos 6 meses]          │
│                                                                  │
├──────────────────────┬───────────────────────────────────────────┤
│ TOP CLIENTES (receita)│ PROJEÇÃO DO MÊS                         │
│ 1. Clínica ABC  €2.1k │ Faturado até hoje:   €8.200             │
│ 2. Hotel XYZ    €1.8k │ Agendado (restante): €4.250             │
│ 3. Escola 123   €1.5k │ Projeção total:     €12.450             │
│ [Ver todos]           │                                         │
└──────────────────────┴───────────────────────────────────────────┘
```

---

## Notas de Design

- **Responsivo:** todos os ecrãs web devem funcionar em tablet (1024px)
- **App mobile:** apenas os ecrãs 4, 5 e escala semanal
- **Paleta:** a definir — sugestão: usar a cor/logo da Mó Limpezas
- **Dark mode:** não prioritário para Fase 1
- **Acessibilidade:** contraste adequado, tamanhos de fonte legíveis
