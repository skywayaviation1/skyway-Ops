/**
 * POST JSON to a Skyway API route and read a JSON reply.
 *
 * Vercel answers an unknown or crashed route with an HTML page. Passing that
 * to `Response.json()` throws the browser's own parser error — in WebKit,
 * "The string did not match the expected pattern." — which tells an operator
 * nothing. Read the body as text first so the real HTTP status and a next step
 * reach the UI.
 */
export async function postJson(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Could not reach ${path}. Check the network connection and try again.`);
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (data && typeof data === 'object') {
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  if (response.status === 404) {
    throw new Error(
      `${path} is not available on this deployment (HTTP 404). Deploy the latest build, then retry.`,
    );
  }
  throw new Error(
    `${path} returned ${response.status} without JSON. Check the deployment logs for that route.`,
  );
}
