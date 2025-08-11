import { afterAll, expect, test } from "bun:test";

process.env.DB_PATH = ":memory:";
process.env.PORT = "0";
const { server } = await import("./index");
const base = `http://localhost:${server.port}`;

// register two clients for tests
const c1Res = await fetch(`${base}/register`, { method: "POST" });
const c1 = await c1Res.json();
const c2Res = await fetch(`${base}/register`, { method: "POST" });
const c2 = await c2Res.json();

afterAll(() => server.stop());

test("register provides credentials", () => {
  expect(c1.id).toBeDefined();
  expect(c1.secret).toBeDefined();
  expect(c1.token).toBeDefined();
});

test("publish delivers to recipient", async () => {
  const res = await fetch(`${base}/publish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${c1.token}`,
    },
    body: JSON.stringify({ channel: c2.id, content: "hello" }),
  });
  expect(res.status).toBe(200);
  const pub = await res.json();
  expect(pub.deliveredTo).toBe(1);
  const pollRes = await fetch(`${base}/poll`, {
    headers: { Authorization: `Bearer ${c2.token}` },
  });
  const messages = await pollRes.json();
  expect(messages.some((m: any) => m.content === "hello")).toBe(true);
});

test("incoming accepts valid secret", async () => {
  const res = await fetch(`${base}/incoming`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: c2.id,
      secret: c2.secret,
      content: "external",
    }),
  });
  expect(res.status).toBe(200);
  const { id } = await res.json();
  expect(id).toBeDefined();
  const pollRes = await fetch(`${base}/poll`, {
    headers: { Authorization: `Bearer ${c2.token}` },
  });
  const messages = await pollRes.json();
  expect(messages.some((m: any) => m.content === "external")).toBe(true);
});

test("incoming rejects invalid secret", async () => {
  const res = await fetch(`${base}/incoming`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: c2.id,
      secret: "wrong",
      content: "bad",
    }),
  });
  expect(res.status).toBe(403);
});

test("subscribe receives channel messages", async () => {
  const sub = await fetch(`${base}/subscribe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${c2.token}`,
    },
    body: JSON.stringify({ channel: "news/general" }),
  });
  expect(sub.status).toBe(200);
  const pub = await fetch(`${base}/publish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${c1.token}`,
    },
    body: JSON.stringify({ channel: "news/general", content: "update" }),
  });
  expect(pub.status).toBe(200);
  const pollRes = await fetch(`${base}/poll`, {
    headers: { Authorization: `Bearer ${c2.token}` },
  });
  const messages = await pollRes.json();
  expect(messages.some((m: any) => m.content === "update")).toBe(true);
});
