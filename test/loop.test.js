import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runLoop,
  checkConfig,
  ConfigError,
  normaliseToolCalls,
  parseArgs,
} from "../src/loop.js";
import { SYSTEM_PROMPT, withCurrentTime } from "../src/prompt.js";

const env = { OPENCODE_API_KEY: "test-key", GOOGLE_PLACES_API_KEY: "test-places" };

/** A fake fetch for the LLM that replies with the given messages in order. */
function fakeModel(replies, seen = []) {
  let i = 0;
  return async (url, init) => {
    seen.push(JSON.parse(init.body));
    const message = typeof replies === "function" ? replies(i) : replies[Math.min(i, replies.length - 1)];
    i++;
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }), { status: 200 });
  };
}

const rainCall = (id = "c1") => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name: "no_such_tool", arguments: "{}" } }],
});

test("checkConfig gives a clear message when constants are TODO (#12)", () => {
  assert.throws(() => checkConfig(env, "TODO", "x"), (e) => e instanceof ConfigError && /LLM_BASE_URL.*README step 4/.test(e.message));
  assert.throws(() => checkConfig(env, "https://x", "TODO"), /LLM_MODEL.*README step 4/);
  assert.throws(() => checkConfig({}, "https://x", "m"), /OPENCODE_API_KEY/);
  assert.doesNotThrow(() => checkConfig(env, "https://x", "m"));
});

test("runLoop stops after MAX_ROUNDS when the model always calls a tool (#6)", async () => {
  const seen = [];
  const { reply } = await runLoop([], "hi", env, { fetchImpl: fakeModel((i) => rainCall(`c${i}`), seen) });
  assert.match(reply, /tried too many times/);
  assert.equal(seen.length, 8);
});

test("runLoop works without a Places key instead of returning Berseh (#9)", async () => {
  const { reply } = await runLoop([], "will it rain?", { OPENCODE_API_KEY: "k" }, {
    fetchImpl: fakeModel([{ role: "assistant", content: "No rain lah." }]),
  });
  assert.equal(reply, "No rain lah.");
});

test("system prompt is static and the time rides on the user message (#8)", async () => {
  const seen = [];
  await runLoop([], "hi", env, { fetchImpl: fakeModel([{ role: "assistant", content: "Eh." }], seen) });
  const sent = seen[0].messages;
  assert.equal(sent[0].content, SYSTEM_PROMPT);
  assert.doesNotMatch(SYSTEM_PROMPT, /[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.match(sent.at(-1).content, /^hi\n\n\[Current time: .* SGT\]$/);
  assert.equal(seen[0].max_tokens, 600);
});

test("runLoop returns tool calls and results so the client can keep them (#10)", async () => {
  const { reply, messages } = await runLoop([], "hi", env, {
    fetchImpl: fakeModel([rainCall("c1"), { role: "assistant", content: "Done." }]),
  });
  assert.equal(reply, "Done.");
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(messages[2].tool_call_id, "c1");
  assert.match(messages[2].content, /Unknown tool/);
});

test("runLoop turns an empty reply into a friendly message", async () => {
  const { reply } = await runLoop([], "hi", env, { fetchImpl: fakeModel([{ role: "assistant", content: "  " }]) });
  assert.match(reply, /Ask again/);
});

test("runLoop throws a short error on a malformed LLM response", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: "x" }), { status: 200 });
  await assert.rejects(runLoop([], "hi", env, { fetchImpl }), /no choices/);
  const notJson = async () => new Response("<html>", { status: 200 });
  await assert.rejects(runLoop([], "hi", env, { fetchImpl: notJson }), /not JSON/);
  const failing = async () => new Response("secret details", { status: 500 });
  await assert.rejects(runLoop([], "hi", env, { fetchImpl: failing }), (e) => e.message === "LLM returned 500");
});

test("runLoop stops when the turn time budget is used up", async () => {
  let t = 0;
  const { reply } = await runLoop([], "hi", env, {
    now: () => (t += 30_000),
    fetchImpl: fakeModel((i) => rainCall(`c${i}`)),
  });
  assert.match(reply, /tried too many times/);
});

test("normaliseToolCalls drops broken calls and fills missing ids", () => {
  const calls = normaliseToolCalls([
    { function: { name: "get_rain_forecast" } },
    { id: "a", function: {} },
    null,
  ]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].id, /^call_/);
  assert.equal(calls[0].function.arguments, "{}");
  assert.deepEqual(normaliseToolCalls(undefined), []);
});

test("parseArgs flags invalid JSON instead of using {}", () => {
  assert.deepEqual(parseArgs('{"query":"laksa"}'), { query: "laksa" });
  assert.deepEqual(parseArgs(""), {});
  assert.equal(parseArgs("{oops"), null);
  assert.equal(parseArgs("[1]"), null);
});

test("withCurrentTime appends SGT", () => {
  assert.match(withCurrentTime("hi", new Date("2026-11-20T04:30:00Z")), /hi\n\n\[Current time: Friday.*12:30\s?pm SGT\]/i);
});
