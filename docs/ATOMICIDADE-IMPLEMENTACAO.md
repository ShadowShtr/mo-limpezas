# Atomicidade - Implementacao

## Estado inicial

| Item | Valor |
| ---- | ----- |
| Branch atual | `fix/atomic-contract-calendar-sync` |
| Commit-base local | `5581784` |
| Branch antes do isolamento | `master` |
| Backup | `backups/atomicidade-pre-064` |
| Registros no backup | 5820 |
| Migration 064 no repositorio | arquivo local nao rastreado |
| Migration 064 em `public._migrations` | nao registrada |
| Migration 064 em `supabase_migrations.schema_migrations` | nao registrada |
| `contracts.revision` no banco | existe |
| `public.domain_mutations` no banco | existe |
| `public.company_change_events` no banco | existe |

## Tabela de fases

| Fase | Estado | Arquivos | Testes | Observacoes |
| ---- | ------ | -------- | ------ | ----------- |
| 0 - Seguranca e isolamento | Bloqueada | `docs/ATOMICIDADE-IMPLEMENTACAO.md` | consultas read-only ao banco; backup read-only | A 064 aparece parcialmente aplicada/no schema, mas nao esta registrada nas tabelas de migrations. Pelo plano, parar e nao continuar sem decisao explicita. |

## Bloqueio

Foi detectado estado parcial ou nao rastreado da migration 064:

- `contracts.revision` ja existe.
- `public.domain_mutations` ja existe.
- `public.company_change_events` ja existe.
- `public._migrations` nao registra arquivo `064%`.
- `supabase_migrations.schema_migrations` retornou zero linhas.

## Risco

Continuar editando ou reaplicando a migration 064 pode:

- falhar por objetos ja existentes com definicao diferente;
- mascarar drift entre banco e repositorio;
- quebrar idempotencia real;
- criar schema local diferente de producao;
- impedir rollback confiavel.

## Opcoes

1. Auditar o schema atual dessas estruturas e criar `065_fix_domain_atomicity_outbox.sql` corretiva.
2. Se for uma base descartavel/dev, restaurar para antes da aplicacao parcial e recriar a 064 limpa.
3. Se a 064 foi aplicada manualmente em producao, registrar esse fato e nunca editar silenciosamente a 064 aplicada; usar migration 065.

## Recomendacao

Criar migration `065_fix_domain_atomicity_outbox.sql`, depois de comparar a definicao atual de:

- `domain_mutations`;
- `company_change_events`;
- `company_sync_state`;
- triggers de `revision`;
- grants/RLS;
- funcoes RPC existentes.

## Evidencia faltante

- Confirmar em qual ambiente a 064 foi aplicada parcialmente.
- Confirmar se esse ambiente e producao, staging ou dev.
- Confirmar se ha backup de infraestrutura/Supabase alem do backup local read-only.


---

# Auditoria real do schema antes da 065

Data da auditoria: 2026-08-04T10:37:08.401Z.
Consulta read-only; nenhum SQL foi aplicado.

Artefatos brutos:

- `docs/atomicidade-audit/schema-audit.json`
- `docs/atomicidade-audit/backup-restore-readiness.json`

## 1. Colunas revision / override / ocorrencia

| table_name | column_name | data_type | is_nullable | column_default |
| --- | --- | --- | --- | --- |
| clients | revision | integer | NO | 1 |
| contracts | revision | integer | NO | 1 |
| invoice_items | revision | integer | NO | 1 |
| invoices | revision | integer | NO | 1 |
| locations | revision | integer | NO | 1 |
| services | override_fields | ARRAY | NO | '{}'::text[] |
| services | revision | integer | NO | 1 |
| team_members | revision | integer | NO | 1 |
| teams | revision | integer | NO | 1 |

Conclusoes:

- Tabelas com `revision`: `clients`, `contracts`, `invoice_items`, `invoices`, `locations`, `services`, `team_members`, `teams`.
- Todas as `revision` estao como `integer NOT NULL DEFAULT 1`, nao `bigint`.
- `services.override_fields` existe como `text[] NOT NULL DEFAULT '{}'::text[]`.
- `occurrence_date` nao existe.
- `source_contract_revision` nao existe.
- Colunas adicionais nao previstas pelo plano atual: `revision` em `team_members` e `invoice_items`.

## 2. Triggers de revisao

| event_object_table | trigger_name | action_timing | event_manipulation | action_statement |
| --- | --- | --- | --- | --- |
| clients | trg_clients_revision | BEFORE | UPDATE | EXECUTE FUNCTION fn_increment_revision() |
| contracts | trg_contracts_revision | BEFORE | UPDATE | EXECUTE FUNCTION fn_increment_revision() |
| invoice_items | trg_invoice_items_revision | BEFORE | UPDATE | EXECUTE FUNCTION fn_increment_revision() |
| invoices | trg_invoices_revision | BEFORE | UPDATE | EXECUTE FUNCTION fn_increment_revision() |
| locations | trg_locations_revision | BEFORE | UPDATE | EXECUTE FUNCTION fn_increment_revision() |
| services | trg_services_revision | BEFORE | UPDATE | EXECUTE FUNCTION fn_increment_revision() |
| team_members | trg_team_members_revision | BEFORE | UPDATE | EXECUTE FUNCTION fn_increment_revision() |
| teams | trg_teams_revision | BEFORE | UPDATE | EXECUTE FUNCTION fn_increment_revision() |

Funcao instalada:

```sql
CREATE OR REPLACE FUNCTION public.fn_increment_revision()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.revision := COALESCE(OLD.revision, 0) + 1;
  RETURN NEW;
END;
$function$

```

Conclusoes:

- Ha um trigger de revision por tabela listada acima.
- A funcao incrementa `NEW.revision := COALESCE(OLD.revision, 0) + 1`.
- Nas funcoes auditadas nao foi encontrado `revision = revision + 1`; o incremento vem do trigger.
- O tipo atual e `integer`; a 065 deve converter para `bigint` nas tabelas aprovadas.

## 3. Schema real de domain_mutations / company_change_events / company_sync_state

| table_name | column_name | data_type | is_nullable | column_default |
| --- | --- | --- | --- | --- |
| company_change_events | id | uuid | NO | gen_random_uuid() |
| company_change_events | company_id | uuid | NO |  |
| company_change_events | sequence | bigint | NO |  |
| company_change_events | mutation_id | uuid | NO |  |
| company_change_events | domain | text | NO |  |
| company_change_events | event_type | text | NO |  |
| company_change_events | entity_ids | ARRAY | NO | '{}'::uuid[] |
| company_change_events | scopes | ARRAY | NO | '{}'::text[] |
| company_change_events | affected_range | tstzrange | YES |  |
| company_change_events | payload | jsonb | NO | '{}'::jsonb |
| company_change_events | delivered_at | timestamp with time zone | YES |  |
| company_change_events | created_at | timestamp with time zone | NO | now() |
| domain_mutations | id | uuid | NO | gen_random_uuid() |
| domain_mutations | company_id | uuid | NO |  |
| domain_mutations | mutation_id | uuid | NO |  |
| domain_mutations | domain | text | NO |  |
| domain_mutations | status | text | NO |  |
| domain_mutations | result | jsonb | NO | '{}'::jsonb |
| domain_mutations | created_at | timestamp with time zone | NO | now() |

Identity de sequence:

| table_name | column_name | is_identity | identity_generation | column_default |
| --- | --- | --- | --- | --- |
| company_change_events | sequence | YES | BY DEFAULT |  |

Conclusoes:

