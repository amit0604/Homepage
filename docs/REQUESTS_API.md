# Requests API

Connect your other support apps so their requests appear in one place, in **Admin → All requests**.
Each request shows which app it came from and links back to the original.

The same guide is in the app under **Admin → Integrations → How to use the API**. To connect a chat platform, see the [Chat API](CHAT_API.md).

## Connect an app

1. Sign in as an admin and open **Admin → Integrations**.
2. Enter the app's name and select **Create key**.
3. Copy the key straight away. It is shown only once. Only a hash of it is stored.

Send the key with every call, using either header:

```
X-API-Key: sc_your_key
Authorization: Bearer sc_your_key
```

An app can only read and change the requests it created. Revoking a key cuts that app off immediately. Its existing requests stay in the list.

## Check the connection

```bash
curl https://your-host/api/v1/whoami -H "X-API-Key: sc_your_key"
```

## Endpoints

The base path is `/api/v1`. All bodies and responses are JSON.

| Method and path | What it does |
|---|---|
| `GET /whoami` | Shows which app the key belongs to |
| `POST /requests` | Creates a request, or updates it if the `externalId` already exists |
| `GET /requests` | Lists this app's requests, newest first |
| `GET /requests/:id` | Gets one request |
| `PATCH /requests/:id` | Changes the fields you send |
| `POST /requests/:id/comments` | Adds a comment |

### Create or sync a request

```bash
curl -X POST https://your-host/api/v1/requests \
  -H "X-API-Key: sc_your_key" \
  -H "Content-Type: application/json" \
  -d '{
    "externalId": "HD-1042",
    "externalUrl": "https://helpdesk.example.com/tickets/1042",
    "title": "Printer on floor 3 is offline",
    "description": "Stopped responding after the power outage.",
    "createdBy": "jsmith",
    "status": "pending"
  }'
```

| Field | Required | Notes |
|---|---|---|
| `title` | To create | Up to 200 characters |
| `description` | To create | Up to 20,000 characters |
| `createdBy` | To create | Username of the requester. If it matches a user here, the request also appears in their **My Requests** |
| `externalId` | No | The ID in your app. Send it so that retries and later syncs update the same request instead of creating a copy |
| `externalUrl` | No | Link to the original. Must be `http` or `https` |
| `status` | No | `pending` (default), `in progress` or `closed` |
| `assignedTo` | No | Username of the assignee |
| `department` | No | Department name |
| `phoneNumber` | No | Requester's phone number |

Returns `201` when created and `200` when an existing `externalId` was updated.

### List requests

```bash
curl "https://your-host/api/v1/requests?status=pending&limit=50" -H "X-API-Key: sc_your_key"
```

| Query parameter | Notes |
|---|---|
| `status` | `pending`, `in progress` or `closed` |
| `externalId` | Finds the request with this ID in your app |
| `updatedSince` | ISO 8601 date, for picking up changes made here since your last sync |
| `limit` | Default 100, maximum 500 |
| `offset` | Number of results to skip |

Returns `{ "total": 1, "limit": 50, "offset": 0, "requests": [ ... ] }`.

### Add a comment

```bash
curl -X POST https://your-host/api/v1/requests/REQUEST_ID/comments \
  -H "X-API-Key: sc_your_key" \
  -H "Content-Type: application/json" \
  -d '{ "text": "Technician is on the way.", "author": "jsmith" }'
```

`text` is required. `author` is optional and defaults to the app's name.

### Request format

```json
{
  "id": "e188d9bc-ae56-442d-9840-1693417f0404",
  "source": "helpdesk",
  "externalId": "HD-1042",
  "externalUrl": "https://helpdesk.example.com/tickets/1042",
  "title": "Printer on floor 3 is offline",
  "description": "Stopped responding after the power outage.",
  "status": "pending",
  "createdBy": "jsmith",
  "assignedTo": null,
  "department": null,
  "phoneNumber": null,
  "comments": [],
  "createdAt": "2026-11-06T10:15:00.000Z",
  "updatedAt": "2026-11-06T10:15:00.000Z",
  "closedAt": null
}
```

## Errors

Errors return `{ "error": "message" }`.

| Status | Meaning |
|---|---|
| `400` | A field is missing or not valid |
| `401` | The API key is missing, wrong or revoked |
| `404` | The request does not exist or belongs to another app |
| `429` | Too many calls. The limit is 1,200 per minute per key |

## Good to know

- **Sync direction:** apps send data here. This app does not call them back, so to pick up changes made here, poll `GET /requests` with `updatedSince`.
- **HTTPS:** use HTTPS in production, because the key travels in a header on every call.
