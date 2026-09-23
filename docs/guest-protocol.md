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
- `browser.navigate`, `browser.getState`, `browser.snapshot`, `browser.searchPage`, `browser.inspectRegion`, `browser.extractText`, `browser.click`, `browser.type`, `browser.download`
- `app.launch`, `app.openFile`
- `desktop.getState`, `desktop.listWindows`, `desktop.focusWindow`, `desktop.hotkey`, `desktop.type`, `desktop.click`, `desktop.screenshot`

The browser uses a visible persistent Chromium context. `browser.getState`
returns only the current URL, title, loading state, page count, and DOM revision;
it does not read page text. `browser.snapshot` returns a bounded outline of
visible semantic regions plus a bounded list of interactive elements and their
roles, accessible names, values, links, enabled state, checked state, and
selected state. Region previews do not contain the full region content.

`browser.searchPage` performs local lexical ranking over visible semantic
regions in the current page. The guest builds bounded query-hit windows inside
those regions, then scores body text with BM25-like IDF weighting and field
boosts for headings, table headers, and form labels. Phrase, proximity, region
kind, and DOM ancestry also affect ranking. Nested matches with substantially
overlapping query terms are deduplicated in favor of a more specific useful
region. The default is five results.

`browser.inspectRegion` reads one selected region as bounded text, local links,
or structured table columns and rows. Text responses default to 8,000
characters. Table responses default to 50 rows and accept `offset` and `limit`
for pagination; they report total row count, returned row count, offset, and
whether additional content remains.

Region and interactive element refs include the DOM revision, for example
`r12-8` or `e12-3`. Navigation or a detected DOM mutation invalidates refs from
the previous revision; using one returns a stale-ref error. The model should
request a fresh snapshot or search result after that error.

`browser.extractText` requires a non-empty query and is a bounded fallback for
pages whose semantic regions are insufficient. It searches the same semantic
region index, defaults to 6,000 characters, and accepts at most 8,000
characters. There is no `mode: "full"` parameter and no acting-agent method
that returns an entire page text dump.

`browser.download` accepts a semantic element ref or an explicit URL. The guest
waits for Playwright's download event and returns the source URL, final URL,
suggested filename, actual sandbox path, byte size, browser context, and start
timestamp. The host wraps this response in an action receipt.

Mutating and navigational host tools also expose an evidence receipt describing
URL changes, new tabs, browser DOM revision changes, filesystem
existence/bytes/hash, or download effects. A receipt is diagnostic evidence;
the runtime still verifies the user's requirements against current guest state.
