// bun-messages.ts
import { serve } from "bun";
import { Database } from "bun:sqlite";
import jwt from "jsonwebtoken";

// ---------- DB ----------
const db = new Database("messages.db", { create: true });
db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`
CREATE TABLE IF NOT EXISTS clients (
  id       TEXT PRIMARY KEY,
  secret   TEXT,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS subscriptions (
  client_id   TEXT,
  channel     TEXT,
  last_polled INTEGER,
  PRIMARY KEY (client_id, channel)
);
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  channel    TEXT,
  sender_id  TEXT,
  content    TEXT,
  timestamp  INTEGER,
  parent_id  TEXT
);
`);
// upgrade from earlier schema without last_polled
try {
  db.exec("ALTER TABLE subscriptions ADD COLUMN last_polled INTEGER");
} catch {}

const JWT_SECRET = process.env.JWT_SECRET ?? "dev‑secret";

// ---------- helpers ----------
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const issueToken = (id: string) => jwt.sign({ id }, JWT_SECRET);

function verify(req: Request): string {
  const h = req.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  try {
    const { id } = jwt.verify(token, JWT_SECRET) as { id: string };
    return id;
  } catch {
    throw new Error("invalid auth");
  }
}

// ---------- server ----------
serve({
  port: 3000,

  routes: {
    // -------- REGISTER --------
    "/register": {
      POST: () => {
        const id = crypto.randomUUID();
        const secret = crypto.randomUUID();
        db.run(
          "INSERT INTO clients (id, secret, last_seen) VALUES (?,?,?)",
          [id, secret, Date.now()],
        );
        return json({ id, secret, token: issueToken(id) }, 201);
      },
    },

    // -------- PUBLISH ---------
    "/publish": {
      POST: async req => {
        const sender = verify(req);
        const { channel, content, parent_id } = await req.json();
        // if channel looks like a client‑ID, verify it exists
        if (!channel.includes("/")) {
          const ok = db
            .query("SELECT 1 FROM clients WHERE id=?")
            .get(channel) as unknown;
          if (!ok) return json({ error: "recipient not found" }, 404);
        }
        const id = crypto.randomUUID();
        db.run(
          `INSERT INTO messages (id,channel,sender_id,content,timestamp,parent_id)
           VALUES (?,?,?,?,?,?)`,
          [id, channel, sender, content, Date.now(), parent_id ?? null],
        );
        const deliveredTo = channel.includes("/")
          ? (db.query(
              "SELECT COUNT(*) AS c FROM subscriptions WHERE channel=?",
            ).get(channel) as { c: number }).c
          : 1;
        return json({ id, deliveredTo });
      },
    },

    // -------- SUBSCRIBE -------
    "/subscribe": {
      POST: async req => {
        const client = verify(req);
        const { channel } = await req.json();
        db.run(
          "INSERT OR IGNORE INTO subscriptions (client_id, channel, last_polled) VALUES (?,?,?)",
          [client, channel, Date.now()],
        );
        return json({ ok: true });
      },
    },

    // -------- POLL ------------
    "/poll": {
      GET: req => {
        const client = verify(req);
        const since =
          Number(new URL(req.url).searchParams.get("since") ?? 0) || 0;
        const rows = db
          .query(
            `SELECT * FROM messages m
             WHERE m.timestamp > ?
               AND (m.channel = ?
                    OR m.channel IN (SELECT channel
                                     FROM subscriptions
                                     WHERE client_id = ?))`,
          )
          .all(since, client, client);
        const now = Date.now();
        db.run("UPDATE clients SET last_seen=? WHERE id=?", [now, client]);
        db.run("UPDATE subscriptions SET last_polled=? WHERE client_id=?", [now, client]);
        return json(rows);
      },
    },

    // -------- fallback  -------
    "/*": () => json({ error: "not found" }, 404),
  },

  // Global error handler
  error(error) {
    console.error(error);
    return json({ error: "Internal Server Error" }, 500)
  },
});

