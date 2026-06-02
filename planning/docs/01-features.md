# Funcionalidades — Especificação Completa

## Módulos do Sistema

### 1. Autenticação e Perfis

**Roles (papéis):**
- **Admin** — acesso total, configura o sistema, vê tudo
- **Gestor** — cria/edita agendamentos, gere equipas, vê relatórios
- **Colaborador** — acesso apenas à app mobile, vê a sua própria escala

**Login:**
- Admin/Gestor: email + password (web)
- Colaborador: telemóvel + OTP por SMS ou email (mobile/PWA)

**Segurança:**
- Row Level Security (RLS) no Supabase — cada user só vê os seus dados
- Sessões JWT com refresh automático

---

### 2. Gestão de Clientes

| Campo | Tipo | Notas |
|-------|------|-------|
| Nome/Razão Social | texto | obrigatório |
| NIF | texto | validação formato PT |
| Email | email | para faturas |
| Telefone | texto | |
| Morada | texto | |
| Tipo | individual / empresa | |
| Observações | texto longo | notas internas |
| Estado | ativo / inativo | |

**Ações:**
- Criar, editar, arquivar cliente
- Ver histórico de serviços do cliente
- Ver total faturado ao cliente (por período)
- Ver último serviço realizado

---

### 3. Gestão de Locais / Edifícios

Cada cliente pode ter vários locais.

| Campo | Tipo | Notas |
|-------|------|-------|
| Nome do local | texto | ex: "Edifício Central", "Loja Porto" |
| Cliente | FK cliente | |
| Morada completa | texto | |
| Coordenadas GPS | lat/lng | para mapa + validação de ponto |
| Código de acesso | texto | ex: código porta, instruções |
| Instruções | texto longo | notas para a equipa |
| Tipo de serviço | enum | limpeza regular, manutenção, pós-obra, etc. |
| Área em m² | número | para cálculo de duração estimada |
| Ativo | boolean | |

**Ações:**
- Criar/editar/arquivar local
- Ver no mapa
- Ver histórico de serviços neste local

---

### 4. Gestão de Colaboradores

| Campo | Tipo | Notas |
|-------|------|-------|
| Nome completo | texto | |
| Telefone | texto | usado como login na app |
| Email | email | alternativa de login |
| NIF | texto | |
| IBAN | texto | para folha de pagamento |
| Foto | imagem | armazenada no Supabase Storage |
| Horas contratadas/mês | número | ex: 168h |
| Valor hora | decimal | € por hora para cálculo de salário |
| Data início contrato | data | |
| Data fim contrato | data | null = contrato sem prazo |
| Dias de férias/ano | número | padrão legal PT: 22 dias |
| Disponibilidade | JSON | ex: {seg: true, ter: true, ...} |
| Competências | array | ex: ["vidros", "industrial"] |
| Estado | ativo / inativo / suspenso | |

**Ações:**
- CRUD completo
- Ver escala do colaborador
- Ver histórico de presenças
- Ver saldo de férias
- Ver folha de pagamento mensal
- Exportar dados do colaborador

---

### 5. Gestão de Equipas

| Campo | Tipo | Notas |
|-------|------|-------|
| Nome da equipa | texto | ex: "Equipa 01", "Equipa Norte" |
| Líder | FK colaborador | |
| Membros | array FK colaboradores | |
| Cor | hex color | para distinguir no calendário |
| Ativa | boolean | |

**Ações:**
- Criar/editar/arquivar equipa
- Adicionar/remover membros
- Ver disponibilidade da equipa num período
- Ver escala da equipa no calendário

---

### 6. Agendamento — Calendário

**Vista principal:**
- Semanal, com colunas por equipa (como ServiSync)
- Cada coluna = uma equipa
- Linhas = horas do dia (7h–22h)
- Evento = bloco colorido com: nome do local, hora início/fim, estado

**Criação de serviço:**
- Local (dropdown com pesquisa)
- Equipa (dropdown)
- Colaboradores específicos (opcional — se quiser selecionar dentro da equipa)
- Nº colaboradores adicionais além da equipa (para serviços com reforço)
- Data e hora de início
- Duração (horas:minutos)
- Tipo de serviço
- Valor calculado automaticamente (ou override manual)
- Notas/instruções específicas para este serviço
- Recorrência (ver secção abaixo)

**Estados do serviço:**
- `agendado` — criado, aguarda execução
- `em_curso` — colaborador fez clock-in
- `concluido` — colaborador fez clock-out
- `cancelado` — cancelado pelo gestor
- `falta` — nenhum colaborador apareceu

**Interações no calendário:**
- Clicar num serviço → abre painel de detalhes
- Arrastar serviço → reagenda (muda data/hora)
- Drag horizontal → muda de equipa
- Clique numa célula vazia → abre formulário de novo serviço

**Alertas visuais:**
- Conflito de horário na mesma equipa → borda vermelha
- Serviço sem equipa atribuída → cor cinza
- Colaborador em falta → ícone de aviso

---

### 7. Serviços Recorrentes

**Padrões de recorrência:**
- Diário (todos os dias, ou apenas dias úteis)
- Semanal (X dias por semana, ex: seg + qua + sex)
- Quinzenal
- Mensal (ex: dia 15 de cada mês, ou 1ª segunda-feira do mês)
- Personalizado (a cada N dias)

**Configuração:**
- Data de início
- Data de fim (ou "sem fim" = até cancelar)
- Exceções (ex: não repetir neste dia específico)

**Edição:**
- Editar apenas esta ocorrência
- Editar esta e todas as futuras
- Editar todas as ocorrências (altera o template)

**Geração automática:**
- O sistema gera as ocorrências do mês seguinte automaticamente (job agendado)
- Notifica o gestor caso haja conflitos gerados

