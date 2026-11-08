import { describe, expect, it } from "vitest";
import { credentialsMessage, detectSensitivity, findSecrets, maskSecrets, SECRET_MASK } from "@/server/ai/rules";
import { smartInstructions } from "@/server/smart/prompt";
import { maskAccountNumbers } from "@/lib/ai-redact";
import { maskedNotice } from "@/lib/hermes";

// Fixtures are assembled at runtime so `npm run secrets:scan` never sees a literal key.
const j = (...p: string[]) => p.join("");
const GHP = j("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
const SK = j("sk", "-", "proj-", "Ab12Cd34Ef56Gh78Ij90Kl12");
const SK_ANT = j("sk", "-ant-", "api03-", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2");
const XOXB = j("xo", "xb-", "1234567890-abcdefghijkl");
const AKIA = j("AK", "IA", "ABCDEFGHIJKLMNOP");
const JWT = j("ey", "JhbGciOiJIUzI1NiJ9", ".", "ey", "JzdWIiOiIxMjM0NSJ9", ".", "c2lnbmF0dXJlLXZhbHVl");
const PEM = j("-----BEGIN RSA", " PRIVATE KEY-----\nMIIEow\n-----END RSA", " PRIVATE KEY-----");
const CARD = "4111 1111 1111 1111";

describe("credential detector: false positives (2026-11-07 chat hotfix)", () => {
  // The owner's message was blocked with "Credentials are never sent to AI". Root cause: the old
  // SECRETISH rule treated any of token/secret/password/api key/authorization followed by whitespace
  // and ANY 6+ char word as a credential, so plain prose like "token expired again" blocked a send.
  const SAFE = [
    "Fix the issues blocking this. Chat",
    "Fix the issues blocking this. Chat https://jarvis.nickbolles.com/chat/api_1794067488_cb8ce8e2",
    "api_1794067488_cb8ce8e2",
    "https://jarvis.nickbolles.com/areas?item=wk_1133c042-1337-4b22-b686-762ac2dc00b1",
    "https://github.com/NickBolles/Personal-dashboard/pull/236",
    "https://github.com/settings/tokens/new",
    "https://artifacts.nickbolles.com/v/jarvis-board-20261107/",
    "Fix the issues blocking this. Chat token expired again",
    "Rotate the agent token before Friday",
    "Authorization header missing on /api/mcp",
    "the password reset flow is broken",
    "secret santa planning",
    "Add JARVIS_HERMES_KEY_CHIEFOFSTAFF to the secrets env",
    "the API key rotation reminder",
    "token: expired",
    "password: required",
    "Use Basic auth-based login for the router",
    "bearer authentication docs",
    "api_key=${HERMES_API_KEY}",
    "const token = process.env.GITHUB_TOKEN",
    "Session api_1794067488_cb8ce8e2 token count is 12000",
  ];
  it("ordinary prose, Jarvis session ids and Jarvis/GitHub/artifacts URLs are not credentials", () => {
    for (const t of SAFE) expect(detectSensitivity(t), t).not.toBe("credentials");
    for (const t of SAFE) expect(findSecrets(t), t).toEqual([]);
  });

  it("the chat run pipeline (message + smart instructions) does not block the owner's message", () => {
    for (const t of SAFE) expect(maskSecrets([t, smartInstructions()].join("\n")).masked, t).toEqual([]);
  });
});

describe("credential detector: real secrets are still caught", () => {
  const CREDENTIALS = [
    `my github token ${GHP}`,
    GHP,
    SK,
    SK_ANT,
    XOXB,
    AKIA,
    JWT,
    PEM,
    "password: hunter2hunter2",
    "password=hunter2",
    "Password: correcthorsebatterystaple",
    j("Authorization: Bearer ", "abc123def456ghi789"),
    j("curl -H 'Authorization: Bearer ", "Zm9vYmFyYmF6cXV4cXV1eA==", "'"),
    j('{"api_key": "', "a1b2c3d4e5f6", '"}'),
    j("GITHUB_TOKEN=", "abc123def456ghi789jkl"),
    j("client_secret: ", "9f8e7d6c5b4a"),
    j("my token is ", "Qw3rTy9Uiop4Asdf5Ghjk"),
    j("https://admin:", "s3cretP4ss", "@db.example.com/x"),
    j("https://example.com/cb?token=", "abc123def456"),
  ];
  it("each fixture is flagged as credentials", () => {
    for (const t of CREDENTIALS) expect(detectSensitivity(t), t).toBe("credentials");
  });

  it("masking removes the secret value and nothing of it reaches the text", () => {
    for (const t of CREDENTIALS) {
      const m = maskSecrets(`Please check this for me: ${t}`);
      expect(m.masked.length, t).toBeGreaterThan(0);
      expect(m.text, t).toContain(SECRET_MASK);
      expect(findSecrets(m.text), t).toEqual([]);
      for (const secret of [GHP, SK, SK_ANT, XOXB, AKIA, JWT, "hunter2", "abc123def456ghi789", "s3cretP4ss", "MIIEow"])
        if (t.includes(secret)) expect(m.text, t).not.toContain(secret);
    }
  });

  it("hints name the part without echoing the secret", () => {
    const m = maskSecrets(`deploy with ${GHP} and password: hunter2hunter2`);
    expect(m.masked.map((x) => x.hint)).toEqual(["ghp_…", "password: …"]);
    for (const h of m.masked) expect(GHP.startsWith(h.hint.replace("…", "")) || h.hint.startsWith("password")).toBe(true);
    expect(JSON.stringify(m.masked)).not.toContain("hunter2");
    expect(JSON.stringify(m.masked)).not.toContain(GHP.slice(4));
  });

  it("16-digit card numbers are finance and masked to the last 4 before any prompt", () => {
    expect(detectSensitivity(`card ${CARD}`)).toBe("finance");
    expect(maskAccountNumbers(`card ${CARD}`)).toBe("card ••••1111");
  });
});

describe("mask vs block", () => {
  it("quoted values are masked through the closing quote (Codex P1)", () => {
    for (const [t, secret] of [
      [j('Please debug login with password="', "hunter2,secondHalf9", '" on staging'), "secondHalf9"],
      [j("set password='", "two words 9x", "' then retry"), "two words"],
      [j('Why does {"client_secret": "', "abc,def;ghi 123", '", "x": 1} fail here?'), "def;ghi"],
      [j("retry with password=", "hunter2,secondHalf9", " please"), "secondHalf9"],
    ]) {
      const m = maskSecrets(t!);
      expect(m.masked.length, t).toBe(1);
      expect(m.text, t).not.toContain(secret);
      expect(m.onlySecrets, t).toBe(false);
    }
    expect(maskSecrets("Login fails with password=hunter2.").text).toBe(`Login fails with password=${SECRET_MASK}.`);
  });

  it("assigned UUIDs are credentials (Codex P1)", () => {
    const UUID = "550e8400-e29b-41d4-a716-446655440000";
    for (const t of [`Please debug using token=${UUID} on staging`, `password: ${UUID}`, j("Authorization: Bearer ", UUID)]) {
      const m = maskSecrets(t);
      expect(m.masked.length, t).toBe(1);
      expect(m.text, t).not.toContain(UUID);
    }
    // A UUID in prose without a credential keyword is still fine.
    expect(findSecrets(`Delivery ${UUID} failed`)).toEqual([]);
  });

  it("escaped quotes inside a quoted secret don't end it (Codex P1)", () => {
    for (const t of [j('Please debug {"password": "', 'first\\"secondHalf9', '"} on staging'), j("set password='", "it\\'s secondHalf9", "' then retry")]) {
      const m = maskSecrets(t);
      expect(m.masked.length, t).toBe(1);
      expect(m.text, t).not.toContain("secondHalf9");
      expect(m.text, t).not.toContain("first");
    }
  });

  it("long quoted secrets are masked whole and an unclosed quote fails closed (Codex P1)", () => {
    const long = j('test turn: password="', "a1".repeat(130), ' secondHalf9" ok');
    const m = maskSecrets(long);
    expect(m.masked.length).toBe(1);
    expect(m.text).toBe(`test turn: password="${SECRET_MASK}" ok`);
    const open = maskSecrets(j('debug password="', "hunter2 secondHalf9"));
    expect(open.text).not.toContain("secondHalf9");
    expect(open.text).not.toContain("hunter2");
  });

  it("credential URLs and multiline quoted secrets are masked (Codex P1)", () => {
    const hook = j("https://discord.com/api/webhooks/", "123456789/abc123def456ghi789");
    const m = maskSecrets(`Please debug using secret=${hook} on staging`);
    expect(m.masked.length).toBe(1);
    expect(m.text).not.toContain("abc123def456ghi789");
    for (const t of [
      j("const password = `", "first123\nsecondHalf9", "`;\nconsole.log(1)"),
      j('password = """', "first123\nsecondHalf9", '"""\nprint(1)'),
      j('{"password": "', "first123\\\nsecondHalf9", '"}'),
    ]) {
      const r = maskSecrets(t);
      expect(r.masked.length, t).toBe(1);
      expect(r.text, t).not.toContain("secondHalf9");
      expect(r.text, t).not.toContain("first123");
    }
    expect(findSecrets("token: https://github.com/settings/tokens")).toEqual([]);
  });

  it("overlapping findings are unioned so no part of the enclosing secret survives (Codex P1)", () => {
    const t = j('test turn: password="prefix ', GHP, ' secondHalf9" ok');
    const f = findSecrets(t);
    expect(f.length).toBe(1);
    const m = maskSecrets(t);
    for (const part of ["prefix", GHP, "secondHalf9"]) expect(m.text, part).not.toContain(part);
    expect(m.text).toBe(`test turn: password="${SECRET_MASK}" ok`);
  });

  it("a non-Latin request plus a token is masked and sent, not refused (Codex P2)", () => {
    const m = maskSecrets(`请帮我调查部署失败的原因 ${GHP}`);
    expect(m.onlySecrets).toBe(false);
    expect(m.text).not.toContain(GHP);
  });
  it("a message with prose plus a secret is masked and sent", () => {
    const m = maskSecrets(`Fix the deploy, it fails with password=hunter2 on the staging box`);
    expect(m.onlySecrets).toBe(false);
    expect(m.text).toBe(`Fix the deploy, it fails with password=${SECRET_MASK} on the staging box`);
  });

  it("a message that is only a credential is refused with a message naming the part", () => {
    for (const t of [GHP, `password: hunter2hunter2`, j("Bearer ", "abc123def456ghi789"), `here is my token ${GHP}`, PEM]) {
      const m = maskSecrets(t);
      expect(m.onlySecrets, t).toBe(true);
    }
    const msg = credentialsMessage(maskSecrets(GHP).masked);
    expect(msg).toContain("Credentials are never sent to AI");
    expect(msg).toContain("ghp_…");
    expect(msg).not.toContain(GHP);
  });

  it("client notice reads '1 secret removed'", () => {
    expect(maskedNotice({ masked: ["password: …"] })).toBe("1 secret removed before sending (password: …). The AI never saw it.");
    expect(maskedNotice({})).toBeNull();
  });
});
