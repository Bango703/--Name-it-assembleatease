async function apiRequest(functionName, method = "GET", body = null) {
  const url = `${CONFIG.API_BASE_URL}/${functionName}`;
  const options = {
    method,
    headers: { "Content-Type": "application/json" }
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

window.apiRequest = apiRequest;