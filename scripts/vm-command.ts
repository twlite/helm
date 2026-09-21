const command = Bun.argv[2];
if (!command || !['start', 'stop', 'reset'].includes(command)) {
  console.error('Usage: bun run vm:start|vm:stop|vm:reset');
  process.exit(1);
}

const baseUrl = process.env.HELM_SERVER_URL ?? 'http://127.0.0.1:8787';
const response = await fetch(`${baseUrl}/api/vm/${command}`, { method: 'POST' }).catch(error => {
  console.error(`Could not reach Helm server at ${baseUrl}: ${String(error)}`);
  process.exit(1);
});
const body = await response.json().catch(() => ({ error: 'Invalid server response' }));
console.log(JSON.stringify(body, null, 2));
if (!response.ok) process.exit(1);
