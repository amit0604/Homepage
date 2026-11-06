import React, { useState } from 'react';

function CodeBlock({ code }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <div className="api-guide__code-wrap">
      {navigator.clipboard ? (
        <button type="button" className="api-guide__copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      ) : null}
      <pre className="api-guide__code" dir="ltr">{code}</pre>
    </div>
  );
}

function FieldTable({ head, rows }) {
  return (
    <div className="api-guide__table-wrap">
      <table className="api-guide__table">
        <thead>
          <tr>
            {head.map((h) => <th key={h}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]}>
              {row.map((cell, i) => (
                <td key={`${row[0]}-${i}`}>{i === 0 ? <code>{cell}</code> : cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Start({ origin }) {
  return (
    <>
      <p className="api-guide__lead">
        Connect your other support and chat apps, so their requests and conversations appear here.
      </p>
      <ol className="api-guide__steps">
        <li>
          <strong>Create a key.</strong> Under Connected apps, enter the app&apos;s name and select Create key.
          Copy the key straight away, because it is shown only once.
        </li>
        <li>
          <strong>Test the connection.</strong> Run the command below with your key. It should return the app&apos;s name.
        </li>
        <li>
          <strong>Choose what to connect.</strong> See the Requests and Chat tabs for what to send.
        </li>
      </ol>
      <CodeBlock code={`curl ${origin}/api/v1/whoami -H "X-API-Key: YOUR_KEY"`} />
      <h4 className="api-guide__h">Sending your key</h4>
      <p>
        Send the key with every call, in an <code>X-API-Key</code> header or as <code>Authorization: Bearer YOUR_KEY</code>.
        Keep it on your server and never put it in a web page. Use HTTPS in production.
      </p>
      <h4 className="api-guide__h">What each app can do</h4>
      <p>
        An app can only see and change the requests and conversations it created. Revoking its key cuts it off immediately,
        and its existing data stays here.
      </p>
      <h4 className="api-guide__h">Errors</h4>
      <FieldTable
        head={['Status', 'Meaning']}
        rows={[
          ['400', 'A field is missing or not valid. The response explains which one.'],
          ['401', 'The key is missing, wrong or revoked.'],
          ['403', 'Not allowed, for example chat is turned off in this app.'],
          ['404', 'It does not exist, or it belongs to another app.'],
          ['409', 'Conflict, for example collecting messages when the app has a webhook.'],
          ['429', 'Too many calls. The limit is 1,200 a minute for each key.'],
        ]}
      />
    </>
  );
}

function Requests({ origin }) {
  return (
    <>
      <p className="api-guide__lead">
        Requests you send appear under All requests, with the app&apos;s name and a link back to the original.
      </p>
      <h4 className="api-guide__h">Create or update a request</h4>
      <p>Sending the same <code>externalId</code> again updates that request instead of creating a copy, so retries are safe.</p>
      <CodeBlock
        code={`curl -X POST ${origin}/api/v1/requests \\
  -H "X-API-Key: YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "externalId": "HD-1042",
    "externalUrl": "https://helpdesk.example.com/tickets/1042",
    "title": "Printer on floor 3 is offline",
    "description": "Stopped responding after the power outage.",
    "createdBy": "jsmith"
  }'`}
      />
      <FieldTable
        head={['Field', 'Required', 'Notes']}
        rows={[
          ['title', 'To create', 'Up to 200 characters'],
          ['description', 'To create', 'Up to 20,000 characters'],
          ['createdBy', 'To create', 'Requester\'s username. If it matches a user here, it also appears in their My Requests'],
          ['externalId', 'No', 'The ID in your app. Send it to avoid duplicates'],
          ['externalUrl', 'No', 'Link to the original. Must be http or https'],
          ['status', 'No', 'pending (default), in progress or closed'],
          ['assignedTo', 'No', 'Assignee\'s username'],
          ['department', 'No', 'Department name'],
          ['phoneNumber', 'No', 'Requester\'s phone number'],
        ]}
      />
      <h4 className="api-guide__h">Other calls</h4>
      <FieldTable
        head={['Call', 'What it does']}
        rows={[
          ['GET /api/v1/requests', 'Lists your requests. Filters: status, externalId, updatedSince, limit, offset'],
          ['GET /api/v1/requests/:id', 'Gets one request'],
          ['PATCH /api/v1/requests/:id', 'Changes the fields you send'],
          ['POST /api/v1/requests/:id/comments', 'Adds a comment. Send text, and optionally author'],
        ]}
      />
      <h4 className="api-guide__h">Picking up changes made here</h4>
      <p>This app does not call yours back about requests. Check regularly for changes since your last sync:</p>
      <CodeBlock code={`curl "${origin}/api/v1/requests?updatedSince=2026-11-06T10:00:00Z" -H "X-API-Key: YOUR_KEY"`} />
    </>
  );
}

function Chat({ origin }) {
  return (
    <>
      <p className="api-guide__lead">
        Bring groups and chats from other platforms in here. Messages from there appear in the chat, and
        messages your users write here are sent back.
      </p>
      <h4 className="api-guide__h">1. Create the conversation</h4>
      <p>
        <code>members</code> lists the usernames here who should see it. Sending the same <code>externalId</code> again
        updates it, and a new <code>members</code> list replaces the old one.
      </p>
      <CodeBlock
        code={`curl -X POST ${origin}/api/v1/chat/conversations \\
  -H "X-API-Key: YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "externalId": "team-servers",
    "title": "Servers team",
    "kind": "group",
    "members": ["admin", "jsmith"]
  }'`}
      />
      <FieldTable
        head={['Field', 'Required', 'Notes']}
        rows={[
          ['externalId', 'Yes', 'The conversation\'s ID on your platform'],
          ['title', 'To create', 'Up to 200 characters'],
          ['members', 'To create', 'Usernames here. Only these people see the conversation'],
          ['kind', 'No', 'group (default) or direct'],
        ]}
      />
      <h4 className="api-guide__h">2. Send messages from your platform</h4>
      <p>Use the <code>id</code> returned in step 1. Sending the same message <code>externalId</code> again is ignored, so retries are safe.</p>
      <CodeBlock
        code={`curl -X POST ${origin}/api/v1/chat/conversations/CONVERSATION_ID/messages \\
  -H "X-API-Key: YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "externalId": "msg-5521",
    "text": "The switch is back online.",
    "from": { "id": "dana", "displayName": "Dana Levi" }
  }'`}
      />
      <FieldTable
        head={['Field', 'Required', 'Notes']}
        rows={[
          ['from', 'Yes', 'The author, with an id, a displayName or both. Shown with your app\'s name, never as a local user'],
          ['text', 'Text or attachments', 'Up to 16,000 characters'],
          ['attachments', 'Text or attachments', 'Up to 5, each with a url (http or https) and a name. Shown as links'],
          ['externalId', 'No', 'The message\'s ID on your platform. Send it to avoid duplicates'],
          ['replyToExternalId', 'No', 'The message this one replies to'],
        ]}
      />
      <h4 className="api-guide__h">3. Receive messages written here</h4>
      <p>
        Choose one of two ways. A <strong>webhook</strong> delivers messages straight away, and you set it up with the
        Webhook button on the app&apos;s row. Otherwise, your app can <strong>collect</strong> them:
      </p>
      <CodeBlock
        code={`# Collect waiting messages
curl ${origin}/api/v1/chat/outbox -H "X-API-Key: YOUR_KEY"

# Confirm each one once it is on your platform
curl -X POST ${origin}/api/v1/chat/outbox/EVENT_ID/ack \\
  -H "X-API-Key: YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "externalId": "msg-5522" }'`}
      />
      <p>
        Include the new message&apos;s ID as <code>externalId</code> when you confirm. If your platform then sends that message
        back to this app, it is recognized and not shown twice.
      </p>
      <h4 className="api-guide__h">What your app receives</h4>
      <CodeBlock
        code={`{
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
}`}
      />
      <p>
        Attachment links start with <code>/api/uploads/</code>, so add <code>{origin}</code> to the front.
      </p>
      <h4 className="api-guide__h">Using a webhook</h4>
      <p>
        Your webhook receives the JSON above as a POST. Reply with any 2xx status within 10 seconds, and optionally
        with <code>{'{ "externalId": "msg-5522" }'}</code>. Failed deliveries are retried for about two hours, and messages
        in a conversation stay in order. Anyone writing here sees whether their message was delivered.
      </p>
      <p>Check the signature to make sure a call really came from this app:</p>
      <CodeBlock
        code={`// Node.js. Use the raw request body, before it is parsed.
const crypto = require('crypto');
const expected = 'sha256=' + crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(req.headers['x-timestamp'] + '.' + rawBody)
  .digest('hex');
const given = req.headers['x-signature'];
const valid = given.length === expected.length
  && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));`}
      />
      <h4 className="api-guide__h">Other calls</h4>
      <FieldTable
        head={['Call', 'What it does']}
        rows={[
          ['GET /api/v1/chat/conversations', 'Lists your conversations. Filter: externalId'],
          ['GET /api/v1/chat/conversations/:id', 'Gets one conversation'],
          ['GET /api/v1/chat/conversations/:id/messages', 'Lists messages from both sides. Filters: since, limit'],
          ['DELETE /api/v1/chat/conversations/:id/messages/:messageId', 'Deletes a message that came from your platform'],
        ]}
      />
      <h4 className="api-guide__h">Not synced</h4>
      <p>Reactions, pins and messages deleted here are not sent to the other platform.</p>
    </>
  );
}

const TABS = [
  ['start', 'Getting started', Start],
  ['requests', 'Requests', Requests],
  ['chat', 'Chat', Chat],
];

/** How to use the API, for admins connecting other apps. */
function ApiGuide() {
  const [tab, setTab] = useState('start');
  const origin = window.location.origin;
  const Active = TABS.find(([id]) => id === tab)[2];

  return (
    <div className="card admin-surface api-guide">
      <div className="card-header admin-card-header">
        <h3 className="title admin-card-title">How to use the API</h3>
      </div>
      <div className="api-guide__tabs" role="tablist" aria-label="API guide sections">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`api-guide__tab${tab === id ? ' api-guide__tab--active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="card-body api-guide__body" role="tabpanel">
        <Active origin={origin} />
      </div>
    </div>
  );
}

export default ApiGuide;
