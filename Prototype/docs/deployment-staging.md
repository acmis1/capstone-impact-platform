# Staging Deployment Guide (Admin/CMS Prototype)

This guide explains how to deploy the Admin/CMS prototype to a temporary staging environment (e.g., Render, Railway, or a private Node.js server) for stakeholder review.

> [!IMPORTANT]
> **Persistence**: The Admin/CMS now uses **Supabase Database** as the source of truth. Render Free Tier can be used reliably because project records are persisted in the cloud database, not on the local ephemeral disk.

## Recommended Hosting
- **Render** (Web Service - Free Tier is OK)
- **Railway** (Service)

## Deployment Steps

### 1. Supabase Database Setup
In the recovered project, the database already contains the required table structure, RLS policies, and seeded records. You do not need to rerun SQL scripts on a recovered project. 

For a clean rebuild only, the table is created using the following SQL:

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.projects (
    id BIGINT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.projects FROM anon;
REVOKE ALL ON TABLE public.projects FROM authenticated;

GRANT ALL ON TABLE public.projects TO service_role;

COMMIT;
```

Duda reads the public Storage JSON feed;
Duda does not query public.projects;
SUPABASE_SECRET_KEY remains backend-only.

### 2. Configure Environment Variables
Set the following variables in your hosting provider's dashboard:

| Variable | Description |
| :--- | :--- |
| `PORT` | The port the server runs on (defaults to 5000). |
| `SUPABASE_URL` | Your Supabase project URL (`https://<ref>.supabase.co`). |
| `SUPABASE_SECRET_KEY` | **SECRET** service role/secret key (Backend only, never expose in Duda or browser). *Note: `SUPABASE_SERVICE_ROLE_KEY` is supported as a legacy fallback only.* |
| `SUPABASE_EXPECTED_PROJECT_REF` | The exact generated project reference subdomain (e.g. `xyzabc`). Do not use the human-readable project name. |
| `SUPABASE_FEED_BUCKET` | The public Storage bucket for the public feed (must be `feeds`). |
| `SUPABASE_FEED_FILE` | The filename of the published feed (must be `capstones-latest.json`). |
| `SUPABASE_ASSET_BUCKET` | The public Storage bucket for project images (must be `project-assets`). |
| `ADMIN_ACCESS_KEY` | (Optional) A secret string required to Save/Publish changes. |

### 3. Build and Start
Run the following command in your CI/CD pipeline or start command:
```bash
npm install
npm run build
npm run server
```

## How Persistence Works
1. **Source of Truth**: All Admin/CMS edits are saved directly to the Supabase `projects` table.
2. **Initial Seeding**: On the very first startup, if the database table is empty, the server will automatically seed it from the local `data/db.json` file.
3. **Restarts**: When the server restarts (e.g., Render Free sleep or redeploy), it fetches the latest records from the database. No manual "Restore" is required.
4. **Public Feed**: The local preview feed updates automatically after approved project records are saved. The official external test showcase (stable URL) is synchronized to this updated preview only when you click **Publish to Duda**.

## Access Protection
If `ADMIN_ACCESS_KEY` is configured:
1. Open the Admin UI.
2. In the **Sidebar**, locate the **STAGING ACCESS KEY** field at the bottom.
3. Enter the configured key. This is saved in your browser's `localStorage`.
4. If the key is missing or incorrect, "Save" and "Publish" actions will return a `401 Unauthorized` error.

## Verification Checklist
1. **Load CMS**: Visit your deployment URL. The Dashboard should load and show project counts.
2. **Read Test**: Navigate to "Projects". You should see the current list.
3. **Write Test**: Edit a project and click "Save & Update Record".
4. **Persistence Test**: Restart the server (or trigger a redeploy). Verify the edited project still has your changes.
5. **Publish Test**: Click "Publish to Duda" on the Dashboard.
6. **Verify Cloud**: Check the public Supabase Storage URL (`https://<GENERATED_PROJECT_REFERENCE>.supabase.co/storage/v1/object/public/feeds/capstones-latest.json`) to verify the file was updated.

## Demo Readiness
For the full stakeholder demo script and final validation checklist, see **[Demo Readiness](./demo-readiness.md)**.
