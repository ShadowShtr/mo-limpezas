# Esquema da Base de Dados

> PostgreSQL via Supabase. Todas as tabelas têm `created_at` e `updated_at` por padrão.

---

## Diagrama de Relações (simplificado)

```
profiles (colaboradores/gestores)
    │
    ├──< team_members >── teams ──< service_assignments
    │                        │
    │                        └──< services >── locations >── clients
    │                                │
    │                                └──< recurrence_rules
    │
    ├──< timesheets (clock-in/out por serviço)
    ├──< absences
    ├──< vacation_requests
    └──< payroll_records
                               clients ──< invoices ──< invoice_items
```

---

## Tabelas

### `profiles`
Extensão da tabela `auth.users` do Supabase.

```sql
CREATE TABLE profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name     TEXT NOT NULL,
  phone         TEXT UNIQUE,
  email         TEXT,
  nif           TEXT,
  iban          TEXT,
  avatar_url    TEXT,
  role          TEXT NOT NULL DEFAULT 'colaborador'
                  CHECK (role IN ('admin', 'gestor', 'colaborador')),
  
  -- Dados de contrato
  contracted_hours_month  NUMERIC(5,2) DEFAULT 168,
  hourly_rate             NUMERIC(8,2),           -- custo/hora para folha pagamento
  contract_start          DATE,
  contract_end            DATE,                   -- null = sem prazo
  vacation_days_year      INTEGER DEFAULT 22,
  
  -- Disponibilidade semanal
  availability            JSONB DEFAULT '{"mon":true,"tue":true,"wed":true,"thu":true,"fri":true,"sat":false,"sun":false}',
  
  -- Skills/competências
  skills                  TEXT[] DEFAULT '{}',
  
  status                  TEXT DEFAULT 'ativo'
                            CHECK (status IN ('ativo', 'inativo', 'suspenso')),
  
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
```

---

### `clients`

```sql
CREATE TABLE clients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  nif         TEXT,
  email       TEXT,
  phone       TEXT,
  address     TEXT,
  type        TEXT DEFAULT 'empresa' CHECK (type IN ('individual', 'empresa')),
  notes       TEXT,
  status      TEXT DEFAULT 'ativo' CHECK (status IN ('ativo', 'inativo')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
```

---

### `locations`
Cada cliente pode ter vários locais.

```sql
CREATE TABLE locations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,             -- "Edifício Central", "Loja Porto"
  address         TEXT NOT NULL,
  lat             NUMERIC(10,7),             -- coordenadas GPS
  lng             NUMERIC(10,7),
  access_code     TEXT,                      -- código porta, instruções acesso
  instructions    TEXT,                      -- notas para a equipa
  service_type    TEXT DEFAULT 'limpeza_regular'
                    CHECK (service_type IN (
                      'limpeza_regular', 'manutencao', 'pos_obra',
                      'vidros', 'carpetes', 'industrial', 'outro'
                    )),
  area_sqm        NUMERIC(8,2),              -- área em m²
  hourly_rate     NUMERIC(8,2),              -- preço/hora cobrado AO CLIENTE neste local
  gps_radius_m    INTEGER DEFAULT 200,       -- raio validação ponto em metros
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

---

### `teams`

```sql
CREATE TABLE teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  leader_id   UUID REFERENCES profiles(id),
  color       TEXT DEFAULT '#3B82F6',        -- hex color para calendário
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
```

---

### `team_members`
Relação N:N entre equipas e colaboradores.

```sql
CREATE TABLE team_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  collaborator_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  joined_at       DATE DEFAULT CURRENT_DATE,
  left_at         DATE,                      -- null = ainda na equipa
  UNIQUE(team_id, collaborator_id)
);
```

---

### `recurrence_rules`
Template de regras para serviços recorrentes.

```sql
CREATE TABLE recurrence_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Padrão
  frequency       TEXT NOT NULL
                    CHECK (frequency IN ('daily', 'weekly', 'biweekly', 'monthly', 'custom')),
  interval_days   INTEGER DEFAULT 1,         -- para custom: a cada N dias
  
  -- Para weekly/biweekly: dias da semana (0=dom, 1=seg, ..., 6=sab)
  weekdays        INTEGER[] DEFAULT '{}',
  
  -- Para monthly: qual dia do mês, ou qual semana+dia
  month_day       INTEGER,                   -- ex: 15 = dia 15 do mês
  month_week      INTEGER,                   -- ex: 1 = primeira semana
  month_weekday   INTEGER,                   -- ex: 1 = segunda-feira
  
  -- Período de validade
  starts_on       DATE NOT NULL,
  ends_on         DATE,                      -- null = sem fim
  
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

---

### `services`
O coração do sistema. Cada serviço é uma ocorrência agendada.

