import { randomUUID } from 'node:crypto';
import { getSupabase } from '../_supabase.js';
import { verifyOwner, ownerEmail } from '../_email.js';

const CATEGORIES = new Set([
  'software', 'hosting', 'marketing', 'insurance', 'professional_services',
  'office', 'credit', 'travel', 'supplies', 'other',
]);
const RECURRENCES = new Set(['one_time', 'monthly', 'quarterly', 'annual']);
const MAX_CENTS = 100_000_000;

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  const sb = getSupabase();

  if (req.method === 'GET') {
    const { data, error } = await sb
      .from('owner_business_expenses')
      .select('id, recurring_group_id, title, vendor, category, amount_cents, due_date, status, recurrence, payment_date, payment_account, notes, created_by, updated_by, created_at, updated_at')
      .neq('status', 'void')
      .order('due_date', { ascending: true })
      .limit(1000);
    if (error) return respondDbError(res, error, 'load');
    return res.status(200).json({ expenses: data || [] });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const actor = ownerEmail() || 'owner';
  if (req.method === 'POST') {
    const normalized = normalizeExpense(body);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const recurringGroupId = normalized.value.recurrence === 'one_time' ? null : randomUUID();
    const { data, error } = await sb
      .from('owner_business_expenses')
      .insert({ ...normalized.value, recurring_group_id: recurringGroupId, created_by: actor, updated_by: actor })
      .select('id, recurring_group_id, title, vendor, category, amount_cents, due_date, status, recurrence, payment_date, payment_account, notes, created_by, updated_by, created_at, updated_at')
      .single();
    if (error) return respondDbError(res, error, 'save');
    return res.status(201).json({ expense: data });
  }

  if (req.method === 'PATCH') {
    const id = String(body.id || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ error: 'A valid expense ID is required.' });
    }

    if (body.action === 'mark_paid') {
      const paymentDate = normalizeDate(body.paymentDate);
      if (!paymentDate) return res.status(400).json({ error: 'Enter a valid payment date.' });
      const paymentAccount = cleanText(body.paymentAccount, 80);
      const { data, error } = await sb.rpc('mark_owner_business_expense_paid_v1', {
        p_expense_id: id,
        p_payment_date: paymentDate,
        p_payment_account: paymentAccount,
        p_updated_by: actor,
      });
      if (error) {
        if (/not found/i.test(String(error.message || ''))) return res.status(404).json({ error: 'Expense not found.' });
        if (/no longer upcoming/i.test(String(error.message || ''))) return res.status(409).json({ error: 'This expense was already updated. Refresh the list.' });
        return respondDbError(res, error, 'update');
      }
      const result = Array.isArray(data) ? data[0] : data;
      return res.status(200).json({ expense: result?.paid_expense || null, nextExpense: result?.next_expense || null });
    }

    if (body.action === 'void') {
      const { data, error } = await sb
        .from('owner_business_expenses')
        .update({ status: 'void', updated_by: actor, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('status', 'upcoming')
        .select('id')
        .maybeSingle();
      if (error) return respondDbError(res, error, 'update');
      if (!data) return res.status(409).json({ error: 'Only upcoming expenses can be removed. Refresh the list.' });
      return res.status(200).json({ success: true });
    }

    if (body.action !== 'edit') return res.status(400).json({ error: 'Choose a supported expense action.' });
    const normalized = normalizeExpense(body);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const { data, error } = await sb
      .from('owner_business_expenses')
      .update({
        ...normalized.value,
        recurring_group_id: normalized.value.recurrence === 'one_time' ? null : randomUUID(),
        updated_by: actor,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'upcoming')
      .select('id, recurring_group_id, title, vendor, category, amount_cents, due_date, status, recurrence, payment_date, payment_account, notes, created_by, updated_by, created_at, updated_at')
      .maybeSingle();
    if (error) return respondDbError(res, error, 'update');
    if (!data) return res.status(409).json({ error: 'Only upcoming expenses can be edited. Refresh the list.' });
    return res.status(200).json({ expense: data });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function normalizeExpense(input) {
  const title = cleanText(input.title, 120);
  if (!title || title.length < 2) return { error: 'Enter an expense name.' };
  const category = String(input.category || '').trim().toLowerCase();
  if (!CATEGORIES.has(category)) return { error: 'Choose an expense category.' };
  const amount = String(input.amount || '').trim();
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(amount)) return { error: 'Enter a valid amount greater than $0.' };
  const amountCents = Math.round(Number(amount) * 100);
  if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > MAX_CENTS) {
    return { error: 'Amount must be between $0.01 and $1,000,000.00.' };
  }
  const dueDate = normalizeDate(input.dueDate);
  if (!dueDate) return { error: 'Enter a valid due date.' };
  const recurrence = String(input.recurrence || 'one_time').trim().toLowerCase();
  if (!RECURRENCES.has(recurrence)) return { error: 'Choose a valid recurrence.' };
  return { value: {
    title,
    vendor: cleanText(input.vendor, 120),
    category,
    amount_cents: amountCents,
    due_date: dueDate,
    status: 'upcoming',
    recurrence,
    payment_account: cleanText(input.paymentAccount, 80),
    notes: cleanText(input.notes, 1000),
  } };
}

function cleanText(value, max) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
}

function normalizeDate(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? null : date;
}

function respondDbError(res, error, action) {
  console.error(`Owner expenses ${action} error:`, error);
  if (/owner_business_expenses|mark_owner_business_expense_paid_v1|schema cache|does not exist|42P01|42883/i.test(String(error?.message || error?.code || ''))) {
    return res.status(503).json({
      error: 'The expense tracker is not ready yet. Apply migration 113, then refresh.',
      code: 'OWNER_EXPENSES_MIGRATION_REQUIRED',
    });
  }
  return res.status(500).json({ error: `Could not ${action} expense.` });
}