---

### 8. Cálculo de Preço por Serviço

**Fórmula base:**
```
valor = duração_horas × preço_hora_local × nº_colaboradores
```

**Variáveis:**
- `preço_hora_local`: definido por cliente/local (pode ser diferente por cliente)
- `nº_colaboradores`: número de pessoas no serviço
- `duração_horas`: tempo agendado

**Overrides:**
- Desconto/acréscimo percentual por serviço
- Valor fixo manual (ignora fórmula)
- Histórico de alterações de preço (auditoria)

**Exemplo:**
- Local A: €15/hora
- Duração: 2h
- 3 colaboradores
- Valor = 2 × 15 × 3 = **€90**

---

### 9. App do Colaborador (PWA Mobile)

**Ecrã Home (hoje):**
- Lista de serviços do dia com hora e local
- Estado de cada serviço (a aguardar, em curso, concluído)
- Botão rápido "Iniciar" para fazer clock-in

**Ecrã de Serviço:**
- Endereço completo + botão "Navegar" (abre Google Maps/Waze)
- Instruções e checklist
- Equipamentos necessários
- Fotos do local (se existirem)
- Botão "Iniciar Serviço" → regista entrada com GPS
- Botão "Terminar Serviço" → regista saída com GPS

**Ecrã Escala:**
- Vista semanal pessoal (apenas os próprios serviços)
- Navegação por semanas
- Indicação de serviços futuros

**Ecrã Perfil:**
- Dados pessoais
- Saldo de férias
- Histórico de horas do mês atual

**Notificações push:**
- Novo serviço atribuído
- Serviço alterado (hora, local, etc.)
- Serviço cancelado
- Lembrete 1h antes do serviço

---

### 10. Registo de Ponto (Timesheet)

**Clock-in/Clock-out:**
- Via botão na app do colaborador
- Regista: timestamp + coordenadas GPS + precisão GPS
- Valida: coordenadas devem estar dentro de raio configurável do local (ex: 200m)
- Se fora do raio: aviso ao colaborador + flag na gestão (não bloqueia, apenas regista)

**Vista Gestão (tempo real):**
- Painel com todas as equipas e estado atual
- Verde = em serviço, Laranja = em deslocamento, Cinza = disponível
- Mapa com posição aproximada de cada equipa ativa

**Relatório de Ponto:**
- Por colaborador, por período
- Horas agendadas vs horas reais (por clock-in/out)
- Divergências assinaladas (chegou tarde, saiu cedo, etc.)

---

### 11. Gestão de Absentismo

**Tipos de ausência:**
- Doença (com baixa médica ou sem)
- Pessoal (justificado)
- Pessoal (injustificado)
- Férias
- Feriado
- Formação

**Registo:**
- Gestor regista a ausência com tipo e data(s)
- Colaborador pode registar via app (sujeito a aprovação)

**Substituição automática:**
- Quando se regista uma ausência, o sistema sugere substitutos:
  - Disponíveis na mesma data/hora
  - Com competências similares
  - Sem conflito de horário
- Gestor confirma o substituto com um clique

**Impacto no pagamento:**
- Faltas injustificadas: desconto automático no salário do mês

---

### 12. Mapa de Férias

**Vista:**
- Tabela anual: colaboradores nas linhas, dias do ano nas colunas
- Células coloridas: verde = férias aprovadas, amarelo = pendente, vermelho = conflito

**Regras:**
- Cada colaborador tem N dias de férias por ano (configurável, padrão 22 dias PT)
- Marcação feita pelo colaborador (app) ou gestor (web)
- Aprovação obrigatória pelo gestor
- Saldo calculado automaticamente: total - usados - pendentes

**Alertas:**
- Muitos colaboradores de férias ao mesmo tempo → aviso ao gestor
- Saldo insuficiente → bloqueio automático

---

### 13. Vista em Mapa

**Conteúdo:**
- Pins para cada serviço do dia selecionado
- Cor do pin = cor da equipa
- Clique no pin = detalhes do serviço

**Filtros:**
- Por data
- Por equipa (mostrar só uma)
- Por estado (só agendados, só em curso, etc.)

**Rotas:**
- Botão "Calcular Rotas" → Mapbox Directions API
- Mostra rota otimizada para cada equipa no dia
- Estimativa de tempo total de deslocamento por equipa

---

### 14. Relatórios de Desempenho

**Por Colaborador:**
- Horas contratadas / horas trabalhadas / ocupação %
- Saldo de horas (positivo ou negativo)
- Nº de faltas no período
- Pontualidade (% de serviços iniciados na hora)

**Por Equipa:**
- Serviços concluídos / cancelados / com faltas
- Horas trabalhadas totais
- Clientes servidos

**Por Cliente / Local:**
- Frequência de serviços (semana, mês, ano)
- Total faturado por período
- Médias de duração real vs agendada

**Exportação:**
- PDF (via jspdf, mesma lib do projeto EVOXE)
- CSV/Excel

---

### 15. Módulo Financeiro

*Ver [docs/07-financial-module.md](07-financial-module.md) para especificação completa.*

**Resumo:**
- Fechamento mensal de salários por colaborador
- Faturação a clientes (baseada em serviços concluídos)
- Dashboard financeiro: receita vs custo vs margem
- Exportação para contabilidade

---

## Funcionalidades Fora de Âmbito (por agora)

- Integração com software de contabilidade (Moloni, InvoiceXpress) — pode ser Fase 2
- App nativa (iOS/Android via React Native) — Fase 2
- Multi-empresa / SaaS — depende de decisão estratégica
- Avaliações de qualidade pelos clientes — Fase 2
- Chat interno entre colaboradores — fora de âmbito
- Requisições de material — Fase 2
