# NC Talk File/Image Attachment Fix — Complete Summary

## Root Cause

NC Talk sends **two types** of webhook payloads:

- `"type": "Create"` — regular chat messages
- `"type": "Activity"` — system messages (including file shares)

The webhook handler in `monitor.ts` had this filter:

```typescript
if (payload.type !== "Create") {
  res.writeHead(200);
  res.end();
  return;
}
```

This **silently dropped all file share webhooks** because they arrive as `"Activity"`, not `"Create"`.

## The Fix

### One-line change in `monitor.ts` (line 199):

```typescript
// Before:
if (payload.type !== "Create") {

// After:
if (payload.type !== "Create" && payload.type !== "Activity") {
```

### All Changes Across Files

#### 1. `src/monitor.ts`

- Added `parseRichContent()` — parses JSON-encoded rich content from `object.content`
- Added `resolveRichMessageText()` — replaces `{file}`, `{mention-user1}` etc. placeholders with parameter names (regex: `\{([\w-]+)\}`)
- Added `extractFileParameters()` — filters parameters for `type: "file"` entries
- Updated `payloadToInboundMessage()` — uses rich content parsing instead of raw `object.content`; returns `fileParameters` array on the inbound message
- **Fixed the type filter** — accept `"Activity"` payloads (file shares) in addition to `"Create"`

#### 2. `src/types.ts`

- Added `NextcloudTalkRichObjectParameter` type (file metadata: name, path, mimetype, link, size, preview-available)
- Added `NextcloudTalkRichContent` type (`{ message, parameters }`)
- Added `fileParameters?: NextcloudTalkRichObjectParameter[]` to `NextcloudTalkInboundMessage`
- Updated `NextcloudTalkWebhookPayload.type` union to include `"Activity"`

#### 3. `src/inbound.ts`

- Added `buildFileDownloadUrl()` — constructs WebDAV URL from `baseUrl/apiUser/path`, falls back to the `link` field from the parameter
- Added `buildAttachmentBlock()` — builds human-readable attachment lines for the agent body
- Updated `handleNextcloudTalkInbound()` — appends attachment block to agent body when `fileParameters` are present

#### 4. `src/signaling-typing.ts`

- Was **missing** from the local extension at `~/.openclaw/extensions/nextcloud-talk/`, causing the entire NC Talk plugin to fail to load with `Cannot find module './signaling-typing.js'`
- Copied from the upstream global install

## File Locations

| Location | Purpose |
|----------|---------|
| `/home/volt/projects/openclaw-nc-talk-fix/src/` | Working/test copy |
| `~/.openclaw/extensions/nextcloud-talk/src/` | Live local extension (what the gateway loads) |
| `~/.local/lib/node_modules/openclaw/extensions/nextcloud-talk/src/` | Global fallback |

All three locations are synced with identical files.

## Dependencies Added

- `ws` package added to `~/.openclaw/extensions/nextcloud-talk/node_modules/` (needed by `signaling-typing.ts` for typing indicators via WebSocket)

## NC Talk Bot API Notes (for the PR)

- File shares arrive as `"type": "Activity"` with `object.name = "file_shared"` (NC 33+) or `object.name = ""` (pre-NC 33)
- The `object.content` JSON structure is identical for both Create and Activity types
- Bot feature flags (`occ talk:bot:install -f webhook,response`) — the `webhook` flag already covers both chat AND system message events; no extra flag needed
- Other webhook types to be aware of: `"Like"` / `"Undo"` (reactions), `"Join"` / `"Leave"` (bot added/removed from room)
- NC Talk source reference: `nextcloud/spreed` repo — `BotService.php` dispatches `afterSystemMessageSent()` with `type=Activity`

## What the Agent Sees

When a file is shared, the agent body now includes:

```
[User shared an image: IMG_123.jpg]
Attachment: https://cloud.example.com/remote.php/dav/files/Vault/Talk/IMG_123.jpg
```

For text + file combined messages (e.g. "Check this out {file}"):

```
Check this out document.pdf

[User shared a file: document.pdf]
Attachment: https://cloud.example.com/remote.php/dav/files/Vault/Talk/document.pdf
```

## Tests

- **35 tests** passing across 3 test files
- `rich-content.test.ts` — standalone logic tests (18 tests, inlines functions)
- `monitor.rich-content.test.ts` — integrated tests importing `monitor.ts` (14 tests)
- `policy.test.ts` — allowlist policy tests (3 tests)
- Run with: `npx vitest run` from `/home/volt/projects/openclaw-nc-talk-fix/`

## Webhook Payload Examples

### Regular text message (`"type": "Create"`):
```json
{
  "type": "Create",
  "object": {
    "type": "Note",
    "name": "message",
    "content": "{\"message\":\"Hello world\",\"parameters\":{}}",
    "mediaType": "text/markdown"
  }
}
```

### File share message (`"type": "Activity"`):
```json
{
  "type": "Activity",
  "object": {
    "type": "Note",
    "name": "file_shared",
    "content": "{\"message\":\"{file}\",\"parameters\":{\"file\":{\"type\":\"file\",\"id\":\"117924\",\"name\":\"IMG_123.jpg\",\"size\":3145728,\"path\":\"Talk/IMG_123.jpg\",\"link\":\"https://cloud.example.com/f/117924\",\"mimetype\":\"image/jpeg\",\"preview-available\":\"yes\"}}}",
    "mediaType": "text/markdown"
  }
}
```
