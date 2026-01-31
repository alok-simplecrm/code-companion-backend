# Code Companion Backend

A backend service for syncing and analyzing GitHub Pull Requests with AI-powered insights.

## Features

- **GitHub PR Sync**: Automatically sync PRs from GitHub repositories
- **Webhook Support**: Real-time updates when PRs are opened, closed, or merged
- **Smart Sync**: Only syncs new or updated PRs (compares timestamps)
- **AI Analysis**: Generate embeddings for semantic search across PRs and commits
- **Real-time Status**: SSE (Server-Sent Events) for live sync progress updates

## Environment Variables

Create a `.env` file with the following:

```env
# MongoDB
MONGO_URI=mongodb+srv://...

# GitHub
GITHUB_TOKEN=ghp_...
GITHUB_WEBHOOK_SECRET=your-webhook-secret

# OpenAI (for embeddings)
OPENAI_API_KEY=sk-...

# Server
PORT=3001
NODE_ENV=development
```

## API Endpoints

### GitHub Routes

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/github/webhook` | GitHub webhook receiver |
| POST | `/api/github/sync/prs` | Start background PR sync |
| GET | `/api/github/sync/status/:jobId` | Get sync job status |
| GET | `/api/github/sync/jobs` | List recent sync jobs |
| GET | `/api/github/sync/stream/:jobId` | SSE stream for real-time sync updates |
| POST | `/api/github/trigger-webhook` | Manually trigger webhook for a PR |
| POST | `/api/github/ingest` | Manually ingest PR/commit data |

### Repos Routes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/repos` | List allowed repositories |
| POST | `/api/repos` | Add a repository |
| DELETE | `/api/repos/:id` | Remove a repository |
| PATCH | `/api/repos/:id/sync` | Update repo sync status |

## GitHub Webhook Setup

To receive real-time updates when PRs are opened, closed, or merged:

### 1. Go to GitHub Repository Settings

Navigate to: `Repository` → `Settings` → `Webhooks` → `Add webhook`

### 2. Configure Webhook

| Field | Value |
|-------|-------|
| **Payload URL** | `https://YOUR_DEPLOYED_URL/api/github/webhook` |
| **Content type** | `application/json` |
| **Secret** | Same value as `GITHUB_WEBHOOK_SECRET` in your env |
| **SSL verification** | Enable (recommended) |

### 3. Select Events

Choose **"Let me select individual events"** and select:
- ✅ **Pull requests** - PR open/close/merge/edit events
- ✅ **Pushes** - Commit push events

### 4. Activate

Ensure **"Active"** is checked and click **"Add webhook"**

## Running Locally

```bash
# Install dependencies
npm install

# Development mode (with hot reload)
npm run dev

# Production build
npm run build
npm start
```

## Deployment (Google Cloud Run)

The project includes a `cloudbuild.yaml` for automatic deployment via Cloud Build:

```bash
# Trigger build manually
gcloud builds submit --config=cloudbuild.yaml
```

## Sync Behavior

When syncing PRs, the system:

1. **Checks if PR exists** in the database
2. **Compares timestamps** (`updated_at` from GitHub vs `updatedAt` in DB)
3. **Checks merge status** (detects newly merged PRs)
4. **Updates or inserts** based on comparison

Results show:
- `processed`: New PRs synced
- `updated`: Existing PRs that were modified and re-synced
- `skipped`: PRs that are already synced and up-to-date

## License

MIT
