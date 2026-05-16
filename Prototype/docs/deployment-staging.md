# Staging Deployment Guide (Admin/CMS Prototype)

This guide explains how to deploy the Admin/CMS prototype to a temporary staging environment (e.g., Render, Railway, or a private Node.js server) for stakeholder review.

> [!WARNING]
> This is a **Prototype** and **Staging** environment only. 
> 1. **Persistence**: It uses a flat-file `db.json`. Changes are lost if the hosting provider uses ephemeral storage (e.g., Heroku without volumes). Render/Railway with "Disks" or persistent volumes is required if you want to keep changes across restarts.
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
