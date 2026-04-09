import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import config from '../../config.js';

const supabaseUrl = config.supabase.url;
const supabaseKey = config.supabase.anonKey;

if (!supabaseUrl || !supabaseKey) {
  console.warn('Supabase URL or key not configured. Please update config.js');
}

export const supabase = createClient(supabaseUrl, supabaseKey);

// Export common database operations
export const db = {
  customers: supabase.from('customers')
};