-- GERADO de supabase/migrations/086_manual_charges_and_atomic_billing.sql
-- A tabela manual_charges COMO A 086 A CRIOU. Nao editar a mao:
-- regenerar com scripts/gen-086-fixture.mjs.

CREATE TABLE IF NOT EXISTS public.manual_charges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  client_id     uuid NOT NULL REFERENCES public.clients(id)   ON DELETE RESTRICT,

  charge_date   date NOT NULL,
  description   text NOT NULL,
  -- O valor da obrigação, sem IVA. `apply_vat` diz se o total leva IVA, tal
  -- como em `services` — para que a Cobrança Diária possa somar as duas
  -- origens sem uma segunda regra de cálculo.
  amount        numeric(10,2) NOT NULL,
  apply_vat     boolean NOT NULL DEFAULT true,

  -- Os mesmos três estados de `services.payment_status`: o Diário mostra as
  -- duas origens lado a lado, e dois vocabulários diferentes obrigariam a
  -- traduzir de um para o outro em cada leitura.
  payment_status text NOT NULL DEFAULT 'nao_informado'
    CHECK (payment_status IN ('nao_informado', 'sinal_50', 'pago_total')),
  paid_amount   numeric(10,2),
  paid_at       timestamptz,

  notes         text,

  -- 🔴 Anular, não apagar. Uma cobrança que já teve recebimento não pode
  --    desaparecer: o movimento de caixa que ela gerou é histórico, e apagar
  --    a origem deixaria o dinheiro sem explicação. `voided_at` retira-a das
  --    listas sem destruir o registo.
  voided_at     timestamptz,
  voided_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  created_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT manual_charges_amount_positivo CHECK (amount > 0),
  -- Um valor recebido negativo não é um recebimento.
  CONSTRAINT manual_charges_paid_amount_nao_negativo
    CHECK (paid_amount IS NULL OR paid_amount >= 0),
  -- Anulada exige quem anulou: um registo anulado sem autor é um registo que
  -- ninguém pode explicar depois.
  CONSTRAINT manual_charges_void_coerente
    CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);
