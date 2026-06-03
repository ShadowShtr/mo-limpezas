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

---

## Ecrã 9: /contratos — Lista de Contratos Fixos

```
┌──────────────────────────────────────────────────────────────────────┐
│ Contratos Fixos                              [+ Novo Contrato]       │
├──────────────────────────────────────────────────────────────────────┤
│ [Pesquisar cliente/local...]    [Estado: Todos ▼]  [Equipa: Todas ▼] │
├───────────────────────────────────────────────────────────────────────┤
│ Cliente           Local              Padrão              Equipa  Est. │
│ ─────────────────────────────────────────────────────────────────────│
│ Clínica ABC       R. das Flores 10   Semanal Seg/Qua/Sex  Eq.1  ● Ativo│
│                                      13:00 – 14:00                   │
│ Hotel XYZ         Av. do Mar 5       Semanal Ter/Qui      Eq.2  ● Ativo│
│                                      09:00 – 12:00                   │
│ Escola 123        Largo Central 2    Quinzenal Seg        Eq.3  ⏸ Pausado│
│                                      08:00 – 10:00                   │
├───────────────────────────────────────────────────────────────────────┤
│                                               [< 1 2 3 >]            │
└───────────────────────────────────────────────────────────────────────┘
```

**Ao clicar na linha:** abre sheet lateral com detalhe + editar + pausar/reativar + cancelar  
**Colunas da tabela:** Cliente, Local, Padrão (resumo), Equipa, Estado (ativo/pausado/cancelado)

---

## Ecrã 10: Criar/Editar Contrato (Sheet lateral)

> Baseado na referência ServiSync. Este é o ecrã mais complexo da Fase 2.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Novo Contrato                                               [X]     │
├─────────────────────────────────────────────────────────────────────┤
│ Cliente *                    Local *                                │
│ [Pesquisar cliente...   ▼]   [Pesquisar local...             ▼]    │
│                                                                     │
│ ─── Agendamento ─────────────────────────────────────────────────── │
│                                                                     │
│ Periodicidade *         Tipo de Contrato *                          │
│ [Semanal           ▼]   [Recorrente         ▼]                     │
│                                                                     │
│   Opções de Periodicidade:                                          │
│   Pontual / Diário / Dias Úteis / Semanal / Quinzenal /            │
│   3/3 Semanas / 4/4 Semanas / Mensal / 6/6 Semanas /              │
│   Bimestral / Trimestral / Semestral / Anual                       │
│                                                                     │
│ Data início *           Data término                                │
│ [24/03/2025    📅]      [            📅]  □ Sem data fim           │
│                                                                     │
│ Dias da Semana *  (só visível quando periodicidade ≥ Semanal)      │
│ ┌─────┬─────┬─────┬─────┬─────┬─────┬─────┐                      │
│ │ Dom │ Seg │ Ter │ Qua │ Qui │ Sex │ Sáb │                      │
│ │     │  ■  │     │  ■  │     │  ■  │     │ ← selecionados       │
│ └─────┴─────┴─────┴─────┴─────┴─────┴─────┘                      │
│                                                                     │
│ ─── Horário por Dia ──────────────────────────────────────────────  │
│                                                                     │
│  Dia    Início    Duração   Fim      Pausa ⓘ   Colaboradores       │
│  ────   ──────    ───────   ───      ─────      ──────────────      │
│  ▶Seg   13:00 🕐  01:00 🕐  14:00   00:00 🕐   [Equipa 2 ×] ▼ ⊕ 🗑 📋 📄│
│  ▶Qua   13:00 🕐  01:00 🕐  14:00   00:00 🕐   [Equipa 2 ×] ▼ ⊕ 🗑 📋 📄│
│  ▶Sex   13:00 🕐  01:00 🕐  14:00   00:00 🕐   [Equipa 2 ×] ▼ ⊕ 🗑 📋 📄│
│                                                                     │
│  Botões por linha: ⊕ adicionar linha | 🗑 remover | 📋 copiar | 📄 colar│
│  "Fim" = calculado automaticamente (Início + Duração − Pausa)      │
│  "Colaboradores" = tag input — pesquisa equipas e colaboradores    │
│                                                                     │
│ ─── Preço ────────────────────────────────────────────────────────  │
│ Preço/hora do local: €15,00                                        │
│ Calculado: 3 dias × 1h × €15 = €45,00/semana                      │
│ [ ] Override manual: [_____________]                                │
│                                                                     │
│ ─── Preview ─────────────────────────────────────────────────────── │
│ Próximas 4 ocorrências:                                            │
│ Seg 07/04, Qua 09/04, Sex 11/04, Seg 14/04 ...                   │
│                                                                     │
│ Notas                                                               │
│ [________________________________________________]                 │
│                                                                     │
│           [Cancelar]              [Guardar Contrato]                │
└─────────────────────────────────────────────────────────────────────┘
```

**Regras de comportamento:**
- Selecionar um dia na barra de dias → cria automaticamente uma linha na tabela de horários
- Desselecionar um dia → remove a linha correspondente (com confirmação se já tem dados)
- Linha na tabela tem: Início (time picker) | Duração (time picker) | Fim (readonly, calculado) | Pausa (time picker) | Colaboradores (tag input com equipas)
- "Copiar" na linha → guarda horário+equipa no clipboard; "Colar" noutra linha → aplica
- Periodicidade "Pontual" → esconde seletor de dias, mostra campo data única (vira serviço avulso)
- Preview atualiza em tempo real conforme os campos mudam

---

## Ecrã 11: Detalhe do Contrato (Sheet ao clicar na lista)

```
┌─────────────────────────────────────────────────────────────────────┐
│ Clínica ABC — R. das Flores 10                              [X]     │
├─────────────────────────────────────────────────────────────────────┤
│ Estado: ● Ativo                                                     │
│ Padrão: Semanal · Seg / Qua / Sex · 13:00–14:00                   │
│ Equipa: Equipa 2                                                    │
│ Desde: 24/03/2025  ·  Sem data fim                                 │
│ Preço/semana: €45,00                                               │
├─────────────────────────────────────────────────────────────────────┤
│ [✏ Editar]  [⏸ Pausar Contrato]  [🗑 Cancelar Contrato]           │
├─────────────────────────────────────────────────────────────────────┤
│ Próximas ocorrências (geradas)                                      │
│ ─────────────────────────────────────────────────────────────────── │
│ Seg 09/06  13:00–14:00  Equipa 2  ● Agendado                      │
│ Qua 11/06  13:00–14:00  Equipa 2  ● Agendado                      │
│ Sex 13/06  13:00–14:00  Equipa 2  ● Agendado                      │
│ ... [Ver todas]                                                     │
├─────────────────────────────────────────────────────────────────────┤
│ Histórico (últimas 10)                                             │
│ Sex 06/06  13:00–14:00  ✅ Concluído                               │
│ Qua 04/06  13:00–14:00  ✅ Concluído                               │
│ Seg 02/06  13:00–14:00  ❌ Falta                                   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Notas de Design

- **Responsivo:** todos os ecrãs web devem funcionar em tablet (1024px)
- **App mobile:** apenas os ecrãs 4, 5 e escala semanal
- **Paleta:** verde `#16A34A` (green-600), sidebar green-700, backgrounds green-50
- **Dark mode:** não prioritário para Fase 1
- **Acessibilidade:** contraste adequado, tamanhos de fonte legíveis
