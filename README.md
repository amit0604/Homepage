# Support Center

Internal support portal: **tickets**, **admin dashboard**, optional **lobby chat**, **Pinger** host checks, and optional **Checkmk** down-hosts view. React frontend and Node/Express backend share one Docker image (builds the SPA, then serves it from Express).

## Quick start (Docker)

```bash
docker compose up --build
```

Open **http://localhost:8080** (or the host port from `HOST_PORT`). Data persists in the `support-center-data` volume under `/app/data` in the container.

Copy `backend/.env.example` to `backend/.env` and adjust for local runs outside Docker (`DATA_DIR`, `JWT_SECRET`, LDAP, etc.).

## Local development

- **Backend** (from `backend/`): `npm install` then `node app.js` (or your process manager). Serves API and, by default, the built frontend from `frontend/build`.
- **Frontend** (from `frontend/`): `npm install` then `npm start` for the CRA dev server; set `REACT_APP` / proxy if you point API calls at a separate backend.

Production build of the UI:

```bash
cd frontend && npm run build
```

`CI=true` is set in the Docker frontend build so ESLint warnings fail the build—fix lint before shipping.

## Configuration highlights

| Area | Notes |
|------|--------|
| Auth | LDAP and/or local admin; JWT in `localStorage`. |
| Email-style logins | `USER_EMAIL_DOMAIN` appends to bare usernames when configured. |
| Chat | `LOBBY_CHAT_UI=false` hides lobby chat regardless of DB setting. |
| Checkmk | Optional; `CHECKMK_UI=false` hides tab and API. |
| Data | JSON store under `DATA_DIR` (tickets, settings, chat, etc.). |

See **`backend/.env.example`** for variables and comments.

## Project layout

```
backend/     Express API, LDAP, chat, pinger, ticket routes
frontend/    React app (Create React App)
helm/        Kubernetes chart (example values)
docker-compose.yml
Dockerfile     Multi-stage: build frontend → run backend + static build
```

## License / support

Use and deployment are governed by your organization’s policies. For deep topics (CSV import, LDAP assignee resolution, retention), extend this file or add docs under `docs/` as needed.
