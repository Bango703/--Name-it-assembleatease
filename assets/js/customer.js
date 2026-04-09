import { get, post, put, del } from './api.js';

export async function fetchCustomers() {
  return get('/api/customers');
}

export async function fetchCustomer(id) {
  return get(`/api/customers/${id}`);
}

export async function createCustomer(data) {
  return post('/api/customers', data);
}

export async function updateCustomer(id, data) {
  return put(`/api/customers/${id}`, data);
}

export async function deleteCustomer(id) {
  return del(`/api/customers/${id}`);
}
