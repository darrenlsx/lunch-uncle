/**
 * Validation for what the browser sends to /chat. Pure functions, so they
 * are covered by tests.
 */

export const MAX_MESSAGE_CHARS = 1_000;
const MAX_CONTENT_CHARS = 8_000;
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CHARS = 30_000;

/**
 * Check the chat history from the client and trim it to the most recent
 * whole turns that fit the limits.
 *
 * Only user, assistant and tool messages are allowed (no system messages),
 * every tool result must answer a tool call from the assistant message
 * before it, and every tool call must have its result.
 *
 * Returns { history } or { error }.
 */
export function sanitizeHistory(history) {
  if (history === undefined || history === null) return { history: [] };
  if (!Array.isArray(history)) return { error: "history must be an array" };

  const turns = [];
  let pending = new Set();

  for (const [i, raw] of history.entries()) {
    const msg = cleanMessage(raw);
    if (!msg) return { error: `history[${i}] is not a valid message` };

    if (msg.role === "user") {
      if (pending.size) return { error: `history[${i}]: tool calls are missing results` };
      turns.push([msg]);
      continue;
    }
    if (turns.length === 0) return { error: "history must start with a user message" };

    if (msg.role === "assistant") {
      if (pending.size) return { error: `history[${i}]: tool calls are missing results` };
      pending = new Set((msg.tool_calls ?? []).map((c) => c.id));
    } else if (!pending.delete(msg.tool_call_id)) {
      return { error: `history[${i}]: tool result does not match a tool call` };
    }
    turns.at(-1).push(msg);
  }
  if (pending.size) return { error: "history ends with tool calls that have no results" };

  // Keep the newest whole turns that fit, so a turn is never cut in half.
  const kept = [];
  let count = 0;
  let chars = 0;
  for (let t = turns.length - 1; t >= 0; t--) {
    const turn = turns[t];
    const size = turn.reduce((sum, m) => sum + messageChars(m), 0);
    if (count + turn.length > MAX_HISTORY_MESSAGES || chars + size > MAX_HISTORY_CHARS) break;
    kept.unshift(...turn);
    count += turn.length;
    chars += size;
  }
  return { history: kept };
}

function cleanMessage(m) {
  if (!m || typeof m !== "object") return null;
  const okText = (s) => typeof s === "string" && s.length <= MAX_CONTENT_CHARS;

  switch (m.role) {
    case "user":
      return okText(m.content) ? { role: "user", content: m.content } : null;

    case "assistant": {
      const content = m.content ?? null;
      if (content !== null && !okText(content)) return null;
      if (m.tool_calls === undefined || m.tool_calls === null) {
        return content === null ? null : { role: "assistant", content };
      }
      if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) return null;
      const calls = [];
      for (const c of m.tool_calls) {
        if (typeof c?.id !== "string" || !c.id
          || typeof c.function?.name !== "string" || !c.function.name
          || !okText(c.function.arguments)) return null;
        calls.push({ id: c.id, type: "function", function: { name: c.function.name, arguments: c.function.arguments } });
      }
      return { role: "assistant", content, tool_calls: calls };
    }

    case "tool":
      return typeof m.tool_call_id === "string" && m.tool_call_id && okText(m.content)
        ? { role: "tool", tool_call_id: m.tool_call_id, content: m.content }
        : null;

    default:
      return null;
  }
}

function messageChars(m) {
  let n = (m.content ?? "").length;
  for (const c of m.tool_calls ?? []) n += c.function.name.length + c.function.arguments.length;
  return n;
}

/**
 * Accept a client-generated conversation id for the x-opencode-session
 * header, so every turn of one chat shares a cache. Anything else gets null.
 */
export function cleanSessionId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
}
