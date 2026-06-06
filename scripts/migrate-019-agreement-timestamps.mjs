/**
 * Migration 019: Add contractor agreement timestamp columns to profiles
 * Run: node scripts/migrate-019-agreement-timestamps.mjs
 */
import { readFileSync } from 'fs';
import pg from 'pg';

const { Client } = pg;

const env = readFileSync('.env.local', 'utf8');
const get = k => { const m = env.match(new RegExp(k + '="?([^"\\n]+)"?')); return m ? m[1].trim() : ''; };

const SUPABASE_URL = get('SUPABASE_URL');
const SERVICE_KEY  = get('SUPABASE_SERVICE_KEY');
const projectRef   = SUPABASE_URL.replace('https://', '').replace('.supabase.co', '');

// Supabase Transaction Pooler with JWT as password (service role JWT auth)
const poolerHost = `aws-0-us-east-1.pooler.supabase.com`;
const client = new Client({
  host: poolerHost,
  port: 6543,
  database: 'postgres',
  user: `postgres.${projectRef}`,
  password: SERVICE_KEY,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  try {
    await client.connect();
    console.log('Connected to Supabase pooler');

    const checkRes = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles'
      AND column_name IN ('contractor_agreement_signed_at', 'code_of_conduct_agreed_at')
    `);
    console.log('Existing columns:', checkRes.rows.map(r => r.column_name));

    await client.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS contractor_agreement_signed_at TIMESTAMPTZ`);
    console.log('Added: contractor_agreement_signed_at');
    await client.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS code_of_conduct_agreed_at TIMESTAMPTZ`);
    console.log('Added: code_of_conduct_agreed_at');

    const verifyRes = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles'
      AND column_name IN ('contractor_agreement_signed_at', 'code_of_conduct_agreed_at')
    `);
    console.log('Verified columns:', verifyRes.rows);
  } finally {
    await client.end();
  }
}

run().catch(e => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