- `company_sync_state` nao existe.
- `company_change_events.sequence` e `IDENTITY BY DEFAULT`; isso viola a sequencia transacional por empresa exigida.
- `company_change_events.delivered_at` existe; o plano manda remover/nao usar.
- `company_change_events.affected_range` existe; o plano pede `affected_from` e `affected_to`.
- `domain_mutations.operation` nao existe.
- `domain_mutations.entity_id` nao existe.
- `domain_mutations.request_hash` nao existe.
- `domain_mutations.completed_at` nao existe.

## 4. Indices e constraints

Indices:

| tablename | indexname | indexdef |
| --- | --- | --- |
| cash_flow_entries | cash_flow_entries_pkey | CREATE UNIQUE INDEX cash_flow_entries_pkey ON public.cash_flow_entries USING btree (id) |
| cash_flow_entries | cash_flow_entries_reference_unique | CREATE UNIQUE INDEX cash_flow_entries_reference_unique ON public.cash_flow_entries USING btree (company_id, reference_type, reference_id) WHERE ((reference_type IS NOT NULL) AND (reference_id IS NOT NULL)) |
| cash_flow_entries | idx_cash_flow_company_date | CREATE INDEX idx_cash_flow_company_date ON public.cash_flow_entries USING btree (company_id, date DESC) |
| company_change_events | company_change_events_company_id_mutation_id_domain_event_t_key | CREATE UNIQUE INDEX company_change_events_company_id_mutation_id_domain_event_t_key ON public.company_change_events USING btree (company_id, mutation_id, domain, event_type) |
| company_change_events | company_change_events_company_id_sequence_key | CREATE UNIQUE INDEX company_change_events_company_id_sequence_key ON public.company_change_events USING btree (company_id, sequence) |
| company_change_events | company_change_events_pkey | CREATE UNIQUE INDEX company_change_events_pkey ON public.company_change_events USING btree (id) |
| company_change_events | idx_company_change_events_pending | CREATE INDEX idx_company_change_events_pending ON public.company_change_events USING btree (company_id, sequence) WHERE (delivered_at IS NULL) |
| domain_mutations | domain_mutations_company_id_mutation_id_key | CREATE UNIQUE INDEX domain_mutations_company_id_mutation_id_key ON public.domain_mutations USING btree (company_id, mutation_id) |
| domain_mutations | domain_mutations_pkey | CREATE UNIQUE INDEX domain_mutations_pkey ON public.domain_mutations USING btree (id) |
| services | idx_services_company_date | CREATE INDEX idx_services_company_date ON public.services USING btree (company_id, scheduled_start) |
| services | idx_services_company_scheduled | CREATE INDEX idx_services_company_scheduled ON public.services USING btree (company_id, scheduled_start) WHERE (status <> ALL (ARRAY['cancelado'::text, 'concluido'::text])) |
| services | idx_services_company_status_scheduled | CREATE INDEX idx_services_company_status_scheduled ON public.services USING btree (company_id, status, scheduled_start) |
| services | idx_services_company_team_scheduled | CREATE INDEX idx_services_company_team_scheduled ON public.services USING btree (company_id, team_id, scheduled_start) |
| services | idx_services_contract | CREATE INDEX idx_services_contract ON public.services USING btree (contract_id) |
| services | idx_services_location | CREATE INDEX idx_services_location ON public.services USING btree (location_id) |
| services | idx_services_payment_pending | CREATE INDEX idx_services_payment_pending ON public.services USING btree (company_id, payment_status, scheduled_start) |
| services | idx_services_status | CREATE INDEX idx_services_status ON public.services USING btree (company_id, status) |
| services | idx_services_team | CREATE INDEX idx_services_team ON public.services USING btree (team_id) |
| services | services_company_ref_unique | CREATE UNIQUE INDEX services_company_ref_unique ON public.services USING btree (company_id, reference_number) |
| services | services_pkey | CREATE UNIQUE INDEX services_pkey ON public.services USING btree (id) |

Constraints:

| table_name | conname | contype | definition |
| --- | --- | --- | --- |
| cash_flow_entries | cash_flow_entries_category_check | c | CHECK ((category = ANY (ARRAY['faturacao'::text, 'salario'::text, 'despesa'::text, 'fornecedor'::text, 'outro'::text]))) |
| cash_flow_entries | cash_flow_entries_company_id_fkey | f | FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE |
| cash_flow_entries | cash_flow_entries_created_by_fkey | f | FOREIGN KEY (created_by) REFERENCES profiles(id) |
| cash_flow_entries | cash_flow_entries_pkey | p | PRIMARY KEY (id) |
| cash_flow_entries | cash_flow_entries_reference_type_check | c | CHECK ((reference_type = ANY (ARRAY['invoice'::text, 'payroll'::text, 'service_payment'::text]))) |
| cash_flow_entries | cash_flow_entries_status_check | c | CHECK ((status = ANY (ARRAY['pendente'::text, 'confirmado'::text]))) |
| cash_flow_entries | cash_flow_entries_type_check | c | CHECK ((type = ANY (ARRAY['entrada'::text, 'saida'::text]))) |
| company_change_events | company_change_events_company_id_fkey | f | FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE |
| company_change_events | company_change_events_company_id_mutation_id_domain_event_t_key | u | UNIQUE (company_id, mutation_id, domain, event_type) |
| company_change_events | company_change_events_company_id_sequence_key | u | UNIQUE (company_id, sequence) |
| company_change_events | company_change_events_pkey | p | PRIMARY KEY (id) |
| domain_mutations | domain_mutations_company_id_fkey | f | FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE |
| domain_mutations | domain_mutations_company_id_mutation_id_key | u | UNIQUE (company_id, mutation_id) |
| domain_mutations | domain_mutations_pkey | p | PRIMARY KEY (id) |
| domain_mutations | domain_mutations_status_check | c | CHECK ((status = 'completed'::text)) |
| services | services_cancel_type_check | c | CHECK ((cancel_type = ANY (ARRAY['client_request'::text, 'weather'::text, 'operational'::text, 'equipment'::text, 'other'::text]))) |
| services | services_cancelled_by_fkey | f | FOREIGN KEY (cancelled_by) REFERENCES profiles(id) |
| services | services_cleaning_type_chk | c | CHECK (((cleaning_type IS NULL) OR (cleaning_type = ANY (ARRAY['manutencao'::text, 'manutencao_lisboa'::text, 'pos_obra'::text, 'pos_obra_lisboa'::text, 'geral'::text, 'geral_lisboa'::text, 'estofos'::text])))) |
| services | services_company_id_fkey | f | FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE |
| services | services_contract_id_fkey | f | FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE SET NULL |
| services | services_created_by_fkey | f | FOREIGN KEY (created_by) REFERENCES profiles(id) |
| services | services_location_id_fkey | f | FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT |
| services | services_num_people_chk | c | CHECK ((num_people >= 1)) |
| services | services_payment_status_chk | c | CHECK (((payment_status IS NULL) OR (payment_status = ANY (ARRAY['nao_informado'::text, 'sinal_50'::text, 'pago_total'::text])))) |
| services | services_pkey | p | PRIMARY KEY (id) |
| services | services_status_check | c | CHECK ((status = ANY (ARRAY['agendado'::text, 'em_curso'::text, 'concluido'::text, 'cancelado'::text, 'falta'::text, 'sem_cobertura'::text]))) |
| services | services_team_id_fkey | f | FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL |
| services | services_upholstery_type_chk | c | CHECK (((upholstery_type IS NULL) OR (upholstery_type = ANY (ARRAY['sofa'::text, 'poltrona'::text, 'cadeira'::text, 'tapete'::text, 'colchao'::text, 'unidade'::text, 'outro'::text])))) |

Conclusoes:

