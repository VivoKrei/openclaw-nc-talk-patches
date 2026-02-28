# OpenClaw NC Talk Patches

Local patches for the [OpenClaw](https://github.com/openclaw/openclaw) Nextcloud Talk plugin, maintained until they're merged upstream.

## Scripts

All managed by two scripts in `~/bin/`:

- **`openclaw-upgrade.sh`** — Full upgrade: npm update → check upstream → re-apply needed patches → restart gateway
- **`openclaw-upgrade.sh --check-only`** — Just verify patch status
- **`openclaw-check-patches.sh`** — Quick status check

## Active Patches

### 1. File/Image Attachment Parsing (Issue [#29152](https://github.com/openclaw/openclaw/issues/29152), PR [#29256](https://github.com/openclaw/openclaw/pull/29256))

When a user shares a file or image in NC Talk, the webhook payload encodes it as rich content JSON. The upstream plugin treats this as plain text, so the agent never sees the attachment.

**Files modified:** `types.ts`, `monitor.ts`, `inbound.ts`

**What it does:**
- Parses `object.content` JSON to extract file parameters
- Resolves `{file}` and `{mention-*}` placeholders to display names
- Constructs WebDAV download URLs (with proper percent-encoding)
- Adds `[User shared an image: filename]` + `Attachment: url` to agent body

### 2. startAccount Abort-Signal Lifecycle

NC Talk `startAccount()` returns immediately, causing the channel manager to interpret it as "channel exited" and triggering restart loops (EADDRINUSE). The patch keeps the task alive until the abort signal fires.

**File modified:** `channel.ts`

**Status:** Expected to be fixed in v2026.2.26 upstream. Will auto-skip if upstream has the fix.

## Usage

```bash
# Full upgrade + patch reapply
~/bin/openclaw-upgrade.sh

# Check patch status only
~/bin/openclaw-upgrade.sh --check-only

# Tests
npx vitest run src/rich-content.test.ts
```

## Retirement

The upgrade script auto-detects when upstream has fixed a bug and skips that patch. Once all patches are upstream, this repo can be archived.
