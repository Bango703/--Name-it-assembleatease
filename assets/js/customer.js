const supabaseClient = window.supabaseClient || window.supabase;

if (!supabaseClient) {
  console.error('Supabase client is not initialized. Ensure config.js loads before customer.js.');
}

window.fetchCustomers = async function () {
  const { data, error } = await supabaseClient.from('customers').select('*');
  if (error) throw error;
  return data;
};

window.fetchCustomer = async function (id) {
  const { data, error } = await supabaseClient.from('customers').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
};

window.createCustomer = async function (data) {
  const { data: result, error } = await supabaseClient.from('customers').insert(data).select();
  if (error) throw error;
  return result;
};

window.updateCustomer = async function (id, data) {
  const { data: result, error } = await supabaseClient.from('customers').update(data).eq('id', id).select();
  if (error) throw error;
  return result;
};

window.deleteCustomer = async function (id) {
  const { error } = await supabaseClient.from('customers').delete().eq('id', id);
  if (error) throw error;
};