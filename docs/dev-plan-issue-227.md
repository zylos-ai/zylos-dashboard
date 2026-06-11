# Dev Plan: Memory browser online editing (#227)

## Summary

Add phase 2 Memory editing to the dashboard for v0.3.0. The existing Memory tab remains the entry point, but opened text files can be edited and saved locally or through an in-page remote agent when the remote fleet key is admin scope.

This is a sensitive write surface. The implementation must never save from stale browser state: every save carries the `sha256` returned by `GET /api/memory/file`, and the producer compares that hash against the current on-disk file immediately before replacing the file. A mismatch returns a conflict response and does not write.

## Scope

**In scope**:

- Local editing of supported Memory files from the Memory tab.
- Remote editing through `/fleet/<agent>/api/memory/file` only when both boundaries are admin-authorized:
  - consumer browser/API session has admin access,
  - configured remote fleet key exchanges to an admin-scope producer session.
- `PUT /api/memory/file?path=<relative>` producer endpoint with JSON body `{ "text": "...", "sha256": "<opened-file-sha256>" }`.
- Strict conflict detection using sha256.
- Same path jail, symlink rejection, file type restrictions, UTF-8/text validation, and 1 MiB size cap as the read side.
- UI dirty state, Save/Reset controls, saving/error/conflict states, and refresh/merge-oriented conflict UX.
- Tests covering local API, proxy write gates, frontend behavior, and conflict handling.

**Out of scope**:

- Force overwrite button.
- Full diff/merge editor.
- Editing binary/unsupported files or files above the 1 MiB cap.
- Creating, deleting, renaming, moving files/directories.
- Editing Memory git history or commit metadata.
- Changing Memory Sync behavior.

## Existing Contracts

- `MemoryBrowser.file()` already returns `{ path, name, size_bytes, mtime, sha256, markdown, text }`.
- `MemoryBrowser.resolvePath()` already enforces the producer memory-root jail, rejects traversal/absolute paths, rejects symlink escapes via realpath, and can require a file.
- `validateMemoryQueryPath()` already provides the consumer-side query-path grammar for proxied memory requests.
- `AuthGate.needsAdminApiAccess()` already treats `/api/memory*` and `/fleet/<agent>/api/memory*` as admin-only for every method.
- `FleetProxy` currently:
  - allows remote memory `GET`/`HEAD`,
  - validates `path` query values for `/api/memory/file` and `/api/memory/git`,
  - blocks memory writes as `read_only_proxy`,
  - has a 1 MiB `MAX_WRITE_BODY_BYTES` request body cap,
  - supports write allowlisting for selected admin operations.
- `remoteIsReadOnly()` already disables the Memory tab for in-page remote agents whose exchanged fleet key is not admin scope.

## Producer API

### `PUT /api/memory/file?path=<relative>`

Authorization:

- Requires admin access, same as existing memory reads.
- Browser sessions are allowed.
- Read-scope API sessions receive `403 { error: "insufficient_scope", required: "admin" }`.

Request:

```json
{
  "text": "# Identity\n...",
  "sha256": "64 lowercase hex characters from the opened file"
}
```

Validation:

- `path` uses the same query parameter and relative path rules as `GET /api/memory/file`.
- `text` must be a string.
- `sha256` must be a 64-character hex string.
- UTF-8 byte length of `text` must be <= `maxFileBytes` (initially 1 MiB).
- Reject NUL-containing text and any content that fails the same text/binary policy used by reads.
- File extension must be in the existing supported text extension set.
- Target must resolve to an existing regular file inside the real memory root; symlinks/directories are rejected.

Conflict detection:

1. Resolve and stat the target with the same path jail used by reads.
2. Read the current file bytes and compute `currentSha256`.
3. If `currentSha256 !== request.sha256`, return `409 { error: "memory_conflict", current: { sha256, mtime, size_bytes } }`.
4. Only after the hash matches, write the new content.
5. Dashboard-originated writes should be serialized per real file path in-process so two dashboard saves cannot pass the hash check simultaneously.

Write behavior:

- Write to a temporary file in the same directory using a random suffix.
- Preserve the existing file mode where practical.
- Use `fs.writeFile` with UTF-8 content, then `rename` the temp file over the target.
- Best effort cleanup of temp files on error.
- After rename, re-read via the same metadata path as `GET /api/memory/file` and return the fresh file object, including the new `sha256`.