- Unicidade de mutation: `domain_mutations(company_id, mutation_id)`.
- Unicidade de evento atual: `company_change_events(company_id, mutation_id, domain, event_type)`, diferente do plano `UNIQUE(company_id, mutation_id)`.
- Unicidade de sequencia atual: `company_change_events(company_id, sequence)`, mas `sequence` vem de IDENTITY global.
- Indice real para caixa: `cash_flow_entries_reference_unique ON (company_id, reference_type, reference_id) WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL`. O `ON CONFLICT` atual corresponde a este indice.
- Nao existe unicidade de ocorrencia em `services(contract_id, occurrence_date)`; `occurrence_date` tambem nao existe.
- Auditoria de duplicados por `contract_id` + data de Lisboa retornou 0 linhas na amostra consultada.

## 5. Funcoes reais instaladas

Metadados:

| proname | arguments | security_definer | proconfig | owner |
| --- | --- | --- | --- | --- |
| delete_client_atomic | p_client_id uuid, p_company_id uuid, p_actor uuid, p_mutation_id uuid, p_expected_revision integer | true | search_path=public | postgres |
| fn_increment_revision |  | false |  | postgres |
| record_company_change_event | p_company_id uuid, p_mutation_id uuid, p_domain text, p_event_type text, p_entity_ids uuid[], p_scopes text[], p_affected_range tstzrange, p_payload jsonb | true | search_path=public | postgres |
| set_invoice_status_atomic | p_invoice_id uuid, p_company_id uuid, p_actor uuid, p_status text, p_payment_method text, p_mutation_id uuid, p_expected_revision integer | true | search_path=public | postgres |

### fn_increment_revision

Assinatura: `fn_increment_revision()`

```sql
CREATE OR REPLACE FUNCTION public.fn_increment_revision()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.revision := COALESCE(OLD.revision, 0) + 1;
  RETURN NEW;
END;
$function$

```

### record_company_change_event

Assinatura: `record_company_change_event(uuid,uuid,text,text,uuid[],text[],tstzrange,jsonb)`

```sql
CREATE OR REPLACE FUNCTION public.record_company_change_event(p_company_id uuid, p_mutation_id uuid, p_domain text, p_event_type text, p_entity_ids uuid[], p_scopes text[], p_affected_range tstzrange DEFAULT NULL::tstzrange, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_event public.company_change_events;
BEGIN
  INSERT INTO public.company_change_events (
    company_id, mutation_id, domain, event_type, entity_ids, scopes, affected_range, payload
  )
  VALUES (
    p_company_id,
    p_mutation_id,
    p_domain,
    p_event_type,
    COALESCE(p_entity_ids, '{}'),
    COALESCE(p_scopes, '{}'),
    p_affected_range,
    COALESCE(p_payload, '{}'::jsonb)
  )
  ON CONFLICT (company_id, mutation_id, domain, event_type)
  DO UPDATE SET payload = EXCLUDED.payload
  RETURNING * INTO v_event;

  RETURN jsonb_build_object(
    'event_id', v_event.id,
    'sequence', v_event.sequence
  );
END;
$function$

```

### set_invoice_status_atomic

Assinatura: `set_invoice_status_atomic(uuid,uuid,uuid,text,text,uuid,integer)`

```sql
CREATE OR REPLACE FUNCTION public.set_invoice_status_atomic(p_invoice_id uuid, p_company_id uuid, p_actor uuid, p_status text, p_payment_method text DEFAULT NULL::text, p_mutation_id uuid DEFAULT gen_random_uuid(), p_expected_revision integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing jsonb;
  v_inv record;
  v_client_name text;
  v_cash_id uuid;
  v_event jsonb;
  v_result jsonb;
BEGIN
  SELECT result INTO v_existing
  FROM public.domain_mutations
  WHERE company_id = p_company_id AND mutation_id = p_mutation_id;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  IF p_status NOT IN ('rascunho', 'pendente', 'pago', 'vencido', 'cancelado') THEN
    RAISE EXCEPTION 'Estado de fatura invalido: %', p_status;
  END IF;

  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  SELECT id, company_id, client_id, invoice_number, total, status, paid_at, revision
    INTO v_inv
  FROM public.invoices
  WHERE id = p_invoice_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fatura nao encontrada.';
  END IF;

  IF p_expected_revision IS NOT NULL AND v_inv.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'Conflito de revisao. Atual: %, esperado: %', v_inv.revision, p_expected_revision;
  END IF;

  UPDATE public.invoices
     SET status = p_status,
         paid_at = CASE WHEN p_status = 'pago' THEN COALESCE(v_inv.paid_at, now()) ELSE NULL END,
         payment_method = CASE WHEN p_status = 'pago' THEN p_payment_method ELSE NULL END
   WHERE id = p_invoice_id AND company_id = p_company_id
   RETURNING revision INTO v_inv.revision;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nada foi gravado na fatura.';
  END IF;

  IF p_status = 'pago' AND COALESCE(v_inv.total, 0) > 0 THEN
    SELECT name INTO v_client_name FROM public.clients WHERE id = v_inv.client_id;
    INSERT INTO public.cash_flow_entries (
      company_id, type, amount, description, category, date, reference_id, reference_type, status
    )
    VALUES (
      p_company_id,
      'entrada',
      v_inv.total,
      'Fatura ' || v_inv.invoice_number || ' - ' || COALESCE(v_client_name, 'Cliente'),
      'faturacao',
      (now() AT TIME ZONE 'Europe/Lisbon')::date,
      p_invoice_id,
      'invoice',
      'confirmado'
    )
    ON CONFLICT (company_id, reference_type, reference_id)
    WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL
    DO UPDATE SET
      amount = EXCLUDED.amount,
      description = EXCLUDED.description,
      date = EXCLUDED.date,
      status = EXCLUDED.status
    RETURNING id INTO v_cash_id;
  ELSE
    DELETE FROM public.cash_flow_entries
     WHERE company_id = p_company_id
       AND reference_type = 'invoice'
       AND reference_id = p_invoice_id
     RETURNING id INTO v_cash_id;
  END IF;

  v_event := public.record_company_change_event(
    p_company_id,
    p_mutation_id,
    'billing',
    'invoice_status_changed',
    ARRAY[p_invoice_id],
    ARRAY['cobrancas', 'financeiro'],
    NULL,
    jsonb_build_object('invoice_id', p_invoice_id, 'status', p_status, 'cash_flow_entry_id', v_cash_id)
  );

  v_result := jsonb_build_object(
    'ok', true,
    'invoice_id', p_invoice_id,
    'status', p_status,
    'revision', v_inv.revision,
    'cash_flow_entry_id', v_cash_id,
    'event', v_event
  );

  INSERT INTO public.domain_mutations(company_id, mutation_id, domain, status, result)
  VALUES (p_company_id, p_mutation_id, 'billing', 'completed', v_result);

  RETURN v_result;
END;
$function$

```

### delete_client_atomic

Assinatura: `delete_client_atomic(uuid,uuid,uuid,uuid,integer)`

