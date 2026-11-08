-- Thumbtack lead inbox and spend attribution for the owner console.
-- No customer booking, payment, or Easer payout state is changed here.
BEGIN;
CREATE TABLE IF NOT EXISTS public.thumbtack_leads (
  negotiation_id TEXT PRIMARY KEY CHECK (length(btrim(negotiation_id)) BETWEEN 1 AND 120),
  service TEXT CHECK (service IS NULL OR length(service) <= 160),
  city TEXT CHECK (city IS NULL OR length(city) <= 100),
  state TEXT CHECK (state IS NULL OR length(state) <= 30),
  lead_status TEXT CHECK (lead_status IS NULL OR length(lead_status) <= 80),
  lead_created_at TIMESTAMPTZ,
  lead_price_cents INTEGER CHECK (lead_price_cents IS NULL OR lead_price_cents BETWEEN 0 AND 100000000),
  refunded_cents INTEGER CHECK (refunded_cents IS NULL OR refunded_cents BETWEEN 0 AND 100000000),
  credited_cents INTEGER CHECK (credited_cents IS NULL OR credited_cents BETWEEN 0 AND 100000000),
  latest_message_preview TEXT CHECK (latest_message_preview IS NULL OR length(latest_message_preview) <= 500),
  latest_message_at TIMESTAMPTZ,
  owner_outcome TEXT NOT NULL DEFAULT 'open' CHECK (owner_outcome IN ('open','booked','not_converted')),
  booking_id UUID REFERENCES public.bookings(id) ON DELETE SET NULL,
  lead_price_source TEXT NOT NULL DEFAULT 'thumbtack_event' CHECK (lead_price_source IN ('thumbtack_event','owner_recorded','unknown')),
  updated_by TEXT NOT NULL DEFAULT 'thumbtack_webhook',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.thumbtack_webhook_events (
  event_key TEXT PRIMARY KEY CHECK (length(event_key) BETWEEN 1 AND 240),
  negotiation_id TEXT NOT NULL CHECK (length(negotiation_id) BETWEEN 1 AND 120),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 80),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS thumbtack_leads_created_idx ON public.thumbtack_leads (lead_created_at DESC NULLS LAST);
CREATE UNIQUE INDEX IF NOT EXISTS thumbtack_leads_booking_unique_idx ON public.thumbtack_leads (booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS thumbtack_events_negotiation_idx ON public.thumbtack_webhook_events (negotiation_id, occurred_at DESC);

ALTER TABLE public.thumbtack_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thumbtack_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.thumbtack_leads, public.thumbtack_webhook_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.thumbtack_leads, public.thumbtack_webhook_events TO service_role;

CREATE OR REPLACE FUNCTION public.record_thumbtack_webhook_event_v1(
  p_event_key TEXT, p_negotiation_id TEXT, p_event_type TEXT, p_occurred_at TIMESTAMPTZ,
  p_service TEXT, p_city TEXT, p_state TEXT, p_lead_status TEXT, p_lead_created_at TIMESTAMPTZ,
  p_lead_price_cents INTEGER, p_message_preview TEXT, p_message_at TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE inserted_count INTEGER;
BEGIN
  INSERT INTO public.thumbtack_webhook_events(event_key, negotiation_id, event_type, occurred_at)
  VALUES (p_event_key, p_negotiation_id, p_event_type, p_occurred_at)
  ON CONFLICT (event_key) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count = 0 THEN RETURN FALSE; END IF;

  INSERT INTO public.thumbtack_leads(
    negotiation_id, service, city, state, lead_status, lead_created_at, lead_price_cents,
    latest_message_preview, latest_message_at, lead_price_source
  ) VALUES (
    p_negotiation_id, NULLIF(left(btrim(p_service),160),''), NULLIF(left(btrim(p_city),100),''),
    NULLIF(left(btrim(p_state),30),''), NULLIF(left(btrim(p_lead_status),80),''), p_lead_created_at,
    p_lead_price_cents, NULLIF(left(p_message_preview,500),''), p_message_at,
    CASE WHEN p_lead_price_cents IS NULL THEN 'unknown' ELSE 'thumbtack_event' END
  ) ON CONFLICT (negotiation_id) DO UPDATE SET
    service = COALESCE(EXCLUDED.service, thumbtack_leads.service),
    city = COALESCE(EXCLUDED.city, thumbtack_leads.city),
    state = COALESCE(EXCLUDED.state, thumbtack_leads.state),
    lead_status = COALESCE(EXCLUDED.lead_status, thumbtack_leads.lead_status),
    lead_created_at = COALESCE(thumbtack_leads.lead_created_at, EXCLUDED.lead_created_at),
    lead_price_cents = COALESCE(thumbtack_leads.lead_price_cents, EXCLUDED.lead_price_cents),
    lead_price_source = CASE WHEN thumbtack_leads.lead_price_cents IS NULL AND EXCLUDED.lead_price_cents IS NOT NULL THEN 'thumbtack_event' ELSE thumbtack_leads.lead_price_source END,
    latest_message_preview = CASE
      WHEN EXCLUDED.latest_message_at IS NOT NULL
        AND (thumbtack_leads.latest_message_at IS NULL OR EXCLUDED.latest_message_at >= thumbtack_leads.latest_message_at)
        THEN COALESCE(EXCLUDED.latest_message_preview, thumbtack_leads.latest_message_preview)
      ELSE COALESCE(thumbtack_leads.latest_message_preview, EXCLUDED.latest_message_preview)
    END,
    latest_message_at = GREATEST(thumbtack_leads.latest_message_at, EXCLUDED.latest_message_at),
    updated_at = now();
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.record_thumbtack_webhook_event_v1(TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,INTEGER,TEXT,TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_thumbtack_webhook_event_v1(TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,INTEGER,TEXT,TIMESTAMPTZ) TO service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (122, 'thumbtack_owner_area') ON CONFLICT (migration_number) DO NOTHING;
NOTIFY pgrst, 'reload schema';
COMMIT;
