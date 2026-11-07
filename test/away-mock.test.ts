import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { createHermes } from "../mock-upstreams/hermes.mjs";
import { parseProposals } from "@/lib/away";

it.each(["SCHEDULED_PROPOSALS", "SCHEDULED_SILENT"])("mock Hermes exposes terminal output for %s without opening sockets", async (input) => {
  const mock = createHermes({ apiKey: "synthetic-mock-only" });
  async function request(method: string, path: string, body?: unknown) {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      method,
      headers: { authorization: "Bearer synthetic-mock-only", "content-type": "application/json" },
    });
    let status = 0;
    let text = "";
    const res = {
      setHeader: vi.fn(),
      writeHead: (code: number) => {
        status = code;
      },
      end: (chunk: string) => {
        text = chunk;
      },
    };
    await mock.handle(req, res, path, new URL(path, "http://mock.invalid"), { fail: new Set(), speed: 1 });
    return { status, body: JSON.parse(text) as { run_id: string; status: string; output: string } };
  }
  const created = await request("POST", "/v1/runs", { session_id: "scheduled-mock-session", input });
  expect(created.status).toBe(202);
  let output = "";
  await vi.waitFor(
    async () => {
      const readback = await request("GET", `/v1/runs/${created.body.run_id}`);
      expect(readback.status).toBe(200);
      expect(readback.body.status).toBe("completed");
      output = readback.body.output;
    },
    { interval: 10, timeout: 1000 },
  );
  if (input === "SCHEDULED_SILENT") expect(output).toBe("NOTHING_NEW");
  else {
    expect(output).toBe(
      'Morning brief: one capture is waiting and one project looks blocked.\n\n```jarvis-proposals\n[{"intent":"create_note","title":"Lantern check-in note","text":"Two captures look like they belong here.","why":"Overnight triage"},{"intent":"update_status","title":"Mark blocked","why":"No movement in 9 days"},{"intent":"deploy","why":"Ship it"}]\n```',
    );
    expect(parseProposals(output).proposals.map((p) => p.intent)).toEqual(["create_note", "update_status", "deploy"]);
  }
});