Stable responses:

- Success: `200` with the same response shape as `GET /api/memory/file`.
- Conflict: `409 { error: "memory_conflict", current: { sha256, mtime, size_bytes } }`.
- Invalid request body: `400 { error: "invalid_memory_write" }`.
- Invalid path: `400 { error: "invalid_memory_path" }`.
- Missing file: `404 { error: "memory_file_not_found" }`.
- Unsupported file/content: `415 { error: "unsupported_memory_file" }`.
- Too large: `413 { error: "memory_file_too_large" }`.
- Unexpected errors: existing non-leaking `500 { error: "memory_browser_failed" }`.

Do not add a `POST` create path in this slice. Keeping writes to existing files only reduces blast radius for v0.3.0.

## Remote Proxy Policy

Remote writes must follow the #207 double gate:

- Consumer gate:
  - `/fleet/<agent>/api/memory*` already requires admin via `AuthGate`.
  - A read-scope consumer API session must get `403 insufficient_scope` before the proxy reaches upstream.
  - Browser sessions on the consumer remain allowed only if authenticated as admin.
- Proxy write allowlist:
  - Extend `isAllowedProxyWrite()` to allow only `PUT /api/memory/file`.
  - Keep all other memory write methods/endpoints blocked as `403 read_only_proxy`.
  - Existing `MAX_WRITE_BODY_BYTES` should continue to cap proxied write bodies at 1 MiB.
- Consumer path validation:
  - Extend `validateMemoryProxyQuery()` to validate the `path` query for `PUT /api/memory/file` as well as existing file/git reads.
  - Unsafe query paths return `400 invalid_memory_path` before upstream fetch.
  - Encoded slash in the proxied URL path remains fail-closed via `normalizeProxySuffix()`.
- Producer authority:
  - The producer receives the request with the remote session token.
  - If the configured remote fleet key is read scope, producer `AuthGate` returns `403 insufficient_scope`.
  - The producer still performs all path/content/conflict checks. Consumer validation is only an early reject.

## Frontend UX

The Memory tab stays a two-pane browser.

When a supported file is open:

- Show Raw/Rendered as today.
- Add an Edit mode for supported text files when `remoteIsReadOnly()` is false.
- Editing uses a textarea or code-style editor surface sized within the existing pinned Memory pane.
- Save is disabled when:
  - file is not loaded,
  - current remote context is read-only,
  - no changes are pending,
  - a save is already in flight.
- Reset/Revert restores the editor draft to the last loaded server text.
- Dirty state is visible in the file header and/or Save button.
- Switching files with unsaved edits should confirm before discarding.

Save flow:

1. User opens file; UI stores `baseSha256 = file.sha256` and `baseText = file.text`.
2. User edits draft text.
3. Save calls `PUT /api/memory/file?path=<encoded>` through `fetchAgentJson()` / `agentPath()`.
4. Body is `{ text: draftText, sha256: baseSha256 }`.
5. On success:
   - replace `state.memory.file` with returned file,
   - update `baseSha256` and `baseText`,
   - clear dirty state,
   - refresh git metadata best-effort,
   - refresh tree best-effort so size/mtime update.
6. On `memory_conflict`:
   - preserve the user's draft in the browser,
   - show a conflict state explaining the file changed on disk,
   - provide a Refresh latest action that reloads the file and keeps the user's draft available to copy manually,
   - do not offer force overwrite in v0.3.0.

Remote behavior:

- In-page remote with admin access can edit through the proxy.
- In-page remote with read access remains read-only: Memory tab is disabled/redirected as today.
- Standalone remote dashboard behaves like a local producer document because `BASE_PATH` points at that producer.

I18n:

- Add EN/ZH strings for Edit, Save, Reset, Saving, Saved, Unsaved changes, Conflict, Refresh latest, invalid write, and save failure.

## Implementation Steps

1. Extend `src/lib/memory-browser.js`:
   - export or reuse text-extension/UTF-8 validation for writes,
   - add `writeFile(relativePath, { text, sha256 })`,
   - add a per-real-path in-process save queue/mutex,
   - implement conflict detection and temp-file atomic replace,
   - return the same fresh file object as `file()`.
2. Extend `memoryErrorPayload()` for:
   - `memory_conflict` with status 409 and current metadata,
   - `invalid_memory_write` with status 400.
