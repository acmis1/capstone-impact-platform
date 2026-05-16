# Staging Deployment Guide (Admin/CMS Prototype)

This guide explains how to deploy the Admin/CMS prototype to a temporary staging environment (e.g., Render, Railway, or a private Node.js server) for stakeholder review.

> 1. **Persistence**: It uses a flat-file `db.json`. On platforms with ephemeral storage (e.g., Render Free Tier), local changes are lost on restart. We provide a **Supabase Admin State Backup** workaround to recover state manually or automatically on startup.
> 2. **Concurrency**: The system is not designed for concurrent multi-user editing. 
> 3. **Security**: Only "Access Key" protection is implemented. It is not a full identity-based auth system.

## Recommended Hosting
- **Render** (Web Service + Disk)
- **Railway** (Service + Volume)

## Deployment Steps

### 1. Build the Application
Run the following command locally or in your CI/CD pipeline:
```bash
npm install
npm run build
```
This generates the `dist/` folder containing the compiled React frontend.

### 2. Configure Environment Variables
Set the following variables in your hosting provider's dashboard:

| Variable | Description |
| :--- | :--- |
| `PORT` | The port the server runs on (defaults to 5000). |
| `SUPABASE_URL` | Your Supabase project URL (https://...). |
| `SUPABASE_SERVICE_ROLE_KEY` | **SECRET** Service Role Key for cloud publishing. |
| `SUPABASE_FEED_BUCKET` | Usually `feeds`. |
| `SUPABASE_FEED_FILE` | Usually `capstones-latest.json`. |
| `ADMIN_ACCESS_KEY` | (Optional) A secret string required to Save/Publish changes. |
| `DATA_DIR` | (Optional) Path to persistent storage for `db.json` (e.g., `/data`). |
| `PUBLIC_FEED_DIR` | (Optional) Path to persistent storage for the public feed (e.g., `/data/public`). |
| `ENABLE_ADMIN_STATE_BACKUP` | Set to `true` to enable cloud backup/restore for the full admin database. |
| `SUPABASE_ADMIN_STATE_BUCKET` | Private bucket name for admin backups (e.g., `admin-state`). |
| `SUPABASE_ADMIN_STATE_FILE` | Filename for the admin backup (e.g., `admin-db-latest.json`). |

## Persistent Storage Setup (Render/Railway)
To ensure your data survives redeploys:
1. **Mount a Disk/Volume**: In your hosting dashboard, create a persistent volume and mount it at `/data`.
2. **Set Environment Variables**:
   - `DATA_DIR=/data`
   - `PUBLIC_FEED_DIR=/data/public`
3. **Behavior**: 
   - The server will automatically create these folders if they are missing.
   - If `db.json` is missing from the volume, it will be seeded from the local repository template.
   - Without these variables, the server defaults to repo-local `data/` and `public/` folders, which are typically reset on every redeploy.

## Render Free Tier Workaround: Admin State Backup
If you are using the Render Free Tier (which does NOT support persistent disks), use the following configuration to ensure your data is not lost:

1. **Supabase Bucket**: Create a **PRIVATE** bucket in your Supabase storage (e.g., `admin-state`).
2. **Environment Variables**:
   - `ENABLE_ADMIN_STATE_BACKUP=true`
   - `SUPABASE_ADMIN_STATE_BUCKET=admin-state`
   - `SUPABASE_ADMIN_STATE_FILE=admin-db-latest.json`
3. **How it works**:
   - **Automatic Backup**: Every time you Save/Update a project in the CMS, the server automatically uploads the full `db.json` to your private Supabase bucket.
   - **Startup Restore**: When Render restarts your service, the server will automatically attempt to download the latest `admin-db-latest.json` from Supabase and restore it to the local disk before starting.
   - **Manual Controls**: You can trigger a manual Backup or Restore from the **Dashboard** in the "Staging State Backup" panel.
4. **Safety**: 
   - The admin backup file contains internal notes and unpublished fields. 
   - **CRITICAL**: Ensure the bucket is **PRIVATE** so it is not accessible to the public. 
   - The server uses your `SUPABASE_SERVICE_ROLE_KEY` to access it.

### 3. Start Command
The server will automatically serve the API and the static React build:
```bash
npm run server
# or
node server.js
```

## Access Protection
If `ADMIN_ACCESS_KEY` is configured:
1. Open the Admin UI.
2. In the **Sidebar**, locate the **STAGING ACCESS KEY** field at the bottom.
3. Enter the configured key. This is saved in your browser's `localStorage` and sent in the `x-admin-key` header for all write operations.
4. If the key is missing or incorrect, "Save", "Generate Feed", and "Publish" actions will return a `401 Unauthorized` error.

## Verification Checklist
1. **Load CMS**: Visit your deployment URL. The Dashboard should load.
2. **Read Test**: Navigate to "Projects". You should see the current list from `db.json`.
3. **Write Test**: Edit a project, enter the Access Key in the sidebar, and click "Save".
4. **Publish Test**: Click "Publish to Duda" on the Dashboard.
5. **Verify Cloud**: Check the [Official Supabase Feed](https://xojnnhilqaldxoilmxli.supabase.co/storage/v1/object/public/feeds/capstones-latest.json) to see if it updated.
6. **Verify Duda**: Refresh your Duda live site to see the changes reflected.

## Demo Readiness

For the full stakeholder demo script, deployed URLs, and final validation checklist, see **[Demo Readiness](./demo-readiness.md)**.
