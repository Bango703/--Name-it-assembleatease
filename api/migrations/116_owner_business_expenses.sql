-- Owner-entered operating expenses for cash planning and management reporting.
-- These records are separate from customer payments, sales tax, and Easer payouts.

BEGIN;

CREATE TABLE IF NOT EXISTS public.owner_business_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recurring_group_id UUID,
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 120),
  vendor TEXT CHECK (vendor IS NULL OR length(btrim(vendor)) <= 120),
  category TEXT NOT NULL CHECK (category IN (
    'software', 'hosting', 'marketing', 'insurance', 'professional_services',
    'office', 'credit', 'travel', 'supplies', 'other'
  )),
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'paid', 'void')),
  recurrence TEXT NOT NULL DEFAULT 'one_time' CHECK (recurrence IN ('one_time', 'monthly', 'quarterly', 'annual')),
  payment_date DATE,
  payment_account TEXT CHECK (payment_account IS NULL OR length(btrim(payment_account)) <= 80),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  created_by TEXT NOT NULL DEFAULT 'owner',
  updated_by TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT owner_business_expenses_paid_fields CHECK (
    (status = 'paid' AND payment_date IS NOT NULL)
    OR (status <> 'paid' AND payment_date IS NULL)
  ),
  CONSTRAINT owner_business_expenses_recurring_group CHECK (
    (recurrence = 'one_time' AND recurring_group_id IS NULL)
    OR (recurrence <> 'one_time' AND recurring_group_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS owner_business_expenses_due_idx
  ON public.owner_business_expenses (due_date, status);
CREATE INDEX IF NOT EXISTS owner_business_expenses_paid_idx
  ON public.owner_business_expenses (payment_date)
  WHERE status = 'paid';
CREATE UNIQUE INDEX IF NOT EXISTS owner_business_expenses_recurring_due_idx
  ON public.owner_business_expenses (recurring_group_id, due_date)
  WHERE recurring_group_id IS NOT NULL;

ALTER TABLE public.owner_business_expenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_business_expenses_service_role_all ON public.owner_business_expenses;
CREATE POLICY owner_business_expenses_service_role_all
  ON public.owner_business_expenses FOR ALL TO service_role
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON public.owner_business_expenses FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.owner_business_expenses TO service_role;

CREATE OR REPLACE FUNCTION public.mark_owner_business_expense_paid_v1(
  p_expense_id UUID,
  p_payment_date DATE,
  p_payment_account TEXT,
  p_updated_by TEXT
)
RETURNS TABLE (paid_expense JSONB, next_expense JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_expense public.owner_business_expenses%ROWTYPE;
  paid_row public.owner_business_expenses%ROWTYPE;
  next_row public.owner_business_expenses%ROWTYPE;
  next_due DATE;
BEGIN
  SELECT * INTO current_expense
    FROM public.owner_business_expenses
   WHERE id = p_expense_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found' USING ERRCODE = 'P0002';
  END IF;
  IF current_expense.status <> 'upcoming' THEN
    RAISE EXCEPTION 'Expense is no longer upcoming' USING ERRCODE = '22000';
  END IF;
  IF p_payment_date IS NULL THEN
    RAISE EXCEPTION 'Payment date is required' USING ERRCODE = '22000';
  END IF;

  UPDATE public.owner_business_expenses
     SET status = 'paid',
         payment_date = p_payment_date,
         payment_account = NULLIF(BTRIM(p_payment_account), ''),
         updated_by = COALESCE(NULLIF(BTRIM(p_updated_by), ''), 'owner'),
         updated_at = now()
   WHERE id = p_expense_id
   RETURNING * INTO paid_row;

  IF current_expense.recurrence <> 'one_time' THEN
    next_due := CASE current_expense.recurrence
      WHEN 'monthly' THEN (current_expense.due_date + INTERVAL '1 month')::DATE
      WHEN 'quarterly' THEN (current_expense.due_date + INTERVAL '3 months')::DATE
      WHEN 'annual' THEN (current_expense.due_date + INTERVAL '1 year')::DATE
    END;

    INSERT INTO public.owner_business_expenses (
      recurring_group_id, title, vendor, category, amount_cents, due_date,
      recurrence, payment_account, notes, created_by, updated_by
    ) VALUES (
      current_expense.recurring_group_id, current_expense.title,
      current_expense.vendor, current_expense.category,
      current_expense.amount_cents, next_due, current_expense.recurrence,
      current_expense.payment_account, current_expense.notes,
      COALESCE(NULLIF(BTRIM(p_updated_by), ''), 'owner'),
      COALESCE(NULLIF(BTRIM(p_updated_by), ''), 'owner')
    ) ON CONFLICT (recurring_group_id, due_date)
      WHERE recurring_group_id IS NOT NULL DO NOTHING
      RETURNING * INTO next_row;
  END IF;

  RETURN QUERY SELECT to_jsonb(paid_row), CASE WHEN next_row.id IS NULL THEN NULL ELSE to_jsonb(next_row) END;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_owner_business_expense_paid_v1(UUID, DATE, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_owner_business_expense_paid_v1(UUID, DATE, TEXT, TEXT)
  TO service_role;

DO $do$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (116, '116_owner_business_expenses')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$do$;

NOTIFY pgrst, 'reload schema';
COMMIT;