```sql
CREATE OR REPLACE FUNCTION public.delete_client_atomic(p_client_id uuid, p_company_id uuid, p_actor uuid, p_mutation_id uuid DEFAULT gen_random_uuid(), p_expected_revision integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing jsonb;
  v_client record;
  v_location_ids uuid[];
  v_deleted_services integer := 0;
  v_deleted_contracts integer := 0;
  v_deleted_invoices integer := 0;
  v_event jsonb;
  v_result jsonb;
BEGIN
  SELECT result INTO v_existing
  FROM public.domain_mutations
  WHERE company_id = p_company_id AND mutation_id = p_mutation_id;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  SELECT id, name, revision INTO v_client
  FROM public.clients
  WHERE id = p_client_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente invalido.';
  END IF;

  IF p_expected_revision IS NOT NULL AND v_client.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'Conflito de revisao. Atual: %, esperado: %', v_client.revision, p_expected_revision;
  END IF;

  PERFORM 1
  FROM public.locations
  WHERE client_id = p_client_id AND company_id = p_company_id
  FOR UPDATE;

  SELECT COALESCE(array_agg(id), '{}') INTO v_location_ids
  FROM public.locations
  WHERE client_id = p_client_id AND company_id = p_company_id;

  IF array_length(v_location_ids, 1) IS NOT NULL THEN
    DELETE FROM public.services
     WHERE company_id = p_company_id AND location_id = ANY(v_location_ids);
    GET DIAGNOSTICS v_deleted_services = ROW_COUNT;

    DELETE FROM public.contracts
     WHERE company_id = p_company_id AND location_id = ANY(v_location_ids);
    GET DIAGNOSTICS v_deleted_contracts = ROW_COUNT;
  END IF;

  DELETE FROM public.cash_flow_entries cf
   USING public.invoices i
   WHERE i.id = cf.reference_id
     AND cf.reference_type = 'invoice'
     AND i.company_id = p_company_id
     AND i.client_id = p_client_id;

  DELETE FROM public.invoices
   WHERE company_id = p_company_id AND client_id = p_client_id;
  GET DIAGNOSTICS v_deleted_invoices = ROW_COUNT;

  DELETE FROM public.clients
   WHERE id = p_client_id AND company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nada foi eliminado.';
  END IF;

  v_event := public.record_company_change_event(
    p_company_id,
    p_mutation_id,
    'clients',
    'client_deleted',
    ARRAY[p_client_id],
    ARRAY['clientes', 'calendario', 'contratos', 'cobrancas'],
    NULL,
    jsonb_build_object(
      'client_id', p_client_id,
      'deleted_services', v_deleted_services,
      'deleted_contracts', v_deleted_contracts,
      'deleted_invoices', v_deleted_invoices
    )
  );

  v_result := jsonb_build_object(
    'ok', true,
    'client_id', p_client_id,
    'deleted_services', v_deleted_services,
    'deleted_contracts', v_deleted_contracts,
    'deleted_invoices', v_deleted_invoices,
    'event', v_event
  );

  INSERT INTO public.domain_mutations(company_id, mutation_id, domain, status, result)
  VALUES (p_company_id, p_mutation_id, 'clients', 'completed', v_result);

  RETURN v_result;
END;
$function$

```

Conclusoes:

- As quatro funcoes existem.
- As RPCs estao `SECURITY DEFINER`, mas com `search_path=public`; o plano exige `public, pg_temp`.
- `set_invoice_status_atomic` e `delete_client_atomic` aceitam `p_expected_revision DEFAULT NULL`; o plano exige revisao obrigatoria.
- Nao ha `pg_advisory_xact_lock`.
- Nao ha `request_hash`.
- Nao ha validacao de ator dentro das RPCs.
- `record_company_change_event` usa `ON CONFLICT DO UPDATE`, tornando evento mutavel; o plano exige evento imutavel.

## 6. Grants das funcoes

| routine_name | grantee | privilege_type |
| --- | --- | --- |
| delete_client_atomic | postgres | EXECUTE |
| delete_client_atomic | service_role | EXECUTE |
| record_company_change_event | anon | EXECUTE |
| record_company_change_event | authenticated | EXECUTE |
| record_company_change_event | postgres | EXECUTE |
| record_company_change_event | service_role | EXECUTE |
| set_invoice_status_atomic | postgres | EXECUTE |
| set_invoice_status_atomic | service_role | EXECUTE |

Conclusoes:

- `set_invoice_status_atomic`: executavel por `postgres` e `service_role`.
- `delete_client_atomic`: executavel por `postgres` e `service_role`.
- `record_company_change_event`: executavel por `anon`, `authenticated`, `postgres` e `service_role`. Isso viola a regra; a 065 deve revogar explicitamente de `PUBLIC`, `anon` e `authenticated`.

## 7. RLS e policies

RLS:

| relname | relrowsecurity | relforcerowsecurity |
| --- | --- | --- |
| company_change_events | true | false |
| domain_mutations | true | false |

Policies:

| schemaname | tablename | policyname | roles | cmd | qual | with_check |
| --- | --- | --- | --- | --- | --- | --- |
| public | company_change_events | managers see company change events | {public} | SELECT | ((company_id = ( SELECT profiles.company_id<br>   FROM profiles<br>  WHERE (profiles.id = auth.uid()))) AND (( SELECT profiles.role<br>   FROM profiles<br>  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))) |  |
| public | domain_mutations | service role domain mutations | {public} | ALL | false | false |

Conclusoes:

- `domain_mutations` e `company_change_events` tem RLS ativo.
- `company_sync_state` nao existe.
- `company_change_events` permite SELECT a gestores/admins da empresa via policy com roles `public`.
- `domain_mutations` tem policy `false/false`; navegadores nao devem ler/escrever.

## 8. Publicacao Realtime

| pubname | schemaname | tablename |
| --- | --- | --- |
| supabase_realtime | public | services |

Conclusoes:

- Apenas `services` aparece na publicacao `supabase_realtime` entre as tabelas consultadas.
- `company_change_events` nao esta publicado; Realtime por Outbox ainda nao funciona.
- `contracts` nao aparece nessa consulta.

## 9. Dados existentes

Contagens:

| table_name | count |
| --- | --- |
| domain_mutations | 0 |
| company_change_events | 0 |

Amostra segura de eventos:

Sem registros em company_change_events.

Conclusoes:

- `domain_mutations`: 0 registros.
- `company_change_events`: 0 registros.
- Como nao ha dados, a 065 pode transformar essas tabelas com menor risco de migracao de conteudo, mas deve preservar compatibilidade de deploy e nao assumir que outros ambientes tambem estejam vazios.

## 10. Origem provavel da aplicacao parcial

Buscas executadas:

- Historico PowerShell local por `064/domain_mutations/company_change_events/set_invoice_status_atomic/run-migrations/supabase`: sem achados relevantes.
- `git log --all --oneline -- supabase/migrations src/app/actions/...`: remoto/base atual em `5581784`, sem commit com 064.
- Busca global local por estruturas 064: achados apenas em `supabase/migrations/064_domain_atomicity_outbox.sql`, codigo alterado localmente e documentos/auditoria desta sessao.

Conclusao:

- Origem provavel: SQL 064 executado manualmente ou por ferramenta fora do controle `public._migrations` / `supabase_migrations.schema_migrations`.
- Nao ha evidencia local de commit remoto contendo a 064.

## 11. Diferencas exatas entre banco real e arquivo 064 local

- Banco real e arquivo 064 coincidem nos pontos principais da implementacao parcial: `revision integer`, `override_fields`, `domain_mutations` simples, `company_change_events` com `IDENTITY` e `delivered_at`, funcoes atomicas parciais.
- Banco real tem `record_company_change_event` executavel por `anon` e `authenticated`; o arquivo 064 local nao revoga explicitamente esses roles para esta funcao.
- Banco real usa `search_path=public`; o plano exige `public, pg_temp`.
- Banco real nao tem `company_sync_state`; arquivo 064 tambem nao tem.
- Banco real nao tem `operation/entity_id/request_hash/completed_at`; arquivo 064 tambem nao tem.
- Banco real nao publica `company_change_events` no Realtime; arquivo 064 tambem nao adiciona publicacao.
- Banco real nao tem `occurrence_date/source_contract_revision`; arquivo 064 tambem nao tem.

## 12. Backup e restaurabilidade

