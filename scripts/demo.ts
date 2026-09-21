const baseUrl = process.env.HELM_SERVER_URL ?? 'http://127.0.0.1:8787';
const response = await fetch(`${baseUrl}/api/runs/scripted-demo`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
});
const body = await response
  .json()
  .catch(() => ({ error: 'Invalid server response' }));
console.log(JSON.stringify(body, null, 2));
if (!response.ok) process.exit(1);

export {};
