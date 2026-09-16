-- Customer uploads are private communication attachments, not completion evidence.
CREATE TABLE IF NOT EXISTS public.booking_customer_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')),
  file_size_bytes INTEGER NOT NULL CHECK (file_size_bytes > 0 AND file_size_bytes <= 5242880),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_customer_photos_booking_created
  ON public.booking_customer_photos (booking_id, created_at);

ALTER TABLE public.booking_customer_photos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.booking_customer_photos FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.booking_customer_photos TO service_role;

NOTIFY pgrst, 'reload schema';