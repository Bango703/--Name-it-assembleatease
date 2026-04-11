(function () {
  const SUPABASE_URL  = 'https://ukamyqnaukxlmeoncjgr.supabase.co';
  const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVrYW15cW5hdWt4bG1lb25jamdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDUzMDMsImV4cCI6MjA5MTMyMTMwM30.WMLkxSGm5mnvGfx7gcvf7UKfefjxQf8yOZvk_HzZQNY';
  if (!window.supabase?.createClient) { console.error('[config.js] Supabase CDN not loaded.'); return; }
  window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
})();