import { readFileSync } from "node:fs";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  createScopedPairingAccess,
  createNormalizedOutboundDeliverer,
  createReplyPrefixOptions,
  createTypingCallbacks,
  formatTextWithAttachmentLinks,
  logInboundDrop,
  logTypingFailure,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithCommandGate,
  resolveOutboundMediaUrls,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
  type OutboundReplyPayload,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import {
  normalizeNextcloudTalkAllowlist,
  resolveNextcloudTalkAllowlistMatch,
  resolveNextcloudTalkGroupAllow,
  resolveNextcloudTalkMentionGate,
  resolveNextcloudTalkRequireMention,
  resolveNextcloudTalkRoomMatch,
} from "./policy.js";
import { resolveNextcloudTalkRoomKind } from "./room-info.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { sendMessageNextcloudTalk } from "./send.js";
import { createNcTalkTypingManager } from "./signaling-typing.js";
import type { CoreConfig, GroupPolicy, NextcloudTalkInboundMessage } from "./types.js";

const CHANNEL_ID = "nextcloud-talk" as const;

function resolveNcApiPassword(cfg: {
  apiPassword?: string;
  apiPasswordFile?: string;
}): string | undefined {
  if (cfg.apiPassword?.trim()) return cfg.apiPassword.trim();
  if (!cfg.apiPasswordFile) return undefined;
  try {
    return readFileSync(cfg.apiPasswordFile, "utf-8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reply context enrichment — local patch (pending upstream PR)
 *
 * Fetches the current message (by its own ID) from the NC Talk chat API,
 * reads the `parent` field that Talk includes when a message is a reply,
 * and returns a formatted quote string for injection into agent context.
 *
 * Key design decisions (based on Opus code review):
 *  - Fetches the INCOMING message itself (not threadId) to get the true parent,
 *    since threadId is the thread root which may differ from the direct reply target.
 *  - Validates messageId is numeric before constructing URL.
 *  - Checks HTTP status and OCS meta before parsing.
 *  - Strips HTML tags from parent message text.
 *  - 2s timeout to minimize latency impact.
 *  - Simple in-process LRU cache (max 50 entries) to avoid refetching.
 *  - All errors swallowed — returns null, caller falls back to unmodified body.
 */

/** Strip HTML tags from a string (simple regex, sufficient for NC Talk messages). */
function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

/** Simple bounded Map-based cache for parent message lookups. */
const _parentMsgCache = new Map<string, string | null>();
const PARENT_CACHE_MAX = 50;

function cacheGet(key: string): string | null | undefined {
  return _parentMsgCache.get(key);
}

function cacheSet(key: string, value: string | null): void {
  if (_parentMsgCache.size >= PARENT_CACHE_MAX) {
    // Evict oldest entry
    const firstKey = _parentMsgCache.keys().next().value;
    if (firstKey !== undefined) _parentMsgCache.delete(firstKey);
  }
  _parentMsgCache.set(key, value);
}

type NcTalkParentMessage = {
  id: number;
  message: string;
  actorDisplayName?: string;
};

type NcTalkMessageWithParent = {
  id: number;
  parent?: NcTalkParentMessage;
};

async function fetchReplyParentText(params: {
  baseUrl: string;
  apiUser: string;
  apiPassword: string;
  roomToken: string;
  /** The ID of the incoming message (not threadId). */
  messageId: string;
  allowInsecureSsl?: boolean;
}): Promise<string | null> {
  const { baseUrl, apiUser, apiPassword, roomToken, messageId } = params;

  // Validate numeric ID before constructing URL
  const numericId = parseInt(messageId, 10);
  if (!Number.isFinite(numericId) || numericId <= 0) return null;

  const cacheKey = `${roomToken}:${messageId}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  try {
    // Fetch 1 message ending at messageId (lastKnownMessageId = messageId + 1)
    const url = `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/chat/${roomToken}?lookIntoFuture=0&limit=1&lastKnownMessageId=${numericId + 1}`;
    const { request: httpsRequest } = await import("node:https");
    const { request: httpRequest } = await import("node:http");
    const auth = Buffer.from(`${apiUser}:${apiPassword}`).toString("base64");

    const { statusCode, body: rawData } = await new Promise<{ statusCode: number; body: string }>(
      (resolve, reject) => {
        const req = (url.startsWith("https") ? httpsRequest : httpRequest)(
          url,
          {
            method: "GET",
            headers: {
              "Authorization": `Basic ${auth}`,
              "OCS-APIRequest": "true",
              "Accept": "application/json",
            },
            rejectUnauthorized: params.allowInsecureSsl ? false : true,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }),
            );
          },
        );
        req.on("error", reject);
        req.setTimeout(2000, () => {
          req.destroy();
          reject(new Error("timeout"));
        });
        req.end();
      },
    );

    if (statusCode < 200 || statusCode >= 300) {
      cacheSet(cacheKey, null);
      return null;
    }

    const parsed = JSON.parse(rawData) as {
      ocs?: {
        meta?: { status?: string };
        data?: NcTalkMessageWithParent[];
      };
    };

    if (parsed?.ocs?.meta?.status !== "ok") {
      cacheSet(cacheKey, null);
      return null;
    }

    const messages = parsed?.ocs?.data ?? [];
    const match = messages.find((m) => m.id === numericId);
    const parent = match?.parent;

    if (!parent) {
      cacheSet(cacheKey, null);
      return null;
    }

    const author = parent.actorDisplayName ?? "unknown";
    const text = stripHtml(parent.message ?? "");
    const result = `> **${author}:** ${text}`;
    cacheSet(cacheKey, result);
    return result;
  } catch {
    // Best-effort — don't let enrichment errors break message handling
    cacheSet(cacheKey, null);
    return null;
  }
}

async function deliverNextcloudTalkReply(params: {
  payload: OutboundReplyPayload;
  roomToken: string;
  accountId: string;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, roomToken, accountId, statusSink } = params;
  const combined = formatTextWithAttachmentLinks(payload.text, resolveOutboundMediaUrls(payload));
  if (!combined) {
    return;
  }

  await sendMessageNextcloudTalk(roomToken, combined, {
    accountId,
    replyTo: payload.replyToId,
  });
  statusSink?.({ lastOutboundAt: Date.now() });
}

export async function handleNextcloudTalkInbound(params: {
  message: NextcloudTalkInboundMessage;
  account: ResolvedNextcloudTalkAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getNextcloudTalkRuntime();
  const pairing = createScopedPairingAccess({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }

  const roomKind = await resolveNextcloudTalkRoomKind({
    account,
    roomToken: message.roomToken,
    runtime,
  });
  const isGroup = roomKind === "direct" ? false : roomKind === "group" ? true : message.isGroupChat;
  const senderId = message.senderId;
  const senderName = message.senderName;
  const roomToken = message.roomToken;
  const roomName = message.roomName;
  const threadId = message.threadId;


  statusSink?.({ lastInboundAt: message.timestamp });

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config as OpenClawConfig);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent:
        ((config.channels as Record<string, unknown> | undefined)?.["nextcloud-talk"] ??
          undefined) !== undefined,
      groupPolicy: account.config.groupPolicy as GroupPolicy | undefined,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "nextcloud-talk",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
    log: (message) => runtime.log?.(message),
  });

  const configAllowFrom = normalizeNextcloudTalkAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeNextcloudTalkAllowlist(account.config.groupAllowFrom);
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: CHANNEL_ID,
    accountId: account.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy,
  });
  const storeAllowList = normalizeNextcloudTalkAllowlist(storeAllowFrom);

  const roomMatch = resolveNextcloudTalkRoomMatch({
    rooms: account.config.rooms,
    roomToken,
    roomName,
  });
  const roomConfig = roomMatch.roomConfig;
  if (isGroup && !roomMatch.allowed) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (not allowlisted)`);
    return;
  }
  if (roomConfig?.enabled === false) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (disabled)`);
    return;
  }

  const roomAllowFrom = normalizeNextcloudTalkAllowlist(roomConfig?.allowFrom);

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const useAccessGroups =
    (config.commands as Record<string, unknown> | undefined)?.useAccessGroups !== false;
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const access = resolveDmGroupAccessWithCommandGate({
    isGroup,
    dmPolicy,
    groupPolicy,
    allowFrom: configAllowFrom,
    groupAllowFrom: configGroupAllowFrom,
    storeAllowFrom: storeAllowList,
    isSenderAllowed: (allowFrom) =>
      resolveNextcloudTalkAllowlistMatch({
        allowFrom,
        senderId,
      }).allowed,
    command: {
      useAccessGroups,
      allowTextCommands,
      hasControlCommand,
    },
  });
  const commandAuthorized = access.commandAuthorized;
  const effectiveGroupAllowFrom = access.effectiveGroupAllowFrom;

  if (isGroup) {
    if (access.decision !== "allow") {
      runtime.log?.(`nextcloud-talk: drop group sender ${senderId} (reason=${access.reason})`);
      return;
    }
    const groupAllow = resolveNextcloudTalkGroupAllow({
      groupPolicy,
      outerAllowFrom: effectiveGroupAllowFrom,
      innerAllowFrom: roomAllowFrom,
      senderId,
    });
    if (!groupAllow.allowed) {
      runtime.log?.(`nextcloud-talk: drop group sender ${senderId} (policy=${groupPolicy})`);
      return;
    }
  } else {
    if (access.decision !== "allow") {
      if (access.decision === "pairing") {
        const { code, created } = await pairing.upsertPairingRequest({
          id: senderId,
          meta: { name: senderName || undefined },
        });
        if (created) {
          try {
            await sendMessageNextcloudTalk(
              roomToken,
              core.channel.pairing.buildPairingReply({
                channel: CHANNEL_ID,
                idLine: `Your Nextcloud user id: ${senderId}`,
                code,
              }),
              { accountId: account.accountId },
            );
            statusSink?.({ lastOutboundAt: Date.now() });
          } catch (err) {
            runtime.error?.(`nextcloud-talk: pairing reply failed for ${senderId}: ${String(err)}`);
          }
        }
      }
      runtime.log?.(`nextcloud-talk: drop DM sender ${senderId} (reason=${access.reason})`);
      return;
    }
  }

  if (access.shouldBlockControlCommand) {
    logInboundDrop({
      log: (message) => runtime.log?.(message),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return;
  }

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const wasMentioned = mentionRegexes.length
    ? core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes)
    : false;
  const shouldRequireMention = isGroup
    ? resolveNextcloudTalkRequireMention({
        roomConfig,
        wildcardConfig: roomMatch.wildcardConfig,
      })
    : false;
  const mentionGate = resolveNextcloudTalkMentionGate({
    isGroup,
    requireMention: shouldRequireMention,
    wasMentioned,
    allowTextCommands,
    hasControlCommand,
    commandAuthorized,
  });
  if (isGroup && mentionGate.shouldSkip) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (no mention)`);
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: isGroup ? roomToken : senderId,
    },
  });

  const fromLabel = isGroup ? `room:${roomName || roomToken}` : senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(
    (config.session as Record<string, unknown> | undefined)?.store as string | undefined,
    {
      agentId: route.agentId,
    },
  );
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // Reply context enrichment: NC Talk bot webhooks don't include threadId/parent in the payload,
  // so we always fetch the incoming message from the chat API to check for a `parent` field.
  // Non-reply messages are cached as null after the first fetch (cheap on subsequent calls).
  // Requires apiUser + apiPassword (same creds as typing indicators). Best-effort: never throws.
  const replyApiUser = account.config.apiUser?.trim();
  const replyApiPassword = resolveNcApiPassword(account.config);
  let enrichedBody = rawBody;
  if (replyApiUser && replyApiPassword) {
    const parentQuote = await fetchReplyParentText({
      baseUrl: account.baseUrl,
      apiUser: replyApiUser,
      apiPassword: replyApiPassword,
      roomToken,
      messageId: message.messageId,
      allowInsecureSsl: account.config.allowInsecureSsl ?? false,
    });
    if (parentQuote) {
      enrichedBody = `${parentQuote}\n\n${rawBody}`;
    }
  }

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Nextcloud Talk",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: enrichedBody,
  });

  const groupSystemPrompt = roomConfig?.systemPrompt?.trim() || undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: enrichedBody,
    RawBody: enrichedBody,
    CommandBody: rawBody,
    From: isGroup ? `nextcloud-talk:room:${roomToken}` : `nextcloud-talk:${senderId}`,
    To: `nextcloud-talk:${roomToken}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    GroupSubject: isGroup ? roomName || roomToken : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: isGroup ? wasMentioned : undefined,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `nextcloud-talk:${roomToken}`,
    CommandAuthorized: commandAuthorized,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`nextcloud-talk: failed updating session meta: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config as OpenClawConfig,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });
  const deliverReply = createNormalizedOutboundDeliverer(async (payload) => {
    await deliverNextcloudTalkReply({
      payload: threadId ? { ...payload, replyToId: payload.replyToId ?? threadId } : payload,
      roomToken,
      accountId: account.accountId,
      statusSink,
    });
  });

  // Typing indicators via HPB WebSocket signaling (optional — requires apiUser + apiPassword)
  const apiUser = account.config.apiUser?.trim();
  const apiPassword = resolveNcApiPassword(account.config);
  const typingCallbacks = (() => {
    if (!apiUser || !apiPassword) return undefined;
    const mgr = createNcTalkTypingManager({
      baseUrl: account.baseUrl,
      apiUser,
      apiPassword,
      roomToken,
      allowInsecureSsl: account.config.allowInsecureSsl ?? false,
    });
    return createTypingCallbacks({
      start: () => mgr.sendTyping(),
      stop: () => mgr.stop(),
      onStartError: (err) =>
        logTypingFailure({
          log: runtime.log ?? (() => undefined),
          channel: CHANNEL_ID,
          target: roomToken,
          error: err,
        }),
    });
  })();

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config as OpenClawConfig,
    dispatcherOptions: {
      ...prefixOptions,
      typingCallbacks,
      deliver: deliverReply,
      onError: (err, info) => {
        runtime.error?.(`nextcloud-talk ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      skillFilter: roomConfig?.skills,
      onModelSelected,
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
    },
  });
}
