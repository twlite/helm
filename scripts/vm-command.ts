const command = Bun.argv[2];
if (!command || !['start', 'stop', 'force-stop', 'reset', 'status'].includes(command)) {
  console.error('Usage: bun run vm:start [--gui] | bun run vm:stop | bun run vm:force-stop | bun run vm:reset | bun run vm:status');
  process.exit(1);
}

const commandArguments = Bun.argv.slice(3);
const showWindow = command === 'start' && commandArguments.includes('--gui');
const hasUnknownArgument = commandArguments.some(argument => argument !== '--gui')
  || (command !== 'start' && commandArguments.length > 0);
if (hasUnknownArgument) {
  console.error('Usage: bun run vm:start [--gui] | bun run vm:stop | bun run vm:force-stop | bun run vm:reset | bun run vm:status');
  process.exit(1);
}

const baseUrl = process.env.HELM_SERVER_URL ?? 'http://127.0.0.1:8787';
const endpoint = new URL(`/api/vm/${command}`, baseUrl);
if (showWindow) endpoint.searchParams.set('gui', 'true');
const response = await fetch(endpoint, { method: command === 'status' ? 'GET' : 'POST' }).catch(error => {
  console.error(`Could not reach Helm server at ${baseUrl}: ${String(error)}`);
  process.exit(1);
});
const body = await response.json().catch(() => ({ error: 'Invalid server response' }));
if (body && typeof body === 'object' && !Array.isArray(body) && 'screenshot' in body) {
  const { screenshot: _screenshot, ...compactBody } = body as Record<string, unknown>;
  console.log(JSON.stringify(compactBody, null, 2));
} else {
  console.log(JSON.stringify(body, null, 2));
}
if (!response.ok) process.exit(1);
