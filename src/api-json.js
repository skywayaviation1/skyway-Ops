export async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path} returned HTTP ${response.status} without JSON`);
  }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

