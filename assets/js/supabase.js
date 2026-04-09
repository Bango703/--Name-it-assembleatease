// Global Supabase client is initialized in config.js
const supabaseClient = window.supabaseClient || window.supabase;

if (!supabaseClient) {
  console.error('Supabase client is not initialized. Ensure config.js loads after the Supabase CDN script.');
}

window.supabaseClient = supabaseClient;
window.db = {
  customers: supabaseClient ? supabaseClient.from('customers') : null
};