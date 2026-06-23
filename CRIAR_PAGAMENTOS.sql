-- ============================================================
-- Pagamentos Fixos e Variáveis — criar tabela + dados de Junho 2026
-- Cole TODO este conteúdo no Supabase → SQL Editor → Run.
-- Pode correr mais que uma vez (não duplica os dados de Junho).
-- ============================================================

-- 1) Tabela
CREATE TABLE IF NOT EXISTS fixed_variable_payments (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('fixo', 'variavel')),
  description   text NOT NULL,
  amount        numeric(10,2),
  due_date      date,
  direct_debit  boolean,
  status        text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pago', 'pendente')),
  recurring     boolean NOT NULL DEFAULT false,
  period_year   integer NOT NULL,
  period_month  integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  paid_at       timestamptz,
  notes         text,
  sort_order    integer DEFAULT 0,
  source_id     uuid,
  created_by    uuid REFERENCES profiles(id),
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fvp_company_period
  ON fixed_variable_payments(company_id, period_year, period_month, kind, sort_order);

ALTER TABLE fixed_variable_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "company members manage fixed variable payments" ON fixed_variable_payments;
CREATE POLICY "company members manage fixed variable payments"
  ON fixed_variable_payments
  USING (company_id IN (SELECT company_id FROM profiles WHERE id = auth.uid()));

-- 2) Dados de Junho 2026 (limpa antes para não duplicar)
DELETE FROM fixed_variable_payments
  WHERE company_id = '00000000-0000-0000-0000-000000000001'
    AND period_year = 2026 AND period_month = 6;

INSERT INTO fixed_variable_payments
  (company_id, kind, description, amount, due_date, direct_debit, status, recurring, period_year, period_month, sort_order, created_by)
VALUES
-- FIXOS
('00000000-0000-0000-0000-000000000001','fixo','RENDA ESCRITORIO',650.00,'2026-06-11',false,'pago',   true,2026,6,1,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','fixo','RENDA ATL',       550.00,NULL,        false,'pendente',true,2026,6,2,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','fixo','CONTABILISTA',    221.40,'2026-06-11',false,'pago',   true,2026,6,3,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','fixo','GARAGEM 1',       125.00,'2026-06-16',false,'pago',   true,2026,6,4,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','fixo','GARAGEM 2',       150.00,NULL,        false,'pago',   true,2026,6,5,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','fixo','BERLINGO',        245.93,'2026-06-16',false,'pago',   true,2026,6,6,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','fixo','RENDA MONICA',    800.00,NULL,        false,'pendente',true,2026,6,7,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','fixo','SERVISYNC',       100.00,'2026-11-09',false,'pago',   true,2026,6,8,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','fixo','DAIANE',         1377.60,NULL,        false,'pendente',true,2026,6,9,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','fixo','IVA (PRESTACAO)',  NULL,  NULL,        false,'pendente',true,2026,6,10,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','fixo','SEGURANCA SOCIAL', NULL,  NULL,        NULL, 'pendente',true,2026,6,11,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
-- VARIAVEIS
('00000000-0000-0000-0000-000000000001','variavel','SEGURO BMW',           327.54,'2026-06-22',true, 'pendente',false,2026,6,1,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','MEO LOJA',              77.02,'2026-06-19',false,'pendente',false,2026,6,2,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','NOS - casa',           195.85,'2026-06-19',true, 'pago',    false,2026,6,3,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','NOS - Escritorio',      77.02,'2026-06-19',false,'pendente',false,2026,6,4,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','NOS Fabio',              5.00,'2026-06-28',true, 'pago',    false,2026,6,5,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','ENDESA LOJA',           18.84,'2026-06-15',true, 'pago',    false,2026,6,6,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','SEGURO OPEL',           NULL,  NULL,        NULL, 'pendente',false,2026,6,7,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','Charb produtos',       126.64,'2026-06-11',false,'pago',    false,2026,6,8,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','CHARIB Maio',          291.26,'2026-06-16',false,'pago',    false,2026,6,9,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','ENDESA GARAGEM 2',      NULL,  NULL,        true, 'pendente',false,2026,6,10,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','UNIFORMES',             NULL,  NULL,        false,'pendente',false,2026,6,11,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','SEGURO BERLINGO',       93.07,'2026-06-25',true, 'pendente',false,2026,6,12,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','AGUA DE ALENQUER',      38.91,'2026-07-01',false,'pendente',false,2026,6,13,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','VR AUTOBOX FT FIZ2026/66',614.79,'2026-06-16',false,'pago', false,2026,6,14,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','Vitor - Virtual',      150.00,NULL,        NULL, 'pendente',false,2026,6,15,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','MEO barbie',           125.81,'2026-06-18',false,'pendente',false,2026,6,16,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','ENDESA ATL',            42.87,'2026-06-17',false,'pendente',false,2026,6,17,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','HIGIPROL FT2026/283',  289.91,'2026-06-11',false,'pago',    false,2026,6,18,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','HIGIPROL FT2026/320',  305.19,'2026-06-11',false,'pago',    false,2026,6,19,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','HIGIPROL FT2026/351',   43.67,NULL,        false,'pendente',false,2026,6,20,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','HIGIPROL FT2026/352',  237.37,NULL,        false,'pendente',false,2026,6,21,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','SERIECUT 2500/000468', 147.60,NULL,        NULL, 'pendente',false,2026,6,22,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','ENDESA GARAGEM 1',      NULL,  NULL,        NULL, 'pendente',false,2026,6,23,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','GOLD ENERGY',            5.22,'2026-06-15',true, 'pago',    false,2026,6,24,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','IUC - BERLINGO',        NULL,  NULL,        NULL, 'pendente',false,2026,6,25,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','Higiprol FT2026/382',  379.44,NULL,        NULL, 'pendente',false,2026,6,26,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','Higiprol FT2026/420',  328.88,NULL,        NULL, 'pendente',false,2026,6,27,'03def8bb-f7ae-4963-9a7d-78292b867d73'),
('00000000-0000-0000-0000-000000000001','variavel','SEGURO CLIO',          109.41,'2026-07-03',NULL, 'pendente',false,2026,6,28,'03def8bb-f7ae-4963-9a7d-78292b867d73');

SELECT kind, count(*) AS linhas, sum(amount) AS total FROM fixed_variable_payments
  WHERE company_id='00000000-0000-0000-0000-000000000001' AND period_year=2026 AND period_month=6
  GROUP BY kind;