Backup produzido: `backups/atomicidade-pre-064`.

Validacao estrutural:

- Manifest total: 5820.
- Total parseado dos JSON: 5820.
- Erros no manifest: {}.
- Erros de parse JSON: 0.
- Contagens batem: true.

Conclusao honesta:

- O backup e legivel e estruturalmente consistente com o manifest.
- Ainda nao foi feito ensaio de restore em uma base limpa; portanto a restaurabilidade operacional completa ainda nao esta provada.
- Antes de aplicar 065 em ambiente compartilhado, executar restore rehearsal ou confirmar backup Supabase de infraestrutura.

## 13. Plano detalhado da 065

Tipo de migration: corretiva, nao aplicar ainda.

| Alteracao | Tipo | Observacao |
| --- | --- | --- |
| Criar `pgcrypto` | Aditiva | Necessario para `digest(..., sha256)`. |
| Converter `revision` de `integer` para `bigint` em tabelas aprovadas | Transformacao de schema | `clients`, `locations`, `contracts`, `services`, `teams`, `invoices`. Avaliar se remover ou deixar `team_members/invoice_items` para compatibilidade. |
| Criar `company_sync_state` | Aditiva | Base da sequencia por empresa com lock transacional. |
| Criar `next_company_sequence` | Nova funcao privada | Deve bloquear linha por empresa e retornar sequencia sem IDENTITY global. |
| Ajustar `company_change_events` | Transformacao de schema | Remover dependencia de IDENTITY, remover `delivered_at`, trocar `affected_range` por `affected_from/affected_to`, impor `UNIQUE(company_id, mutation_id)`. Como tabela esta vazia, transformacao e simples neste ambiente. |
| Ajustar `domain_mutations` | Transformacao de schema | Adicionar `operation`, `entity_id`, `request_hash`, `completed_at`; remover/ignorar `status`. Como tabela esta vazia, pode ser transformacao direta neste ambiente. |
| Recriar `record_company_change_event` | Substituicao de funcao | Sem `ON CONFLICT DO UPDATE`; eventos imutaveis; usa `next_company_sequence`; `search_path=public, pg_temp`. |
| Recriar `set_invoice_status_atomic` | Substituicao de funcao | Advisory lock, request_hash, ator validado, revisao obrigatoria, auditoria na transacao, retorno estruturado completo. |
| Substituir `delete_client_atomic` por politica segura | Substituicao/remocao | Nao manter delecao destrutiva. Criar `archive_client_atomic` e `delete_empty_client_atomic`. |
| Corrigir grants | Permissoes | Revogar `PUBLIC`, `anon`, `authenticated`; conceder apenas `service_role` para RPCs internas. |
| Publicar `company_change_events` no Realtime | Aditiva | Alterar `supabase_realtime` idempotentemente e conceder SELECT para `authenticated`. |
| Atualizar RLS | Politicas | SELECT de eventos apenas gestores/admins da empresa; sem INSERT/UPDATE/DELETE pelo browser. |

## 14. SQL proposto para 065 (rascunho, nao aplicado)

```sql
-- 065_fix_domain_atomicity_outbox.sql
-- RASCUNHO: revisar em banco de teste antes de aplicar.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.clients ALTER COLUMN revision TYPE bigint;
ALTER TABLE public.locations ALTER COLUMN revision TYPE bigint;
ALTER TABLE public.contracts ALTER COLUMN revision TYPE bigint;
ALTER TABLE public.services ALTER COLUMN revision TYPE bigint;
ALTER TABLE public.teams ALTER COLUMN revision TYPE bigint;
ALTER TABLE public.invoices ALTER COLUMN revision TYPE bigint;

CREATE TABLE IF NOT EXISTS public.company_sync_state (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  sequence bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.next_company_sequence(p_company_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sequence bigint;
BEGIN
  INSERT INTO public.company_sync_state(company_id, sequence)
  VALUES (p_company_id, 0)
  ON CONFLICT (company_id) DO NOTHING;

  SELECT sequence INTO v_sequence
  FROM public.company_sync_state
  WHERE company_id = p_company_id
  FOR UPDATE;

  v_sequence := v_sequence + 1;

  UPDATE public.company_sync_state
     SET sequence = v_sequence,
         updated_at = now()
   WHERE company_id = p_company_id;

  RETURN v_sequence;
END;
$$;

-- Como as tabelas estao vazias neste ambiente, a 065 pode recriar constraints/colunas.
-- Em ambiente com dados, primeiro migrar dados para colunas novas antes de constraints NOT NULL.
ALTER TABLE public.domain_mutations ADD COLUMN IF NOT EXISTS operation text;
ALTER TABLE public.domain_mutations ADD COLUMN IF NOT EXISTS entity_id uuid;
ALTER TABLE public.domain_mutations ADD COLUMN IF NOT EXISTS request_hash text;
ALTER TABLE public.domain_mutations ADD COLUMN IF NOT EXISTS completed_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.company_change_events ADD COLUMN IF NOT EXISTS affected_from date;
ALTER TABLE public.company_change_events ADD COLUMN IF NOT EXISTS affected_to date;

-- Passos destrutivos/constraint devem ser detalhados apos ensaio:
-- DROP INDEX/CONSTRAINT antiga de company_change_events(company_id, mutation_id, domain, event_type)
-- remover IDENTITY de sequence e popular sequence via next_company_sequence
-- remover delivered_at e affected_range se confirmado sem consumidores
-- impor UNIQUE(company_id, mutation_id)

-- Recriar funcoes com:
-- - pg_advisory_xact_lock(hashtextextended(...))
-- - request_hash deterministico
-- - validacao de ator admin/gestor
-- - expected_revision obrigatorio
-- - retorno estruturado { ok, mutation_id, sequence, entity... }
-- - evento imutavel sem DO UPDATE

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'company_change_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.company_change_events;
  END IF;
END;
$$;

GRANT SELECT ON public.company_change_events TO authenticated;
REVOKE ALL ON FUNCTION public.record_company_change_event(uuid, uuid, text, text, uuid[], text[], tstzrange, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_invoice_status_atomic(uuid, uuid, uuid, text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_client_atomic(uuid, uuid, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_company_change_event(uuid, uuid, text, text, uuid[], text[], tstzrange, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_invoice_status_atomic(uuid, uuid, uuid, text, text, uuid, integer) TO service_role;
-- delete_client_atomic deve ser substituida por archive_client_atomic/delete_empty_client_atomic antes de uso em producao.
```

## 15. Testes que devem provar a 065

- PostgreSQL real: idempotencia sequencial com mesmo payload retorna mesmo resultado sem efeitos novos.
- PostgreSQL real: duas chamadas concorrentes com mesmo `mutation_id` geram um recibo e um evento.
- PostgreSQL real: mesma `mutation_id` com payload diferente retorna `MUTATION_REUSE_CONFLICT`.
- PostgreSQL real: conflito de revisao retorna `REVISION_CONFLICT` estruturado.
- PostgreSQL real: rollback de falha nao cria evento nem mutation receipt.
- PostgreSQL real: sequencia e independente por empresa e sem lacuna causada por outra empresa.
- PostgreSQL real: `pendente -> pago` cria caixa; `pago -> pendente` remove caixa; repetir `pago` nao duplica.
- RLS: gestores leem eventos da propria empresa; anon/authenticated nao executam RPC interna.
- Realtime: INSERT em `company_change_events` e entregue via `supabase_realtime`.
- Restore rehearsal: restaurar backup em base limpa ou validar backup Supabase de infraestrutura.

## 16. Rollback proposto da 065

Antes de aplicar:

