import { SYSTEM_PROMPT, withCurrentTime } from "./prompt.js";
import { toolDefinitions, executeTool } from "./tools.js";

// OpenCode Go's OpenAI-compatible endpoint and model.
const LLM_BASE_URL = "https://opencode.ai/inference/go/v1";
const LLM_MODEL = "deepseek-v4.1-flash";

const LLM_TIMEOUT_MS = 20_000;
const LLM_MAX_TOKENS = 600;
const MAX_ROUNDS = 8;
// Overall budget for one user turn, across all model and tool calls.
const TURN_BUDGET_MS = 45_000;

const TOO_MANY_ROUNDS_REPLY = "Uncle tried too many times already. Ask something simpler.";
const EMPTY_REPLY = "Uncle blur already, nothing to say. Ask again?";

/**
 * Thrown when the Worker is not set up correctly. The message is safe to
 * show to the user because it contains no secrets.
 */
export class ConfigError extends Error {}

/**
 * Check the constants and secrets the loop needs, so a skipped setup step
 * gives a clear message instead of an "Invalid URL" crash.
 */
export function checkConfig(env, baseUrl = LLM_BASE_URL, model = LLM_MODEL) {
  if (!baseUrl || baseUrl === "TODO" || !/^https?:\/\//.test(baseUrl)) {
    throw new ConfigError("LLM_BASE_URL is not set in src/loop.js. See README step 4.");
  }
  if (!model || model === "TODO") {
    throw new ConfigError("LLM_MODEL is not set in src/loop.js. See README step 4.");
  }
  if (!env?.OPENCODE_API_KEY) {
    throw new ConfigError("OPENCODE_API_KEY is not set. Add it to .env (local) or with wrangler secret put.");
  }
}

/**
 * Run the agentic loop for one user turn.
 *
 * history is the prior conversation as OpenAI-style messages, already
 * validated by sanitizeHistory. Returns Uncle's reply plus every message
 * this turn added (user, assistant tool calls, tool results, final answer),
 * so the client can send them back next turn and the model keeps its
 * tool results for follow-up questions.
 */
export async function runLoop(history, message, env, { sessionId, fetchImpl = fetch, now = Date.now } = {}) {
  checkConfig(env);

  const started = now();
  const userMessage = { role: "user", content: withCurrentTime(message) };
  const turn = [userMessage];
  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...history, userMessage];
  const session = sessionId ?? crypto.randomUUID();

  // Identical tool calls within one turn reuse the first result.
  const toolCache = new Map();

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const remaining = TURN_BUDGET_MS - (now() - started);
    if (remaining <= 0) {
      console.warn(`turn budget used up after ${round - 1} rounds`);
      return finish(TOO_MANY_ROUNDS_REPLY);
    }

    const { message: assistant, finishReason } = await callModel(
      messages, env, session, Math.min(LLM_TIMEOUT_MS, remaining), fetchImpl,
    );

    const toolCalls = normaliseToolCalls(assistant.tool_calls);
    if (toolCalls.length === 0) {
      const content = typeof assistant.content === "string" ? assistant.content.trim() : "";
      if (finishReason === "content_filter" || !content) {
        return finish(EMPTY_REPLY);
      }
      return finish(content);
    }

    const assistantMessage = { role: "assistant", content: assistant.content ?? null, tool_calls: toolCalls };
    messages.push(assistantMessage);
    turn.push(assistantMessage);

    const results = await Promise.all(toolCalls.map(async (call) => {
      const { name, arguments: rawArgs } = call.function;
      console.log(`round ${round}: ${name}`);
      const key = `${name}:${rawArgs}`;
      if (!toolCache.has(key)) {
        const args = parseArgs(rawArgs);
        toolCache.set(key, args === null
          ? JSON.stringify({ error: "Arguments were not valid JSON. Try again with a JSON object." })
          : executeTool(name, args, env));
      }
      return { role: "tool", tool_call_id: call.id, content: await toolCache.get(key) };
    }));

    messages.push(...results);
    turn.push(...results);
  }

  return finish(TOO_MANY_ROUNDS_REPLY);

  function finish(reply) {
    turn.push({ role: "assistant", content: reply });
    return { reply, messages: turn };
  }
}

async function callModel(messages, env, sessionId, timeoutMs, fetchImpl) {
  const res = await fetchImpl(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENCODE_API_KEY}`,
      "x-opencode-session": sessionId,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      tools: toolDefinitions,
      max_tokens: LLM_MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    // Log a short slice of the body for debugging, but keep it out of the error.
    const body = await res.text().catch(() => "");
    console.error(`LLM returned ${res.status}: ${body.slice(0, 200)}`);
    throw new Error(`LLM returned ${res.status}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("LLM returned a response that was not JSON");
  }

  const choice = data?.choices?.[0];
  if (!choice?.message || typeof choice.message !== "object") {
    throw new Error("LLM response had no choices[0].message");
  }
  return { message: choice.message, finishReason: choice.finish_reason };
}

/**
 * Keep only well-formed tool calls and make sure each has an id, so every
 * tool result can be matched back to its call on the next model request.
 */
export function normaliseToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .filter((call) => typeof call?.function?.name === "string" && call.function.name)
    .map((call) => ({
      id: typeof call.id === "string" && call.id ? call.id : `call_${crypto.randomUUID()}`,
      type: "function",
      function: {
        name: call.function.name,
        arguments: typeof call.function.arguments === "string" ? call.function.arguments : "{}",
      },
    }));
}

/**
 * Parse tool-call arguments. Returns null when they are not a JSON object,
 * so the model can be told instead of the tool silently getting {}.
 */
export function parseArgs(raw) {
  if (raw === undefined || raw === null || raw === "") return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