3. Extend `src/index.js` `handleMemoryApi()`:
   - keep `GET`/`HEAD` for tree/file/git,
   - allow `PUT /api/memory/file`,
   - parse JSON body with the existing request body helper style and a 1 MiB cap,
   - reject other memory write methods/endpoints as 405 or stable API errors.
4. Extend `src/lib/fleet-proxy.js`:
   - allow `PUT /api/memory/file` in `isAllowedProxyWrite()`,
   - validate memory file query paths for that write,
   - rely on existing body cap and secret guard.
5. Frontend:
   - add edit/save/reset controls in the Memory viewer header or toolbar,
   - store `baseSha256`, `baseText`, `draftText`, `saving`, `dirty`, and `conflict` state,
   - preserve draft on conflict,
   - prevent accidental file switches with unsaved changes,
   - refresh metadata/tree after successful save,
   - ensure read-only remote contexts cannot enter edit mode.
6. CSS/i18n/cache bust.
7. Tests and smoke.

## Tests

Backend helper/API:

- `PUT /api/memory/file?path=identity.md` requires admin; read API session gets `403 insufficient_scope`.
- Browser session can save a supported local file when sha256 matches.
- Successful save returns fresh `sha256`, updated `mtime`, `size_bytes`, and `text`.
- Stale `sha256` returns `409 memory_conflict` and leaves the existing file unchanged.
- Missing/invalid `sha256`, non-string `text`, malformed JSON, and null body return `400 invalid_memory_write`.
- File above the 1 MiB write cap returns `413 memory_file_too_large`.
- Unsupported extension and NUL/binary-looking content return `415 unsupported_memory_file`.
- Path traversal, absolute path, Windows drive path, backslash path, directory target, missing file, and symlink escape are rejected with stable errors.
- Two concurrent dashboard saves to the same file serialize; one succeeds and the stale one conflicts.
- Unexpected filesystem errors still map to `memory_browser_failed` without leaking errno.

Proxy/auth:

- Consumer read-scope API session `PUT /fleet/<agent>/api/memory/file` receives consumer-side `403 insufficient_scope` and upstream is not hit.
- Consumer admin session + remote admin key can proxy `PUT /api/memory/file` upstream.
- Consumer admin session + remote read key receives producer `403 insufficient_scope`.
- Unsafe query path on proxied memory write returns consumer-side `400 invalid_memory_path`.
- Encoded slash in the proxied URL path remains fail-closed before upstream.
- `POST`/`DELETE` to proxied memory endpoints remain `403 read_only_proxy`.
- Proxied write body above the proxy cap returns `413 request_body_too_large` before upstream.

Frontend/static:

- Edit/Save/Reset controls exist and use `agentPath('/api/memory/file?...')`.
- Save body includes both `text` and the opened file `sha256`.
- Read-only remote contexts cannot edit.
- Conflict response preserves draft and surfaces refresh/merge UX.
- Unsaved changes guard is wired when switching files.
- EN/ZH strings and cache bumps are present.

Regression:

- `git diff --check`
- focused memory helper/API/proxy/frontend tests
- `npm run check`
- full `npm test`
- `npm run smoke`

## Acceptance Checklist

- Local Memory tab can edit `identity.md` or a safe fixture file and immediately shows the new hash/mtime after save.
- A stale browser tab receives a conflict instead of overwriting a newer on-disk edit.
- The user's draft is still available after conflict.
- Read-scope local API token cannot save.
- In-page remote with admin key can save through `/fleet/<agent>/api/memory/file`.
- In-page remote with read key cannot save; API returns 403 and UI remains read-only.
- Proxy path traversal, encoded-slash path probes, unsupported files, large files, and binary/NUL content all fail safely.
- No response includes absolute host paths, API keys, session tokens, or raw unexpected errno details.

## Security Review Seeds

- Confirm the producer is the final authority for auth, path validation, file type, size, and conflict checks.
- Confirm the consumer proxy does not allow broader memory writes than `PUT /api/memory/file`.
- Confirm all write responses pass the existing proxy secret guard.
- Confirm `sha256` conflict detection uses the current file bytes read on the producer at save time, not cached tree metadata.
- Confirm no force-overwrite path exists in v0.3.0.
- Confirm temp-file names cannot escape the target directory and are cleaned up best-effort.