1. Backup Supabase de infraestrutura ou restore rehearsal confirmado.
2. Snapshot do schema atual das tabelas/funcoes auditadas.
3. Feature flag/codigo ainda compat?vel com schema anterior.

Rollback tecnico esperado:

- Restaurar definicoes antigas de funcoes a partir de `docs/atomicidade-audit/schema-audit.json`.
- Remover `company_change_events` da publicacao Realtime se a 065 falhar apos essa etapa.
- Se nenhuma mutation/evento novo existir, remover colunas/tabelas adicionadas pela 065.
- Se houver mutation/evento novo, nao dropar dados; restaurar backup ou escrever migration reversa preservando recibos.

## 17. Estado final desta etapa

Auditoria concluida. Nenhuma 065 foi criada/aplicada. Proximo passo so deve acontecer depois de revisar este relatorio e decidir se a 065 sera escrita para este banco parcialmente migrado.

---

# Etapa 065 - preparacao local sem alterar banco compartilhado

Data: 2026-08-04.

## Ordem executada

- Nao foi executado `db push`.
- Nao foi executado `migration repair`.
- Nao foi executado SQL Editor.
- Nao foi executado SQL no banco compartilhado para alterar schema ou dados.
- A migration 064 foi preservada sem apagar, renomear, reescrever ou mover.
- A migration 065 foi criada apenas como arquivo local.
- Nao foram alterados contratos, calendario, cron ou frontend Realtime nesta etapa.

## 18. Divergencia de historico via Supabase CLI

Versao do Supabase CLI:

```text
npx supabase --version
2.111.0
```

Comando:

```text
npx supabase migration list
```

Resultado integral:

```text
{"_tag":"Error","error":{"code":"LegacyDbConfigLoginRoleStatusError","message":"unexpected login role status 401: {\"message\":\"Unauthorized\"}"}}
Initialising login role...
```

Comando:

```text
npx supabase db push --dry-run
```

Resultado integral:

```text
{"_tag":"Error","error":{"code":"LegacyDbConfigLoginRoleStatusError","message":"unexpected login role status 401: {\"message\":\"Unauthorized\"}"}}
DRY RUN: migrations will *not* be pushed to the database.
Initialising login role...
```

Conclusao:

- O binario global `supabase` nao existe no PATH.
- `npx supabase` existe e reporta versao `2.111.0`.
- O CLI nao conseguiu listar migrations nem produzir plano dry-run por erro remoto `401 Unauthorized` ao inicializar login role.
- Portanto, nesta maquina, nao foi possivel obter via CLI:
  - se a 064 aparece apenas na coluna local;
  - quais migrations o dry-run tentaria executar;
  - se a 064 seria executada novamente;
  - se a 065 viria depois.
- Pela auditoria SQL read-only anterior, o estado continua divergente: objetos da 064 existem, mas a 064 nao esta registrada em `supabase_migrations.schema_migrations` nem em `public._migrations`.

Identificador local exato da 064:

```text
064_domain_atomicity_outbox.sql
```

## 19. Hashes

Hashes calculados antes de atualizar esta secao final:

```text
258BE8604B5D9D0C933C9CC99FB9E1BB19C2750ED79B141309EF9D116AA58EF0  supabase/migrations/064_domain_atomicity_outbox.sql
9E7D96B160F244819B02DE4DBEADB2C10577AEDD1081C8C6210A47C9547C5E7E  supabase/migrations/065_fix_domain_atomicity_outbox.sql
0F4E769816C3937C7BDFB49066777FA60AB6ED445F14079D3E967858838EDFD6  docs/ATOMICIDADE-IMPLEMENTACAO.md
9A52678C23798553187C64F003B90081D50F9036449F29A55880CFEF8B4833BD  docs/atomicidade-audit/schema-audit.json
0F57E287583F2B9B910AB246F47484321F373EC24CDC22005E3134CCF85669BC  docs/atomicidade-audit/backup-restore-readiness.json
B94ACC0573676524B5FDCF6060800389C51FD269ACE99FB689DB3107E6B3EF19  docs/atomicidade-audit/backup-file-hashes.sha256
23BAADE544DEBF943D5E8BB7297713B37ED7FE05F0A3DDF65526135A3BD2E8C9  scripts/test-065-domain-atomicity.mjs
24D07964B5BE2FAB0ED70D3DDD5A11D28DE6197636EA9FA63FC2CA59A0EE7DB1  package.json
```

O arquivo `docs/atomicidade-audit/backup-file-hashes.sha256` contem o SHA-256 individual de cada arquivo do backup.

## 20. Backup real

Backup:

```text
backups/atomicidade-pre-064
```

Tipo:

```text
Export read-only via Supabase JS service role, por tabela, em CSV e JSON.
```

Comando usado:

```text
node scripts/backup-all.mjs atomicidade-pre-064
```

Metadados:

```text
Origem: URL Supabase do projeto auditado, conforme _MANIFEST.json
Arquivos: 71
Tamanho total: 7470770 bytes
Total de registros no manifest: 5820
Erros no manifest: 0
```

Contagens principais:

```text
clients: 937
contracts: 145
services: 1509
invoices: 11
cash_flow_entries: 440
```

Cobertura:

```text
Inclui dados: sim, das tabelas listadas em scripts/backup-all.mjs
Inclui schema: nao
Inclui funcoes: nao
Inclui triggers: nao
Inclui RLS: nao
Inclui supabase_migrations.schema_migrations: nao
```

Conclusao:

- Este backup e um export de dados aplicacionais, nao um dump operacional completo.
- Ele nao prova restaurabilidade de schema, funcoes, triggers, RLS ou historico de migrations.
- O ensaio de restore em banco descartavel ainda nao foi concluido.

## 21. Migration 065 criada localmente

Arquivo:

```text
supabase/migrations/065_fix_domain_atomicity_outbox.sql
```

Conteudo implementado:

- Converte `revision` para `bigint`.
- Cria `company_sync_state`.
- Implementa `next_company_sequence` com lock de linha.
- Remove uso funcional de `IDENTITY` em `company_change_events.sequence`.
- Reordena eventos existentes por empresa quando existirem.
- Remove `delivered_at` e `affected_range`.
- Adiciona `affected_from` e `affected_to`.
- Impoe `UNIQUE(company_id, sequence)` e `UNIQUE(company_id, mutation_id)`.
- Corrige `domain_mutations` com `operation`, `entity_id`, `request_hash`, `completed_at`.
- Classifica recibos antigos como `legacy` sem inventar payload original.
- Implementa lock transacional por `company_id + mutation_id`.
- Implementa recibo idempotente com conflito `MUTATION_REUSE_CONFLICT`.
- Recria `record_company_change_event` sem `ON CONFLICT DO UPDATE`.
- Recria `set_invoice_status_atomic` com ator, revisao obrigatoria, caixa, auditoria, outbox e retorno autoritativo.
- Cria `archive_client_atomic`.
- Cria `delete_empty_client_atomic`.
- Desativa `delete_client_atomic` destrutivo.
- Revoga execucao de RPCs para `PUBLIC`, `anon`, `authenticated`.
- Concede execucao somente ao `service_role` para RPCs publicas de escrita.
- Adiciona `company_change_events` a `supabase_realtime` de forma idempotente quando a publicacao existe.
- Mantem RLS e concede apenas SELECT de eventos para `authenticated`.

## 22. Testes PostgreSQL criados

Arquivo:

```text
scripts/test-065-domain-atomicity.mjs
```

Script npm:

```text
npm run test:065
```

Uso esperado:

```text
TEST_DATABASE_URL="postgresql://..." npm run test:065
```

Protecao:

- O teste exige `TEST_DATABASE_URL`.
- O teste falha se `TEST_DATABASE_URL` for igual a `SUPABASE_DB_URL`.

