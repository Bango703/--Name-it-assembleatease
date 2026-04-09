import { supabase } from './supabase.js';

// SIGNUP
const signupForm = document.getElementById('signup-form');
signupForm?.addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const role = document.getElementById('role').value;

  if (!email || !password || !role) {
    alert('Please fill in all fields.');
    return;
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { role }
    }
  });

  if (error) {
    alert(error.message);
    return;
  }

  const user = data.user;

  if (user) {
    const { error: profileError } = await supabase.from('profiles').insert({
      id: user.id,
      full_name: '',
      role,
      email
    });

    if (profileError) {
      alert(profileError.message);
      return;
    }
  }

  alert('Account created! Please check your email to confirm your account.');
  window.location.href = 'login.html';
});

// LOGIN
const loginForm = document.getElementById('login-form');
loginForm?.addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    alert(error.message);
    return;
  }

  const user = data.user;
  if (!user) {
    alert('Login successful, but no user returned.');
    return;
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profileError) {
    alert(profileError.message);
    return;
  }

  if (profile?.role === 'customer') {
    window.location.href = '../customer/index.html';
  } else {
    window.location.href = '../assembler/index.html';
  }
});