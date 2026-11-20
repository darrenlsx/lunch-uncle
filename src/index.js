import ui from "./ui.html";
import { runLoop, ConfigError } from "./loop.js";
import { sanitizeHistory, cleanSessionId, MAX_MESSAGE_CHARS } from "./history.js";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/") {
      return new Response(ui, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "POST" && pathname === "/chat") {
      return handleChat(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Body must be a JSON object" }, 400);
  }

  const { message, session_id } = body;
  if (typeof message !== "string" || message.trim() === "") {
    return json({ error: "message is required" }, 400);
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return json({ error: `message must be at most ${MAX_MESSAGE_CHARS} characters` }, 400);
  }

  const { history, error } = sanitizeHistory(body.history);
  if (error) {
    return json({ error }, 400);
  }

  try {
    const { reply, messages } = await runLoop(history, message.trim(), env, {
      sessionId: cleanSessionId(session_id) ?? undefined,
    });
    return json({ reply, messages });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error("config error:", err.message);
      return json({ error: `Setup problem: ${err.message}` }, 500);
    }
    console.error("chat failed:", err?.message ?? err);
    return json({ error: "Uncle cannot think right now, try again later." }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
