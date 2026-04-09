document.getElementById("signup-form")?.addEventListener("submit", async (e) => {
  e.preventDefault()

  const email = document.getElementById("email").value
  const password = document.getElementById("password").value
  const role = document.getElementById("role").value

  // 1. Create the user in Supabase Auth
  const { data, error } = await supabase.auth.signUp({
    email,
    password
  })

  if (error) {
    alert(error.message)
    return
  }

  const user = data.user

  // 2. Insert profile row
  await supabase.from("profiles").insert({
    id: user.id,
    full_name: "",
    role: role
  })

  alert("Account created! Please log in.")
  window.location.href = "login.html"
})document.getElementById("login-form")?.addEventListener("submit", async (e) => {
  e.preventDefault()

  const email = document.getElementById("email").value
  const password = document.getElementById("password").value

  // 1. Log the user in
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  })

  if (error) {
    alert(error.message)
    return
  }

  const user = data.user

  // 2. Get their role from profiles table
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single()

  // 3. Redirect based on role
  if (profile.role === "customer") {
    window.location.href = "../customer/index.html"
  } else {
    window.location.href = "../assembler/index.html"
  }
})