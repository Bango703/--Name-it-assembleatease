import { db } from './supabase.js';

export async function fetchCustomers() {
  const { data, error } = await db.customers.select('*');
  if (error) throw error;
  return data;
}

export async function fetchCustomer(id) {
  const { data, error } = await db.customers.select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

export async function createCustomer(data) {
  const { data: result, error } = await db.customers.insert(data).select();
  if (error) throw error;
  return result;
}

export async function updateCustomer(id, data) {
  const { data: result, error } = await db.customers.update(data).eq('id', id).select();
  if (error) throw error;
  return result;
}

export async function deleteCustomer(id) {
  const { error } = await db.customers.delete().eq('id', id);
  if (error) throw error;
}
}
