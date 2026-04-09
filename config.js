const SUPABASE_URL = 'https://ukamyqnaukxlmeoncjgr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVrYW15cW5hdWt4bG1lb25jamdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDUzMDMsImV4cCI6MjA5MTMyMTMwM30.WMLkxSGm5mnvGfx7gcvf7UKfefjxQf8yOZvk_HzZQNY';

function initSupabase() {
  if (!window.supabase) {
    console.error('Supabase library not loaded. Add the CDN script before config.js.');
    return null;
  }

  if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) {
    console.warn('Supabase credentials are missing.');
  }

  window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return window.supabaseClient;
}

window.SUPABASE_URL = SUPABASE_URL;
window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
window.supabaseClient = initSupabase();