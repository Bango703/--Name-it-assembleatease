// ============================================
//  ASSEMBLEATEASE — auth.js
//  Handles signup + login form submissions
//  Depends on: supabaseClient (from config.js),
//              APP (from app.js)
// ============================================

(function () {
  // ── Guard ──────────────────────────────────────────────
  if (typeof supabaseClient === 'undefined') {
    console.error('[auth.js] supabaseClient is not defined. Make sure config.js is loaded first.');
    return;
  }

  // ── Helpers ────────────────────────────────────────────
  function showAlert(type, message) {
    if (typeof APP !== 'undefined') {
      APP.showAlert('auth-alert', message, type);
    } else {
      // Fallback if APP isn't loaded yet
      const el = document.getElementById('auth-alert');
      if (el) {
        el.className = `alert alert-${type}`;
        el.textContent = message;
      }
    }
  }

  function hideAlert() {
    if (typeof APP !== 'undefined') {
      APP.hideAlert('auth-alert');
    }
  }

  function setLoading(btnId, isLoading, label) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = isLoading;
    btn.textContent = label;
  }

  function fieldError(inputId, message) {
    const input = document.getElementById(inputId);
    const errEl = document.getElementById(`${inputId}-error`);
    input?.classList.add('error');
    if (errEl) { errEl.textContent = message; errEl.classList.add('visible'); }
  }

  function clearFieldErrors() {
    document.querySelectorAll('.form-control').forEach(el => el.classList.remove('error'));
    document.querySelectorAll('.field-error').forEach(el => {
      el.textContent = ''; el.classList.remove('visible');
    });
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  // ── SIGNUP ─────────────────────────────────────────────
  const signupForm = document.getElementById('signup-form');
  signupForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();
    clearFieldErrors();

    const firstName = document.getElementById('first-name')?.value.trim() || '';
    const lastName  = document.getElementById('last-name')?.value.trim()  || '';
    const email     = document.getElementById('email')?.value.trim()      || '';
    const password  = document.getElementById('password')?.value          || '';
    const confirm   = document.getElementById('confirm-password')?.value  || '';
    const role      = 'customer'; // Signup page is customer-only; assemblers use /assembler/apply

    // Validation
    let hasError = false;
    if (!firstName) { fieldError('first-name', 'First name is required.');         hasError = true; }
    if (!lastName)  { fieldError('last-name',  'Last name is required.');           hasError = true; }
    if (!email) {
      fieldError('email', 'Email is required.');                                     hasError = true;
    } else if (!isValidEmail(email)) {
      fieldError('email', 'Please enter a valid email address.');                    hasError = true;
    }
    if (!password) {
      fieldError('password', 'Password is required.');                               hasError = true;
    } else if (password.length < 8) {
      fieldError('password', 'Password must be at least 8 characters.');             hasError = true;
    }
    if (!confirm) {
      fieldError('confirm-password', 'Please confirm your password.');               hasError = true;
    } else if (password !== confirm) {
      fieldError('confirm-password', 'Passwords do not match.');                     hasError = true;
    }
    if (hasError) return;

    // Assemblers must go through the proper apply form (not general signup)
    if (role === 'assembler') {
      showAlert('info', 'To join as an assembler, please complete our application form.');
      setTimeout(() => { window.location.href = '../assembler/apply'; }, 1800);
      return;
    }

    setLoading('signup-btn', true, 'Creating account…');

    try {
      const fullName = `${firstName} ${lastName}`.trim();

      const { data, error } = await supabaseClient.auth.signUp({
        email,
        password,
        options: { data: { role, full_name: fullName } }
      });

      if (error) {
        showAlert('error', error.message || 'Sign up failed. Please try again.');
        setLoading('signup-btn', false, 'Create Free Account');
        return;
      }

      // Email confirmation required — session will be null
      if (!data.session) {
        showAlert('success', 'Account created! Please check your email to confirm before logging in.');
        setLoading('signup-btn', false, 'Create Free Account');
        return;
      }

      // Upsert profile — safe even if a DB trigger already created the row
      const { error: profileError } = await supabaseClient
        .from('profiles')
        .upsert({
          id:        data.user.id,
          full_name: fullName,
          email,
          role,
        }, { onConflict: 'id' });

      if (profileError) {
        // Non-fatal — user is authenticated, log and continue
        console.error('[auth.js] Profile upsert error:', profileError);
      }

      window.location.href = role === 'assembler'
        ? '../assembler/'
        : '../customer/';

    } catch (err) {
      console.error('[auth.js] Signup error:', err);
      showAlert('error', 'Something went wrong. Please try again.');
      setLoading('signup-btn', false, 'Create Free Account');
    }
  });

  // ── LOGIN ──────────────────────────────────────────────
  const loginForm = document.getElementById('login-form');
  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();
    clearFieldErrors();

    const email    = document.getElementById('email')?.value.trim()    || '';
    const password = document.getElementById('password')?.value        || '';

    // Validation
    let hasError = false;
    if (!email) {
      fieldError('email', 'Email is required.');                         hasError = true;
    } else if (!isValidEmail(email)) {
      fieldError('email', 'Please enter a valid email address.');        hasError = true;
    }
    if (!password) {
      fieldError('password', 'Password is required.');                   hasError = true;
    }
    if (hasError) return;

    setLoading('login-btn', true, 'Logging in…');

    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

      if (error) {
        showAlert('error', error.message || 'Login failed. Please try again.');
        setLoading('login-btn', false, 'Log in');
        return;
      }

      // Fetch profile role
      const { data: profile, error: profileError } = await supabaseClient
        .from('profiles')
        .select('role')
        .eq('id', data.user.id)
        .single();

      if (profileError || !profile) {
        showAlert('error', 'Could not load your profile. Please try again.');
        setLoading('login-btn', false, 'Log in');
        return;
      }

      window.location.href = profile.role === 'assembler'
        ? '../assembler/'
        : profile.role === 'owner'
          ? '../owner/'
          : '../customer/';

    } catch (err) {
      console.error('[auth.js] Login error:', err);
      showAlert('error', 'Something went wrong. Please try again.');
      setLoading('login-btn', false, 'Log in');
    }
  });

})();