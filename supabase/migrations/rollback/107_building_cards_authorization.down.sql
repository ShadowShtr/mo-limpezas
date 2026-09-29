-- ROLLBACK BLOQUEADO: repor FOR ALL ou CRUD a authenticated reabre a falha
-- comprovada na SEC-01A. Corrigir qualquer incompatibilidade com uma migration
-- posterior que preserve o bloqueio de escrita directa.
DO $rollback_bloqueado$
BEGIN
  RAISE EXCEPTION
    'BUILDING_CARDS_107_ROLLBACK_BLOCKED: a reversão reabriria escrita directa; use migration corretiva';
END
$rollback_bloqueado$;