```sql
CREATE TABLE services (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Relações
  location_id         UUID NOT NULL REFERENCES locations(id),
  team_id             UUID REFERENCES teams(id),
  recurrence_rule_id  UUID REFERENCES recurrence_rules(id),  -- null = único
  
  -- Quando
  scheduled_start     TIMESTAMPTZ NOT NULL,
  scheduled_end       TIMESTAMPTZ NOT NULL,
  
  -- Equipa/Pessoal
  num_collaborators   INTEGER DEFAULT 1,     -- nº de pessoas no serviço
  
  -- Preço
  hourly_rate         NUMERIC(8,2),          -- copiado de locations.hourly_rate, editável
  calculated_value    NUMERIC(10,2),         -- valor calculado automaticamente
  manual_override     NUMERIC(10,2),         -- se preenchido, usa este em vez do calculado
  discount_pct        NUMERIC(5,2) DEFAULT 0,
  
  -- Estado
  status              TEXT DEFAULT 'agendado'
                        CHECK (status IN (
                          'agendado', 'em_curso', 'concluido', 'cancelado', 'falta'
                        )),
  
  -- Recorrência: se este serviço é uma exceção (editado individualmente)
  is_exception        BOOLEAN DEFAULT FALSE,
  original_date       DATE,                  -- data original antes de ser movido
  
  -- Notas
  notes               TEXT,
  
  -- Timestamps reais (preenchidos pelo clock-in/out)
  actual_start        TIMESTAMPTZ,
  actual_end          TIMESTAMPTZ,
  
  created_by          UUID REFERENCES profiles(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX idx_services_scheduled_start ON services(scheduled_start);
CREATE INDEX idx_services_team_id ON services(team_id);
CREATE INDEX idx_services_location_id ON services(location_id);
CREATE INDEX idx_services_status ON services(status);
```

---

### `service_collaborators`
Colaboradores específicos atribuídos a um serviço (além da equipa genérica).

```sql
CREATE TABLE service_collaborators (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id      UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  collaborator_id UUID NOT NULL REFERENCES profiles(id),
  role            TEXT DEFAULT 'membro' CHECK (role IN ('lider', 'membro')),
  UNIQUE(service_id, collaborator_id)
);
```

---

### `timesheets`
Registo de ponto por serviço.

```sql
CREATE TABLE timesheets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id          UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  collaborator_id     UUID NOT NULL REFERENCES profiles(id),
  
  -- Clock-in
  clock_in_at         TIMESTAMPTZ,
  clock_in_lat        NUMERIC(10,7),
  clock_in_lng        NUMERIC(10,7),
  clock_in_distance_m INTEGER,               -- distância ao local no momento do check-in
  
  -- Clock-out
  clock_out_at        TIMESTAMPTZ,
  clock_out_lat       NUMERIC(10,7),
  clock_out_lng       NUMERIC(10,7),
  
  -- Calculado
  duration_minutes    INTEGER,               -- calculado: clock_out - clock_in
  
  -- Flags
  location_warning    BOOLEAN DEFAULT FALSE, -- estava longe do local?
  
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(service_id, collaborator_id)
);
```

---

### `absences`

```sql
CREATE TABLE absences (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collaborator_id     UUID NOT NULL REFERENCES profiles(id),
  
  absence_type        TEXT NOT NULL
                        CHECK (absence_type IN (
                          'doenca_com_baixa', 'doenca_sem_baixa',
                          'pessoal_justificado', 'pessoal_injustificado',
                          'ferias', 'feriado', 'formacao'
                        )),
  
  starts_on           DATE NOT NULL,
  ends_on             DATE NOT NULL,
  
  notes               TEXT,
  approved_by         UUID REFERENCES profiles(id),
  
  -- Substituição
  replaced_by         UUID REFERENCES profiles(id),  -- null = não substituído
  
  created_by          UUID REFERENCES profiles(id),
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
```

---

### `vacation_requests`

```sql
CREATE TABLE vacation_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collaborator_id   UUID NOT NULL REFERENCES profiles(id),
  
  starts_on         DATE NOT NULL,
  ends_on           DATE NOT NULL,
  days_count        INTEGER,                 -- calculado (exclui fins de semana e feriados)
  
  status            TEXT DEFAULT 'pendente'
                      CHECK (status IN ('pendente', 'aprovado', 'rejeitado')),
  
  notes             TEXT,
  rejection_reason  TEXT,
  reviewed_by       UUID REFERENCES profiles(id),
  reviewed_at       TIMESTAMPTZ,
  
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
```

---

### `invoices`
Faturas emitidas a clientes.

