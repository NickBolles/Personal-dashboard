// Mock Anthropic Messages API (streaming only, the subset Jarvis uses).
// A message containing "decline-me" ends with stop_reason "refusal".
import { json, readBody } from "./util.mjs";

export function createAnthropic({ apiKey }) {
  const state = { requests: [] };
  function reset() {
    state.requests = [];
  }
  async function handle(req, res, path, url, control) {
    if (control.fail.has("anthropic")) return json(res, 529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    if (req.headers["x-api-key"] !== apiKey) return json(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    if (path !== "/v1/messages" || req.method !== "POST") return json(res, 404, { type: "error", error: { type: "not_found_error", message: "not found" } });
    const body = await readBody(req);
    state.requests.push({
      model: body.model,
      messages: body.messages,
      beta: req.headers["anthropic-beta"] ?? null,
      effort: body.output_config?.effort ?? null,
    });
    const last = [...body.messages].reverse().find((m) => m.role === "user");
    const said = (typeof last?.content === "string" ? last.content : (last?.content ?? []).map((b) => b.text ?? "").join(" ")).split(
      "\n\n---\nContext from Jarvis:",
    )[0];
    const refuse = said.includes("decline-me");
    const answer = refuse
      ? ""
      : `Claude here. You asked: "${said.slice(0, 80)}". (${body.messages.length} message${body.messages.length === 1 ? "" : "s"} in this conversation.)`;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    const pause = () => new Promise((r) => setTimeout(r, Math.min(control.speed, 60)));
    const msg = {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    };
    send("message_start", { message: msg });
    let idx = 0;
    if (body.thinking) {
      send("content_block_start", { index: idx, content_block: { type: "thinking", thinking: "", signature: "" } });
      send("content_block_delta", { index: idx, delta: { type: "thinking_delta", thinking: "Considering the question." } });
      send("content_block_delta", { index: idx, delta: { type: "signature_delta", signature: "sig" } });
      send("content_block_stop", { index: idx });
      idx++;
    }
    if (answer) {
      send("content_block_start", { index: idx, content_block: { type: "text", text: "" } });
      for (const part of answer.match(/.{1,24}/g)) {
        if (res.destroyed) return;
        await pause();
        send("content_block_delta", { index: idx, delta: { type: "text_delta", text: part } });
      }
      send("content_block_stop", { index: idx });
    }
    send("message_delta", { delta: { stop_reason: refuse ? "refusal" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
    send("message_stop", {});
    res.end();
  }
  return { handle, reset, state };
}
