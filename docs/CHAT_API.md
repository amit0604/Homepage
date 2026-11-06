# Chat API

Bring groups and chats from your other chat platforms into this app. Messages from there appear in the chat, and messages your users write here are sent back.

The same guide is in the app under **Admin → Integrations → How to use the API**. Connecting an app and sending the API key work the same way as in the [Requests API](REQUESTS_API.md).

## How it works

```
Other platform  --  POST messages  -->  This app's chat
Other platform  <--  webhook, or collect from outbox  --  Messages written here
```

Your connector, a small service or bot, sits between the two platforms and calls this API.

## 1. Create the conversation

```bash
curl -X POST https://your-host/api/v1/chat/conversations \
  -H "X-API-Key: sc_your_key" \
  -H "Content-Type: application/json" \
  -d '{
    "externalId": "team-servers",
    "title": "Servers team",
    "kind": "group",
    "members": ["admin", "jsmith"]
  }'
```

| Field | Required | Notes |
|---|---|---|
| `externalId` | Yes | The conversation's ID on your platform |
| `title` | To create | Up to 200 characters |
| `members` | To create | Usernames here. Only these people see the conversation |
| `kind` | No | `group` (default) or `direct` |

Sending the same `externalId` again updates the conversation. A new `members` list replaces the old one. The response includes the `id` used in the next steps.

## 2. Send messages from your platform

```bash
curl -X POST https://your-host/api/v1/chat/conversations/CONVERSATION_ID/messages \
  -H "X-API-Key: sc_your_key" \
  -H "Content-Type: application/json" \
  -d '{
    "externalId": "msg-5521",
    "text": "The switch is back online.",
    "from": { "id": "dana", "displayName": "Dana Levi" }
  }'
```

| Field | Required | Notes |
|---|---|---|
| `from` | Yes | The author, with an `id`, a `displayName` or both. Shown with your app's name, never as a local user |
| `text` | Text or attachments | Up to 16,000 characters |
| `attachments` | Text or attachments | Up to 5, each with a `url` (`http` or `https`) and a `name`. Shown as links |
| `externalId` | No | The message's ID on your platform. Sending it again is ignored, so retries are safe |
| `replyToExternalId` | No | The message this one replies to |

Returns `201` when created and `200` when that `externalId` was already received. These messages are never sent back to your platform, which prevents loops.

## 3. Receive messages written here

Choose one of two ways.

### Webhook

Open **Admin → Integrations**, select **Webhook** on the app's row and enter your URL. Copy the secret when it appears, because it is shown only once. Use **Send test** to check it.

Your webhook receives each message as a POST:

```json
{
  "id": "EVENT_ID",
  "type": "chat.message",
  "createdAt": "2026-11-06T10:15:00.000Z",
  "conversation": { "id": "CONVERSATION_ID", "externalId": "team-servers", "title": "Servers team" },
  "message": {
    "id": "MESSAGE_ID",
    "text": "Thanks, I will check it.",
    "from": { "username": "jsmith", "displayName": "Jo Smith" },
    "attachments": [],
    "replyTo": null
  }
}
```

Attachment links start with `/api/uploads/`, so add your host to the front. The test event has `"type": "test"`, so ignore any event that isn't `chat.message`.

Reply with any 2xx status within 10 seconds. You can also reply with `{ "externalId": "msg-5522" }`, giving the message's ID on your platform. If your platform then sends that message back here, it is recognized and not shown twice.

Failed deliveries are retried for about two hours, then marked as failed. **Retry** on the app's row sends them again. Messages in a conversation stay in order, and redirects count as failures.

Check the signature to make sure a call really came from this app:

```js
// Node.js. Use the raw request body, before it is parsed.
const crypto = require('crypto');
const expected = 'sha256=' + crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(req.headers['x-timestamp'] + '.' + rawBody)
  .digest('hex');
const given = req.headers['x-signature'];
const valid = given.length === expected.length
  && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
```

To help block replayed calls, also reject old `X-Timestamp` values (seconds since 1970) and events whose `X-Event-Id` you have already processed.

### Collect from the outbox

If your connector can't receive calls, it can collect messages instead. This needs no webhook on the app.

```bash
curl https://your-host/api/v1/chat/outbox -H "X-API-Key: sc_your_key"
```

Returns `{ "total": 1, "events": [ ... ] }`, oldest first, in the format above. Confirm each one once it is on your platform. Until then it stays in the outbox:

```bash
curl -X POST https://your-host/api/v1/chat/outbox/EVENT_ID/ack \
  -H "X-API-Key: sc_your_key" \
  -H "Content-Type: application/json" \
  -d '{ "externalId": "msg-5522" }'
```

To report that a message couldn't be delivered, send `{ "error": "reason" }` instead. Messages not collected within 7 days are marked as failed.

## Delivery status

Anyone writing in a connected conversation sees **Sending**, **Delivered** or **Not delivered** on their message.

## Other calls

| Call | What it does |
|---|---|
| `GET /api/v1/chat/conversations` | Lists your conversations. Filter: `externalId` |
| `GET /api/v1/chat/conversations/:id` | Gets one conversation |
| `GET /api/v1/chat/conversations/:id/messages` | Lists messages from both sides, oldest first. Filters: `since`, `limit` (default 100, maximum 400) |
| `DELETE /api/v1/chat/conversations/:id/messages/:messageId` | Deletes a message that came from your platform |

## Good to know

- **Access:** a platform can only see and post to the conversations it created. Messages from there never appear as a local user.
- **Not synced:** reactions, pins and messages deleted here are not sent to the other platform.
- **Retention:** connected conversations follow the app's chat retention setting.
- **Limits:** 1,200 calls a minute for each key.
