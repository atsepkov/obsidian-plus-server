# obsidian-plus-server

Simple message relay built on [Bun](https://bun.sh). Clients register to
receive a JWT, publish messages to channels or other clients, subscribe to
channels, and poll for new messages.

## Setup

Install dependencies and start the server (default port: `3000`).

```bash
bun install
bun run index.ts
```

Set `JWT_SECRET` in the environment for production deployments.

All endpoints except `/register` require an `Authorization: Bearer <token>`
header where `<token>` is issued by the register endpoint.

## Messaging model

- **Clients** have a unique ID issued at registration. Direct messages use the
  recipient's ID as the `channel` field.
- **Channels** are arbitrary strings containing `/` (e.g. `news/alerts`). Any
  client may publish to or subscribe to a channel name. Share an obscure name
  to keep a channel private; well-known names behave like public rooms.
- **parent_id** references the message you're replying to, enabling threaded
  conversations.

### Common scenarios

- **Private conversation:** client A publishes directly to client B's ID and B
  polls for new messages—no subscription is required. B replies by publishing
  to A's ID.

  ```bash
  curl -X POST http://localhost:3000/publish \
    -H "Authorization: Bearer $TOKEN_A" \
    -d '{"channel":"B_ID","content":"hi"}'
  ```

  Direct messages always use the recipient's ID as the `channel`. If client C
  also sends a private message to B, it goes to the same channel (`B_ID`), and
  B distinguishes senders via the `sender_id` field. Only the target client can
  poll its own ID, so A cannot read C's messages to B and vice versa.

- **Private channel:** client A selects a unique channel such as
  `team/secret123`; invited clients subscribe to that name before messages are
  published.

  ```bash
  # Client B subscribes
  curl -X POST http://localhost:3000/subscribe \
    -H "Authorization: Bearer $TOKEN_B" \
    -d '{"channel":"team/secret123"}'
  ```

- **Public channel:** any client may subscribe to a common channel like
  `public/general` and publish freely.

  ```bash
  curl -X POST http://localhost:3000/subscribe \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"channel":"public/general"}'
  ```

- **Unsubscribing:** there is currently no dedicated endpoint; clients simply
  stop polling or ignore a channel to leave it. The server records `last_seen`
  for each client and `last_polled` per subscription on every `/poll`, enabling
  pruning of stale clients or channel memberships.

## API

### `POST /register`
Registers a new client and returns credentials.

**Response**

```json
{
  "id": "CLIENT_ID",
  "secret": "CLIENT_SECRET",
  "token": "JWT"
}
```

**Example**

```bash
curl -X POST http://localhost:3000/register
```

No request body is required. The returned token must be supplied in the
`Authorization` header for subsequent requests.

The official Obsidian Plus client ships with a prepackaged `secret` to prevent
rogue registrations. To participate in the shared Flow.bz network that powers
Obsidian Plus, register your client with [flow.bz](https://flow.bz) so the
issued credentials can be embedded in your build.

### `POST /publish`
Sends a message to a channel or directly to another client.

**Request body**

```json
{
  "channel": "CHANNEL_OR_CLIENT_ID",
  "content": "Message text",
  "parent_id": "OPTIONAL_PARENT_MESSAGE_ID"
}
```

**Response**

```json
{
  "id": "MESSAGE_ID",
  "deliveredTo": 3
}
```

**Example**

```bash
curl -X POST http://localhost:3000/publish \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel":"news/alerts","content":"hi"}'
```

`parent_id` identifies the message being replied to, allowing clients to build
conversation threads.

**Notes**

- If `channel` does not contain `/`, it is treated as a direct message to a
  client ID. The server returns `404` if the client does not exist.
- `deliveredTo` is the number of subscribed clients for channel broadcasts; for
  direct messages it is always `1`.

**Edge cases**

- Broadcasting to a channel with no subscribers still stores the message and
  returns `deliveredTo: 0`. A client subscribing later and polling with the
  default `since` will receive the backlog.

### `POST /subscribe`
Subscribes the authenticated client to a channel.

**Request body**

```json
{
  "channel": "CHANNEL_NAME"
}
```

**Response**

```json
{ "ok": true }
```

**Example**

```bash
curl -X POST http://localhost:3000/subscribe \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel":"news/alerts"}'
```

**Notes**

- Re-subscribing to the same channel is ignored (no error is thrown).
- The server tracks when each subscription last polled so stale subscribers can
  be detected.

### `GET /poll?since=<timestamp>`
Retrieves messages for the authenticated client.

`since` is a UNIX timestamp in milliseconds. If omitted or invalid, all messages
are returned.

**Response**

```json
[
  {
    "id": "MESSAGE_ID",
    "channel": "CHANNEL",
    "sender_id": "CLIENT_ID",
    "content": "Message text",
    "timestamp": 1700000000000,
    "parent_id": null
  }
]
```

**Example**

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/poll?since=$(date +%s000)"
```

**Notes**

- Only messages sent to the client's own ID or to channels the client has
  subscribed to are returned.
- `since` defaults to `0` when missing or not a number. Supplying a more recent
  timestamp lets clients fetch only new messages.
- A client that subscribes after messages were sent can still retrieve the
  backlog by omitting `since` or using an earlier timestamp.
- Each poll updates the client's `last_seen` and the `last_polled` time for all
  of its subscriptions.

### Errors

- Unknown paths return `{ "error": "not found" }` with a `404` status.
- Invalid or missing authentication results in a server error (`500`).