Cobertura implementada no script:

- Rollback nao avanca sequencia.
- Rollback nao deixa evento.
- Duas chamadas concorrentes com a mesma mutation ID retornam o mesmo resultado.
- Duas chamadas concorrentes geram um unico evento.
- Reutilizacao com payload diferente falha.
- Revisao antiga falha.
- Pagamento cria um unico caixa.
- Repetir pagamento nao duplica caixa.
- Retirar pagamento remove o caixa da fatura.
- Sequencia independente por empresa.
- Ator de outra empresa e rejeitado.
- `anon` nao executa RPC quando a role existe.
- Cliente com historico nao e apagado.
- Cliente vazio pode ser apagado.
- Arquivamento preserva historico e cancela futuro.

Pendente:

- Teste real de Realtime ainda nao executado.
- Teste de `authenticated` direto ainda precisa de role/ambiente Supabase descartavel.

## 23. Tentativa de banco descartavel local

Comando:

```text
docker run --name mo-limpezas-pg-065 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres -p 55432:5432 -d postgres:16
```

Resultado:

```text
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: O sistema não conseguiu localizar o ficheiro especificado.
```

Conclusao:

- Docker esta instalado, mas o daemon nao esta ativo.
- `psql` nao esta instalado no PATH.
- Portanto, nesta maquina e neste momento, nao foi possivel executar:
  - caminho A em banco limpo;
  - caminho B em copia restaurada;
  - testes concorrentes reais;
  - teste real de Realtime.

## 24. Resultado dos caminhos A/B

### Caminho A - banco limpo

Estado: nao executado.

Motivo:

```text
Sem banco descartavel local disponivel; Docker daemon inativo.
```

Decisao:

- Nao e possivel afirmar ainda que a 064 executa num banco limpo.
- Nao e possivel afirmar ainda que a 065 corrige o estado produzido pela 064 num banco limpo.

### Caminho B - copia do banco parcialmente alterado

Estado: nao executado.

Motivo:

```text
O backup disponivel e export de dados, nao dump completo de schema/funcoes/RLS/migrations.
Sem banco descartavel local disponivel; Docker daemon inativo.
```

Decisao:

- Nao simulei reconciliacao da 064.
- Nao apliquei 065 em copia.
- Nao comparei contagens antes/depois em copia restaurada.

## 25. Plano formal de reconciliacao da 064

Ainda nao escolher opcao A nem B.

Estado atual:

- A 065 esta preparada localmente.
- A divergencia de historico ainda nao foi confirmada por `supabase migration list` por erro `401`.
- Os dois caminhos obrigatorios A/B ainda nao foram provados.

Proxima decisao so pode ser tomada apos:

1. Rodar `supabase migration list` com credencial CLI valida.
2. Rodar `supabase db push --dry-run` com credencial CLI valida.
3. Ligar Docker ou fornecer `TEST_DATABASE_URL` descartavel.
4. Aplicar migrations em banco descartavel limpo.
5. Restaurar/simular copia parcial em outro banco descartavel.
6. Executar `npm run test:065`.
7. Executar teste real de assinatura Realtime.

## 26. Rollback previsto da 065

Antes de qualquer aplicacao em ambiente compartilhado:

1. Fazer backup operacional completo Supabase ou dump `pg_dump` com schema e dados.
2. Registrar fingerprint de schema antes da execucao.
3. Confirmar dry-run com somente a 065 pendente apos reconciliacao da 064.
4. Aplicar em janela controlada.

Rollback se falhar antes de gerar eventos novos:

- Restaurar funcoes antigas a partir de `docs/atomicidade-audit/schema-audit.json`.
- Remover `company_change_events` da publicacao Realtime se tiver sido adicionado.
- Remover `company_sync_state`.
- Remover colunas novas de `domain_mutations` e `company_change_events` se ainda nao tiverem dados novos.
- Recriar `delivered_at`, `affected_range` e constraints antigas se necessario.

Rollback se ja houver eventos/recibos novos:

- Nao dropar tabelas/colunas com dados novos.
- Preferir restore operacional completo ou migration reversa preservando eventos/recibos.

## 27. SQL que seria executado futuramente no banco compartilhado

Nenhum SQL deve ser executado agora.

Lista futura pretendida, somente apos aprovacao explicita e testes A/B:

```text
supabase migration repair --status applied 064_domain_atomicity_outbox
supabase db push --dry-run
supabase db push
```

Observacao:

- O identificador exato exigido pelo `migration repair` ainda precisa ser confirmado pelo CLI, porque o comando `migration list` falhou por `401`.

---

# Etapa 065 - correcoes locais autorizadas

Data: 2026-08-04.

Escopo autorizado: somente correcoes locais dos quatro problemas encontrados.

Nao executado:

```text
migration repair
db push
migration up
SQL Editor
deploy
aplicacao da migration 065
criacao de dados de teste no banco atual
```

## Arquivos alterados nesta etapa

```text
supabase/migrations/065_fix_domain_atomicity_outbox.sql
src/app/actions/clientes.ts
src/app/actions/invoices.ts
src/app/(dashboard)/dashboard/clientes/_components/table.tsx
src/app/(dashboard)/dashboard/clientes/_components/clientes-tabs.tsx
src/lib/cliente-sheet-fields.ts
src/__tests__/atomicity-065-static.test.ts
docs/atomicidade-audit/065-static-review.md
docs/ATOMICIDADE-IMPLEMENTACAO.md
```

## Correcoes aplicadas

1. RPCs criticas agora autorizam ator antes do advisory lock e antes da leitura de recibos.
2. `delete_empty_client_atomic` trata `service_payment` e outros historicos como bloqueio para eliminacao fisica.
3. `deleteCliente` nao chama mais `delete_client_atomic`; chama `delete_empty_client_atomic`.
4. `archiveCliente` chama `archive_client_atomic` separadamente.
5. A listagem de clientes carrega e envia `revision`.
6. A 065 recria explicitamente os 8 triggers de revision.
7. Foram adicionados guardas locais estaticos.

## Validacoes

```text
node --check scripts/test-065-domain-atomicity.mjs: passou
npx tsc --noEmit: passou
npm run lint: passou
npm test: 30 arquivos, 502 testes, 0 falhas, 6.11s
npm run build: passou; compile 7.7s; TypeScript 15.2s; 50 paginas geradas em 569ms
```

## Estado ainda pendente

```text
PENDENTE — NÃO EXECUTADO POR AUSÊNCIA DE BANCO DESCARTÁVEL NO AMBIENTE ATUAL
```

- Aplicar 064 + 065 em banco limpo.
- Aplicar 065 em copia restaurada.
- Executar `npm run test:065` contra banco descartavel.
- Teste concorrente real.
- Teste Realtime real.
- Teste rollback real.
- `supabase db push --dry-run`, ainda bloqueado por `401 Unauthorized`.

---

# Etapa 065 - rodada final local

Data: 2026-08-04.

Escopo autorizado: ultima rodada de correcoes locais da 065 e arquivos diretamente afetados.

Nao executado:

```text
db push
migration up
migration repair
SQL Editor
deploy
Docker
banco externo
aplicacao da 065
```

## Decisao final de idempotencia

A estrutura final escolhida e `public.domain_mutations`.

Nao foi criada `domain_mutation_receipts`.

Campos finais minimos cobertos pela 065:

```text
id
company_id
mutation_id
domain
operation
entity_id
request_hash
status
result
created_at
completed_at
```

Constraint final:

```text
UNIQUE(company_id, mutation_id)
status IN ('succeeded', 'rejected')
```

`status = 'completed'` legado e convertido para `succeeded` durante a transformacao.

## CLIENT_HAS_HISTORY

