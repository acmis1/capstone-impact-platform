# Staging Deployment Guide (Admin/CMS Prototype)

This guide explains how to deploy the Admin/CMS prototype to a temporary staging environment (e.g., Render, Railway, or a private Node.js server) for stakeholder review.

> [!IMPORTANT]
> **Persistence**: The Admin/CMS now uses **Supabase Database** as the source of truth. Render Free Tier can be used reliably because project records are persisted in the cloud database, not on the local ephemeral disk.

## Recommended Hosting
- **Render** (Web Service - Free Tier is OK)
- **Railway** (Service)

## Deployment Steps

### 1. Supabase Database Setup
Before deploying, you must create the required table in your Supabase project.

1. Go to your **Supabase Dashboard** -> **SQL Editor**.
2. Run the following SQL to create the `projects` table:

```sql
-- Create the projects table
create table public.projects (
  id bigint primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);

-- Enable Row Level Security (RLS)
alter table public.projects enable row level security;

-- For this prototype, we rely on the Service Role Key for backend access.
-- Ensure the service_role has permissions on the table:
GRANT ALL ON public.projects TO service_role;
GRANT ALL ON public.projects TO postgres;
GRANT ALL ON public.projects TO anon; -- Optional: only if you want public read via anon key
```

### 2. Configure Environment Variables
Set the following variables in your hosting provider's dashboard:

| Variable | Description |
| :--- | :--- |
| `PORT` | The port the server runs on (defaults to 5000). |
| `SUPABASE_URL` | Your Supabase project URL (https://...). |
| `SUPABASE_SERVICE_ROLE_KEY` | **SECRET** Service Role Key (Backend only). |
| `SUPABASE_FEED_BUCKET` | Usually `feeds`. |
| `SUPABASE_FEED_FILE` | Usually `capstones-latest.json`. |
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
4. **Public Feed**: The public feed (stable URL) is generated from these database records only when you click **Publish to Duda**.

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
6. **Verify Cloud**: Check the [Official Supabase Feed](https://xojnnhilqaldxoilmxli.supabase.co/storage/v1/object/public/feeds/capstones-latest.json) to see if it updated.

## Demo Readiness
For the full stakeholder demo script and final validation checklist, see **[Demo Readiness](./demo-readiness.md)**.
