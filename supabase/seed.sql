-- ============================================================
-- SEED: dados fictícios para desenvolvimento
-- NÃO executar em produção
-- ============================================================

-- Empresa
INSERT INTO companies (id, name, slug) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Mó Limpezas', 'mo-limpezas');

INSERT INTO company_settings (company_id, hourly_rate, meal_allowance_day, vat_rate) VALUES
  ('00000000-0000-0000-0000-000000000001', 9.50, 9.60, 23.00);

-- NOTA: Profiles são criados via auth.users (trigger automático).
-- Para seed, usar o dashboard do Supabase para criar utilizadores
-- ou a API de admin. Os UUIDs abaixo são placeholders.

-- Clientes
INSERT INTO clients (id, company_id, name, nif, email, phone, type) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'Escritórios Central Lda', '501234567', 'central@exemplo.pt', '210000001', 'empresa'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'Clínica Saúde Plus', '502345678', 'clinica@exemplo.pt', '210000002', 'empresa'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
   'Escola Primária do Porto', '503456789', 'escola@exemplo.pt', '210000003', 'empresa'),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001',
   'Hotel Mar e Sol', '504567890', 'hotel@exemplo.pt', '210000004', 'empresa'),
  ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001',
   'Supermercado Bom Preço', '505678901', 'super@exemplo.pt', '210000005', 'empresa');

-- Locais
INSERT INTO locations (id, company_id, client_id, name, address, lat, lng, hourly_rate, service_type) VALUES
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   'Escritório Central — Piso 1', 'Rua do Comércio, 10, Porto', 41.1496, -8.6110, 15.00, 'limpeza_regular'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   'Escritório Central — Piso 2', 'Rua do Comércio, 10, Porto', 41.1496, -8.6110, 15.00, 'limpeza_regular'),
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002',
   'Clínica Saúde Plus — Recepção', 'Avenida da Boavista, 500, Porto', 41.1600, -8.6400, 18.00, 'limpeza_regular'),
  ('20000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   'Escola — Bloco A', 'Rua das Flores, 50, Matosinhos', 41.1800, -8.6900, 12.00, 'limpeza_regular'),
  ('20000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000004',
   'Hotel — Quartos andares 1-3', 'Avenida do Mar, 200, Leça', 41.2000, -8.7100, 20.00, 'limpeza_regular'),
  ('20000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000005',
   'Supermercado — Área de venda', 'Rua Nova, 80, Gaia', 41.1300, -8.6200, 14.00, 'limpeza_regular');

-- Teams (serão ligadas a profiles reais quando criares os utilizadores)
INSERT INTO teams (id, company_id, name, color) VALUES
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Equipa 01', '#16A34A'),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Equipa 02', '#3B82F6'),
  ('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Equipa 03', '#F59E0B');