`CLIENT_HAS_HISTORY` agora e uma rejeicao idempotente de negocio:

```json
{
  "ok": false,
  "code": "CLIENT_HAS_HISTORY",
  "client_id": "...",
  "revision": 4,
  "history": {
    "contracts": 1,
    "services": 12,
    "timesheets": 4,
    "invoices": 2,
    "cash_flow_entries": 2
  }
}
```

Regras:

- grava `domain_mutations.status = 'rejected'`;
- nao apaga linhas;
- nao altera `clients.revision`;
- nao cria `company_change_event`;
- nao arquiva automaticamente;
- replay com mesmo `company_id + mutation_id` devolve o mesmo `result`;
- nova tentativa explicita do usuario deve gerar nova `mutation_id`.

## Triggers de revision

A 065 agora:

- confirma coluna `revision` por tabela controlada;
- consulta `pg_trigger`, `pg_proc`, `pg_namespace` e `pg_class`;
- remove todos os triggers nao internos cuja funcao executada e exatamente `public.fn_increment_revision`;
- recria um unico trigger canonico por tabela;
- verifica contagem final igual a um;
- gera exception se encontrar outra funcao de trigger que aparentemente altere `NEW.revision`.

Exception de conflito:

```text
REVISION_TRIGGER_CONFLICT table=..., trigger=..., function=...
```

Limitacao: a deteccao de funcao conflitante usa busca textual em `pg_get_functiondef`; precisa validacao real em banco descartavel.

## UTF-8 e escopo

`src/app/actions/clientes.ts` e `src/app/(dashboard)/dashboard/clientes/_components/table.tsx` foram restaurados do commit-base `5581784` e receberam apenas alteracoes localizadas.

Preservado:

- textos da tabela;
- layout;
- filtros/listagem/paginacao;
- comentarios uteis;
- actions nao relacionadas.

Alterado:

- `archiveCliente` exige `expectedRevision` e chama `archive_client_atomic`;
- `deleteCliente` exige `expectedRevision` e chama `delete_empty_client_atomic`;
- tabela envia `revision`;
- `CLIENT_HAS_HISTORY` mostra erro e orienta arquivamento como acao separada.

## Contrato final das RPCs

Sucesso:

```json
{ "ok": true, "code": "OK" }
```

Erro previsivel:

```json
{ "ok": false, "code": "CODIGO_ESTAVEL" }
```

Codigos estaveis:

```text
OK
INVALID_INPUT
FORBIDDEN_ACTOR
NOT_FOUND
REVISION_CONFLICT
MUTATION_REUSE_CONFLICT
CLIENT_HAS_HISTORY
INTERNAL_ERROR
```

Exceptions ficam reservadas para falha tecnica, integridade inesperada ou estado impossivel.

## Validacoes locais desta rodada

```text
git diff --check: passou, apenas avisos CRLF
node --check scripts/test-065-domain-atomicity.mjs: passou
npx tsc --noEmit: passou
npm test -- src/__tests__/atomicity-065-static.test.ts: 15 testes passaram
```

Validacoes completas ainda devem ser executadas apos esta documentacao:

```text
npm run lint
npm test
npm run build
```

## Pendencias reais

```text
PENDENTE — NÃO EXECUTADO POR AUSÊNCIA DE BANCO DESCARTÁVEL NO AMBIENTE ATUAL
```

- Aplicar 065 em banco descartavel.
- Testar concorrencia real.
- Testar rollback real.
- Testar Realtime real.
- Confirmar sintaxe/efeito do bloco dinamico de triggers em PostgreSQL real.

---

# Etapa - motor canonico de recorrencia (local, sem banco)

Data: 2026-08-04.

Decisao do dono: a reconciliacao 064/065 continua **congelada** (nenhum
`db push`, `migration repair`, SQL Editor ou deploy). A 065 ja passou pela
verificacao estatica local e fica como checkpoint aceite, hash congelado:

```text
cb68199dce5ed90e0a1afde60cd47aef3891ad00c6033b23d8c8fff63a61383d  supabase/migrations/065_fix_domain_atomicity_outbox.sql
```

Nesta etapa ficaram fora de alcance: migrations 064/065, RPCs, clientes,
faturas, contratos transacionais, Outbox, Realtime, banco e deploy. Trabalho
feito foi exclusivamente local no clone: motor de recorrencia.

## Auditoria e correcao

- Confirmadas duas implementacoes independentes de recorrencia:
  `src/lib/contract-occurrences.ts` (geracao real, usada por
  `createContrato`/`updateContrato`/cron) e `calcOccurrences` em
  `sheet.tsx` (preview do formulario) — ja tinham divergido uma vez no
  passado (comentario no proprio ficheiro).
- Bug real confirmado e corrigido: `getOccurrences` mensal so calculava a
  ocorrencia do MES de `rangeStart`; `generateServicesForContract` chama-o
  com janela de 3 meses, logo um contrato mensal so gerava 1 servico no
  total por chamada, nao 1 por mes.
- Criado motor puro em `src/domain/scheduling/recurrence-engine.ts`
  (`iterateOccurrences`/`occurrencesInRange`/`occurrencesFrom`).
  `src/lib/contract-occurrences.ts` passou a wrapper sem logica propria
  (`getOccurrences` = `occurrencesInRange`). `contratos.ts` e o cron
  `generate-services` nao precisaram de nenhuma alteracao de codigo —
  herdam a correcao por importarem pelo nome do wrapper.
- `sheet.tsx` (preview) passou a consumir `occurrencesFrom` do motor
  canonico em vez de reimplementar as regras — alteracao so de UI, sem
  tocar em nenhuma action.
- Corrigida a mensagem de erro morta de `deleteCliente`
  (`CLIENT_HAS_HISTORY`) que prometia "arquivar como acao separada" sem
  `archiveCliente` ter qualquer chamador na UI (confirmado no historico
  completo do repositorio, nao so nesta branch). Removida a promessa da
  mensagem em vez de ligar o botao agora — decisao do dono.

## Testes novos

`src/__tests__/recurrence-engine.test.ts` — 32 testes: bug mensal de
varios meses, `shiftToNextBusinessDay`, semanal/quinzenal/3-em-3-semanas,
personalizado, diario, preview por contagem, DST (inicio/fim do horario de
verao em Portugal 2026), invariantes (sem duplicados, ordem cronologica,
exclusoes, `iterateOccurrences` vs `occurrencesInRange`) para as 6
frequencias via `it.each`. Os 12 testes antigos de
`contract-occurrences.test.ts` continuam a passar sem alteracao.

Detalhe completo em `docs/atomicidade-audit/recurrence-engine-review.md`.

## Validacoes locais desta etapa

```text
git diff --check: passou, apenas avisos CRLF
npx tsc --noEmit: passou
npm run lint: passou, 0 erros/avisos
npm test: 31 arquivos, 540 testes, 0 falhas
npm run build: passou, 50 paginas geradas
```

## Estado ainda pendente (inalterado desta etapa, nao tocado)

```text
PENDENTE — 064/065 continuam congeladas, sem banco descartavel disponivel
```

- Reconciliacao 064/065 em banco descartavel (cenarios A e B) — ver secoes
  anteriores deste documento.
- `createContrato`/`updateContrato` continuam a fazer varias escritas
  sequenciais sem RPC/transacao real (compensacao manual via try/catch, sem
  desfazer `services` ja inseridas antes de uma falha a meio do loop) —
  proxima fase separada, so depois da reconciliacao 064/065, a pedido do
  dono (nao misturar os dois riscos criticos na mesma entrega).
- Ligar `archiveCliente` a um botao real na UI, ou manter removido
  enquanto nao for ligado.
