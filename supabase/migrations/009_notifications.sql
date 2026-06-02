-- ============================================================
-- MIGRATION 009: notifications + push_subscriptions
-- ============================================================

CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  type        TEXT NOT NULL,
                -- 'new_service' | 'service_changed' | 'service_cancelled'
                -- | 'substitute_needed' | 'clock_out_missing'
                -- | 'vacation_approved' | 'vacation_rejected'
                -- | 'generation_conflict'

  title       TEXT NOT NULL,
  body        TEXT,
  data        JSONB,                    -- ex: {"service_id": "uuid"}
  read_at     TIMESTAMPTZ,

  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications(user_id) WHERE read_at IS NULL;

-- --------------------------------------------------------
-- Push subscriptions (Web Push VAPID)
-- --------------------------------------------------------
CREATE TABLE push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth_key    TEXT NOT NULL,
  user_agent  TEXT,

  created_at  TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, endpoint)
);

CREATE INDEX idx_push_subs_user ON push_subscriptions(user_id);

-- RLS
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own notifications" ON notifications
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY "managers create notifications" ON notifications
  FOR INSERT WITH CHECK (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "users manage own push subs" ON push_subscriptions
  FOR ALL USING (user_id = auth.uid());
