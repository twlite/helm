```
npm install
npm run dev
```

```
open http://localhost:3000
```

Desktop control API:

- `GET /desktop/status`
- `POST /desktop/mouse/move` with `{ "x": 400, "y": 300 }`
- `POST /desktop/mouse/click` with `{ "button": "left", "amount": 1 }`
- `POST /desktop/mouse/drag` with `{ "x": 700, "y": 500 }`
- `POST /desktop/mouse/scroll` with `{ "direction": "down", "amount": 3 }`
- `POST /desktop/keyboard/key` with `{ "key": "ctrl+l" }`
- `POST /desktop/keyboard/hotkey` with `{ "keys": ["ctrl", "c"] }`
- `POST /desktop/keyboard/type` with `{ "text": "hello world", "delayMs": 12 }`
- `POST /desktop/action` with anthropic-style actions like `mouse_move`, `left_click`, `type`, `key`, `scroll_down`

Desktop command execution modes:

- `DESKTOP_CONTROL_MODE=docker-exec` (default): runs `xdotool` inside container `agent-desktop`.
- `DESKTOP_CONTROL_MODE=local`: runs `xdotool` directly on the same machine as the server process.

Desktop automation implementation lives in workspace package `@helm/desktop` at `packages/desktop`.

Optional environment variables:

- `DESKTOP_CONTAINER` (default `agent-desktop`)
- `DESKTOP_DISPLAY` (default `:99`)
- `DESKTOP_COMMAND_TIMEOUT_MS` (default `10000`)
