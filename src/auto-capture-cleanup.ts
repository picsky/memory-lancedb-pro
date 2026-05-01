const AUTO_CAPTURE_INBOUND_META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
] as const;

const AUTO_CAPTURE_SESSION_RESET_PREFIX =
  "A new session was started via /new or /reset. Execute your Session Startup sequence now";
const AUTO_CAPTURE_ADDRESSING_PREFIX_RE = /^(?:<@!?[0-9]+>|@[A-Za-z0-9_.-]+)\s*/;
const AUTO_CAPTURE_SYSTEM_EVENT_LINE_RE = /^System:\s*\[[^\n]*?\]\s*.*$/gim;
const AUTO_CAPTURE_MESSAGE_ID_RE = /\b(?:ou_|msg_|om_)[a-zA-Z0-9]+\b/g;
const AUTO_CAPTURE_BARE_JSON_META_RE = /\{[\s\S]*?"(?:chat_id|message_id|sender_id|open_chat_id)"[\s\S]*?\}/g;
const AUTO_CAPTURE_RUNTIME_WRAPPER_LINE_RE = /^\[(?:Subagent Context|Subagent Task)\]\s*/i;
const AUTO_CAPTURE_RUNTIME_WRAPPER_PREFIX_RE = /^\[(?:Subagent Context|Subagent Task)\]/i;
const AUTO_CAPTURE_RUNTIME_WRAPPER_BOILERPLATE_RE =
  /(?:You are running as a subagent\b.*?(?:$|(?<=\.)\s+)|Results auto-announce to your requester\.?\s*|do not busy-poll for status\.?\s*|Reply with a brief acknowledgment only\.?\s*|Do not use any memory tools\.?\s*)/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const AUTO_CAPTURE_INBOUND_META_BLOCK_RE = new RegExp(
  String.raw`(?:^|\n)\s*(?:${AUTO_CAPTURE_INBOUND_META_SENTINELS.map((sentinel) => escapeRegExp(sentinel)).join("|")})\s*\n\`\`\`json[\s\S]*?\n\`\`\`\s*`,
  "g",
);

function stripLeadingInboundMetadata(text: string): string {
  if (!text) {
    return text;
  }

  let normalized = text;
  for (let i = 0; i < 6; i++) {
    const before = normalized;
    normalized = normalized.replace(AUTO_CAPTURE_SYSTEM_EVENT_LINE_RE, "\n");
    normalized = normalized.replace(AUTO_CAPTURE_INBOUND_META_BLOCK_RE, "\n");
    // Strip bare JSON objects that contain message metadata fields (no fenced code block)
    normalized = normalized.replace(AUTO_CAPTURE_BARE_JSON_META_RE, "\n");
    // Strip residual message IDs (ou_xxx, msg_xxx, om_xxx)
    normalized = normalized.replace(AUTO_CAPTURE_MESSAGE_ID_RE, "");
    normalized = normalized.replace(/\n{3,}/g, "\n\n").trim();
    if (normalized === before.trim()) {
      break;
    }
  }

  return normalized.trim();
}

function stripAutoCaptureSessionResetPrefix(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith(AUTO_CAPTURE_SESSION_RESET_PREFIX)) {
    return trimmed;
  }

  const blankLineIndex = trimmed.indexOf("\n\n");
  if (blankLineIndex >= 0) {
    return trimmed.slice(blankLineIndex + 2).trim();
  }

  const lines = trimmed.split("\n");
  if (lines.length <= 2) {
    return "";
  }
  return lines.slice(2).join("\n").trim();
}

function stripAutoCaptureAddressingPrefix(text: string): string {
  return text.replace(AUTO_CAPTURE_ADDRESSING_PREFIX_RE, "").trim();
}

function stripRuntimeWrapperBoilerplate(text: string): string {
  return text
    .replace(AUTO_CAPTURE_RUNTIME_WRAPPER_BOILERPLATE_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripRuntimeWrapperLine(line: string): string {
  const trimmed = line.trim();
  if (!AUTO_CAPTURE_RUNTIME_WRAPPER_PREFIX_RE.test(trimmed)) {
    return line;
  }

  const remainder = trimmed.replace(AUTO_CAPTURE_RUNTIME_WRAPPER_LINE_RE, "").trim();
  if (!remainder) {
    return "";
  }

  return stripRuntimeWrapperBoilerplate(remainder);
}

function stripLeadingRuntimeWrappers(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }

  const lines = trimmed.split("\n");
  const cleanedLines: string[] = [];
  let strippingLeadIn = true;

  for (const line of lines) {
    const current = line.trim();

    if (strippingLeadIn && current === "") {
      continue;
    }

    if (strippingLeadIn && AUTO_CAPTURE_RUNTIME_WRAPPER_PREFIX_RE.test(current)) {
      const cleaned = stripRuntimeWrapperLine(current);
      if (cleaned) {
        cleanedLines.push(cleaned);
        strippingLeadIn = false;
      }
      continue;
    }

    strippingLeadIn = false;
    cleanedLines.push(line);
  }

  return cleanedLines.join("\n").trim();
}

export function stripAutoCaptureInjectedPrefix(role: string, text: string): string {
  // Apply the same cleaning pipeline to user and assistant messages.
  // Assistant messages may inherit System: lines from the conversation context
  // or quote system events that should not be captured as memories.
  if (role !== "user" && role !== "assistant") {
    return text.trim();
  }

  let normalized = text.trim();
  normalized = normalized.replace(/<relevant-memories>\s*[\s\S]*?<\/relevant-memories>\s*/gi, "");
  normalized = normalized.replace(
    /\[UNTRUSTED DATA[^\n]*\][\s\S]*?\[END UNTRUSTED DATA\]\s*/gi,
    "",
  );
  normalized = stripAutoCaptureSessionResetPrefix(normalized);
  normalized = stripLeadingInboundMetadata(normalized);
  normalized = stripAutoCaptureAddressingPrefix(normalized);
  normalized = stripLeadingRuntimeWrappers(normalized);
  normalized = stripLeadingInboundMetadata(normalized);
  normalized = normalized.replace(/\n{3,}/g, "\n\n");
  return normalized.trim();
}

export function normalizeAutoCaptureText(
  role: unknown,
  text: string,
  shouldSkipMessage?: (role: string, text: string) => boolean,
): string | null {
  if (typeof role !== "string") return null;
  const normalized = stripAutoCaptureInjectedPrefix(role, text);
  if (!normalized) return null;
  if (shouldSkipMessage?.(role, normalized)) return null;
  return normalized;
}
