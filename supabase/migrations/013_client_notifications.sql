-- ============================================================
-- MIGRATION 013: notificações a clientes (SMS + Email)
-- ============================================================

-- Campos de notificação na tabela clients
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS notification_enabled  BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS notification_method   TEXT    DEFAULT 'email'
    CHECK (notification_method IN ('sms', 'email', 'both')),
  ADD COLUMN IF NOT EXISTS notification_phone    TEXT,
  ADD COLUMN IF NOT EXISTS notification_email    TEXT;

-- --------------------------------------------------------
-- Histórico de avisos enviados a clientes
-- --------------------------------------------------------
CREATE TABLE client_notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  client_id     UUID NOT NULL REFERENCES clients(id)    ON DELETE CASCADE,
  service_id    UUID          REFERENCES services(id)   ON DELETE SET NULL,

  method        TEXT NOT NULL DEFAULT 'email'
                CHECK (method IN ('sms', 'email')),
  status        TEXT NOT NULL DEFAULT 'enviado'
                CHECK (status IN ('pendente', 'enviado', 'falhou')),

  sent_at       TIMESTAMPTZ DEFAULT NOW(),
  message_body  TEXT,
  contact_used  TEXT,           -- número ou email usado no envio

  created_by    UUID REFERENCES profiles(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_client_notifs_company   ON client_notifications(company_id, sent_at DESC);
CREATE INDEX idx_client_notifs_client    ON client_notifications(client_id, sent_at DESC);
CREATE INDEX idx_client_notifs_service   ON client_notifications(service_id);

-- RLS
ALTER TABLE client_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "managers manage client notifications" ON client_notifications
  FOR ALL USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );
