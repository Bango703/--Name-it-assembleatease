(function () {
  const SUPABASE_URL  = 'https://ukamyqnaukxlmeoncjgr.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_VjHBCo8wUahtg31Gb321qA_TG1e_VbN';
  if (!window.supabase?.createClient) { console.error('[config.js] Supabase CDN not loaded.'); return; }
  window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
})();