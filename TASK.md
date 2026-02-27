# Task: Fix NC Talk File/Image Attachment Parsing

## GitHub Issue
https://github.com/openclaw/openclaw/issues/29152

## Objective
Parse rich object parameters from NC Talk webhook payloads so file/image attachments are properly detected and passed to the agent as media URLs.

## Source Code Location
The NC Talk plugin source is at: `/home/volt/.local/lib/node_modules/openclaw/extensions/nextcloud-talk/src/`

**You must work on a copy.** Clone the relevant files into your working directory first.

## Key Files to Modify

### 1. `types.ts` — Update `NextcloudTalkObject` type

The current type:
```typescript
export type NextcloudTalkObject = {
  type: "Note";
  id: string;
  name: string;
  content: string;
  mediaType: string;
};
```

`content` is actually a JSON-encoded string with this structure:
```json
{"message":"{file}","parameters":{"file":{"type":"file","id":"12345","name":"IMG_123.jpg","size":1234567,"path":"Talk/IMG_123.jpg","link":"https://cloud.example.com/f/12345","mimetype":"image/jpeg","preview-available":"yes"}}}
```

The type does NOT need to change (content is a string), but add a helper type for the parsed content:

```typescript
export type NextcloudTalkRichContent = {
  message: string;
  parameters?: Record<string, {
    type: string;
    id: string;
    name: string;
    size?: number;
    path?: string;
    link?: string;
    mimetype?: string;
    "preview-available"?: string;
  }>;
};
```

### 2. `monitor.ts` — Update `payloadToInboundMessage()`

Current code extracts text as:
```typescript
text: payload.object.content || payload.object.name || "",
```

New logic:
1. Try to parse `object.content` as JSON
2. If it has `parameters` with file-type entries, extract file metadata
3. Build the plain text message (resolve `{file}` → filename)
4. Build media URLs from file parameters
5. Pass both text and mediaUrls to the inbound message

**Media URL construction:** Use the `link` field from the file parameter if available. If not, construct from the NC base URL: `{baseUrl}/remote.php/dav/files/{apiUser}/{path}`

Note: The base URL is NOT available in `payloadToInboundMessage` currently. You have two options:
- Option A: Pass it through (preferred) — add baseUrl parameter
- Option B: Use the `link` field from the file parameter (it's a direct NC link like `https://cloud.example.com/f/12345`)

For the download URL that the agent can actually fetch, the WebDAV path is best:
`{baseUrl}/remote.php/dav/files/{apiUser}/Talk/{filename}`

But since `payloadToInboundMessage` doesn't have access to baseUrl/apiUser, the cleanest approach is:
- Store the raw file metadata on the inbound message
- Let `handleNextcloudTalkInbound` in `inbound.ts` construct the proper download URL (it has access to `account.config`)

### 3. `inbound.ts` — Handle media URLs

The `NextcloudTalkInboundMessage` type already has a `text` field. Add `mediaUrls?: string[]` to it.

In `handleNextcloudTalkInbound`, after getting the message, if `message.mediaUrls` has entries, include them in the body sent to the agent. The `deliverNextcloudTalkReply` function already handles `mediaUrls` for outbound — we need similar handling for inbound.

The agent body should look like:
```
[User shared an image: IMG_123.jpg]

Attachment: https://cloud.example.com/remote.php/dav/files/Vault/Talk/IMG_123.jpg
```

### 4. Tests

Create `monitor.rich-content.test.ts` with tests for:
1. Normal text message (no change in behavior)
2. File share message (single file)
3. Image share message (with mimetype image/*)
4. Message with text AND file attachment
5. Malformed JSON in content (graceful fallback to raw text)
6. Multiple file parameters
7. Empty parameters object

## NC Talk Webhook Payload Examples

### Normal text message:
```json
{
  "type": "Create",
  "actor": {"type": "Person", "id": "users/rados", "name": "Radek"},
  "object": {
    "type": "Note",
    "id": "5883",
    "name": "message",
    "content": "{\"message\":\"Hello world\",\"parameters\":{}}",
    "mediaType": "text/markdown"
  },
  "target": {"type": "Collection", "id": "unadatxk", "name": "Volt"}
}
```

### File share message:
```json
{
  "type": "Create",
  "actor": {"type": "Person", "id": "users/rados", "name": "Radek"},
  "object": {
    "type": "Note",
    "id": "5877",
    "name": "",
    "content": "{\"message\":\"{file}\",\"parameters\":{\"file\":{\"type\":\"file\",\"id\":\"117924\",\"name\":\"IMG_1772227153579.jpg\",\"size\":3145728,\"path\":\"Talk/IMG_1772227153579.jpg\",\"link\":\"https://vivokrei-ubuntu.tailfc1e89.ts.net/f/117924\",\"mimetype\":\"image/jpeg\",\"preview-available\":\"yes\"}}}",
    "mediaType": "text/markdown"
  },
  "target": {"type": "Collection", "id": "unadatxk", "name": "Volt"}
}
```

### Message with text AND attachment:
```json
{
  "type": "Create",
  "actor": {"type": "Person", "id": "users/rados", "name": "Radek"},
  "object": {
    "type": "Note",
    "id": "5890",
    "name": "message",
    "content": "{\"message\":\"Check this out {file}\",\"parameters\":{\"file\":{\"type\":\"file\",\"id\":\"117925\",\"name\":\"document.pdf\",\"size\":524288,\"path\":\"Talk/document.pdf\",\"link\":\"https://vivokrei-ubuntu.tailfc1e89.ts.net/f/117925\",\"mimetype\":\"application/pdf\",\"preview-available\":\"no\"}}}",
    "mediaType": "text/markdown"
  },
  "target": {"type": "Collection", "id": "unadatxk", "name": "Volt"}
}
```

## Important Constraints

1. **Backward compatible** — normal text messages must work exactly as before
2. **Graceful degradation** — if JSON parsing fails, fall back to raw content string
3. **No new dependencies** — use only Node.js built-ins
4. **TypeScript strict** — all types must be correct
5. **The `object.name` bug** — on NC < 33, `object.name` is empty for attachment messages. The fix must not rely on `object.name`
6. **Security** — don't blindly trust the `link` URL from parameters; construct WebDAV URL from known baseUrl when possible

## File Structure for PR

```
extensions/nextcloud-talk/src/
├── types.ts                        # Add NextcloudTalkRichContent type
├── monitor.ts                      # Update payloadToInboundMessage()
├── monitor.rich-content.test.ts    # New test file
└── inbound.ts                      # Handle mediaUrls in inbound flow
```

## Definition of Done

1. All existing tests still pass
2. New tests cover all 7 scenarios above
3. Normal text messages work identically to before
4. File/image shares produce mediaUrls on the inbound message
5. Agent receives attachment info in a usable format
6. TypeScript compiles with no errors
7. Code is clean, commented where non-obvious
