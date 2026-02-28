# OpenClaw NC Talk Patches

Local patches for the [OpenClaw](https://github.com/openclaw/openclaw) Nextcloud Talk plugin, maintained until they're merged upstream.

## Active Patches

### 1. File/Image Attachment Parsing (Issue [#29152](https://github.com/openclaw/openclaw/issues/29152), PR [#29256](https://github.com/openclaw/openclaw/pull/29256))

When a user shares a file or image in NC Talk, the webhook payload encodes it as rich content JSON. The upstream plugin treats this as plain text, so the agent never sees the attachment.

**Files modified:** `types.ts`, `monitor.ts`, `inbound.ts`

**What it does:**
- Parses `object.content` JSON to extract file parameters
- Resolves `{file}` and `{mention-*}` placeholders to display names
- Constructs WebDAV download URLs (with proper percent-encoding)
- Adds `[User shared an image: filename]` + `Attachment: url` to agent body

## Usage

After updating OpenClaw (`npm update -g openclaw`), run:

```bash
~/bin/openclaw-upgrade.sh
```

Or manually copy patched files:

```bash
UPSTREAM="$HOME/.local/lib/node_modules/openclaw/extensions/nextcloud-talk/src"
cp src/types.ts "$UPSTREAM/"
cp src/monitor.ts "$UPSTREAM/"
cp src/inbound.ts "$UPSTREAM/"
openclaw gateway restart
```

## Tests

```bash
npx vitest run src/rich-content.test.ts
```

## Retirement

Remove a patch from this repo once it's merged upstream. Check with:

```bash
~/bin/openclaw-check-patches.sh
```
