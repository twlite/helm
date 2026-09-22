# Guest protocol

The host sends request envelopes with an ID, a known method, and method-specific parameters. Every parameter object is parsed with a Zod schema before execution.

```json
{"id":"req_123","method":"fs.write","params":{"path":"/home/helm/workspace/demo.txt","content":"hello"}}
```

Success:

```json
{"id":"req_123","ok":true,"result":{"path":"/home/helm/workspace/demo.txt","size":5,"sha256":"...","existedBefore":false}}
```

Failure:

```json
{"id":"req_123","ok":false,"error":{"code":"FILE_OUTSIDE_SANDBOX","message":"..."}}
```

The guest rejects unknown methods, malformed parameters, traversal outside `/home/helm`, and unallowlisted applications. Malformed requests are converted into structured errors and do not terminate the guest process.

## Methods

The initial method groups are:

- `fs.read`, `fs.write`, `fs.mkdir`, `fs.exists`, `fs.list`, `fs.stat`
- `browser.navigate`, `browser.getState`, `browser.snapshot`, `browser.extractText`, `browser.click`, `browser.type`, `browser.download`
- `app.launch`, `app.openFile`
- `desktop.getState`, `desktop.listWindows`, `desktop.focusWindow`, `desktop.hotkey`, `desktop.type`, `desktop.click`, `desktop.screenshot`

The browser uses a visible persistent Chromium context. Semantic snapshots include
the page URL/title, bounded main heading/text, page count, and visible interactive
elements with roles, accessible names, values, links, enabled state, checked state,
and selected state. Snapshots assign temporary references such as `e1` to
interactive elements; references are refreshed when navigation or page state
invalidates them.

`browser.download` accepts a semantic element ref or an explicit URL. The guest
waits for Playwright's download event and returns the source URL, final URL,
suggested filename, actual sandbox path, byte size, browser context, and start
timestamp. The host wraps this response in an action receipt.

Mutating and navigational host tools also expose an evidence receipt describing
URL changes, new tabs, DOM fingerprints, filesystem existence/bytes/hash, or
download effects. A receipt is diagnostic evidence; the runtime still verifies
the user's requirements against current guest state.