```sql
CREATE TABLE invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id),
  
  invoice_number  TEXT UNIQUE NOT NULL,      -- gerado automaticamente: "F2024/001"
  invoice_date    DATE NOT NULL,
  due_date        DATE,
  
  period_start    DATE,                      -- período de faturação
  period_end      DATE,
  
  subtotal        NUMERIC(10,2) NOT NULL,
  vat_rate        NUMERIC(5,2) DEFAULT 23,   -- %
  vat_amount      NUMERIC(10,2),
  total           NUMERIC(10,2) NOT NULL,
  
  status          TEXT DEFAULT 'pendente'
                    CHECK (status IN ('rascunho', 'pendente', 'pago', 'vencido', 'cancelado')),
  
  paid_at         TIMESTAMPTZ,
  notes           TEXT,
  
  created_by      UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

---

### `invoice_items`

```sql
CREATE TABLE invoice_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id    UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  service_id    UUID REFERENCES services(id),  -- null = item manual
  
  description   TEXT NOT NULL,
  quantity      NUMERIC(8,2) NOT NULL,          -- ex: horas
  unit_price    NUMERIC(8,2) NOT NULL,
  total         NUMERIC(10,2) NOT NULL,
  
  sort_order    INTEGER DEFAULT 0
);
```

---

### `payroll_records`
Fechamento mensal de salário por colaborador.

```sql
CREATE TABLE payroll_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collaborator_id       UUID NOT NULL REFERENCES profiles(id),
  
  period_year           INTEGER NOT NULL,
  period_month          INTEGER NOT NULL,         -- 1-12
  
  -- Horas
  contracted_hours      NUMERIC(6,2),             -- horas contratadas no mês
  worked_hours          NUMERIC(6,2),             -- horas reais (via timesheets)
  absence_hours         NUMERIC(6,2) DEFAULT 0,
  
  -- Valores
  hourly_rate           NUMERIC(8,2),             -- valor/hora no período
  gross_salary          NUMERIC(10,2),            -- salário bruto calculado
  absence_deductions    NUMERIC(10,2) DEFAULT 0,
  other_deductions      NUMERIC(10,2) DEFAULT 0,
  other_additions       NUMERIC(10,2) DEFAULT 0,  -- ex: subsídio alimentação
  net_salary            NUMERIC(10,2),
  
  status                TEXT DEFAULT 'rascunho'
                          CHECK (status IN ('rascunho', 'aprovado', 'pago')),
  
  notes                 TEXT,
  approved_by           UUID REFERENCES profiles(id),
  paid_at               TIMESTAMPTZ,
  
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(collaborator_id, period_year, period_month)
);
```

---

### `notifications`

```sql
CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES profiles(id),
  
  type            TEXT NOT NULL,             -- 'new_service', 'service_changed', etc.
  title           TEXT NOT NULL,
  body            TEXT,
  data            JSONB,                     -- dados extras (ex: service_id)
  
  read_at         TIMESTAMPTZ,               -- null = não lida
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

---

### `push_subscriptions`
Subscriptions Web Push dos browsers dos colaboradores.

```sql
CREATE TABLE push_subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES profiles(id),
  
  endpoint        TEXT NOT NULL,
  p256dh          TEXT NOT NULL,
  auth_key        TEXT NOT NULL,
  
  user_agent      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(user_id, endpoint)
);
```

---

## Row Level Security (RLS) — Resumo

```sql
-- Colaborador: só vê os seus serviços
SELECT * FROM services WHERE id IN (
  SELECT service_id FROM service_collaborators
  WHERE collaborator_id = auth.uid()
);

-- Gestor/Admin: vê tudo
-- (via role check na função auth.jwt())

-- Timesheets: colaborador só vê as suas próprias
-- Invoices: só gestor/admin
-- Payroll: só gestor/admin (ou colaborador vê os seus)
```

Políticas detalhadas serão escritas durante a Fase 1 do desenvolvimento.

---

## Views Úteis (a criar)

```sql
-- Serviços com informação completa (para calendário)
CREATE VIEW services_full AS
SELECT s.*, l.name AS location_name, l.address, l.lat, l.lng,
       c.name AS client_name, t.name AS team_name, t.color AS team_color
FROM services s
JOIN locations l ON s.location_id = l.id
JOIN clients c ON l.client_id = c.id
LEFT JOIN teams t ON s.team_id = t.id;

-- Resumo mensal por colaborador (para relatórios)
CREATE VIEW monthly_hours AS
SELECT p.id, p.full_name,
       DATE_TRUNC('month', ts.clock_in_at) AS month,
       SUM(ts.duration_minutes) / 60.0 AS total_hours
FROM timesheets ts
JOIN profiles p ON ts.collaborator_id = p.id
GROUP BY p.id, p.full_name, DATE_TRUNC('month', ts.clock_in_at);
```
