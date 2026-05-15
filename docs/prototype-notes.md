# Prototype Notes & Demo Script

## Project Context
**Project**: Capstone Impact Platform Redesign
**Strategy**: Hybrid Architecture (Admin/CMS + Stable JSON Feed + Duda)

## Feature Status
- [x] Admin UI for record management
- [x] Workflow states (Draft, Pending, Approved, Published)
- [x] Automatic JSON feed generation
- [x] **NEW: Cloud Sync to Stable URL (Supabase)**
- [x] Duda-compatible public preview
- [x] Interactive snapshot gallery/lightbox

## Stakeholder Demo Script

### Part 1: Admin Workflow (Local)
1. **Login**: Launch `npm run dev`.
2. **Dashboard**: Show the "System Overview" and current record counts.
3. **Edit**: Open a project (e.g., "AI-Powered Recycling"), change the title to "AI-Powered Recycling v2", and save.
4. **Approve**: Move the record status to "Approved".
5. **Sync**: Click **"Sync Local Feed"**.
6. **Verify**: Open `public/capstones-latest.json` to show the update.

### Part 2: Cloud Publishing (The Hybrid Proof)
1. **Pre-requisite**: Ensure Supabase `.env` is configured.
2. **Publish**: Click **"Publish to Stable URL"**.
3. **Confirm**: Show the success message and the cloud URL.
4. **Live Verification**: Open the cloud URL in a browser to prove the file is now public.

### Part 3: Duda Integration (Presentation)
1. **The Stable Link**: Show `bodyend.html` and point out the `CAPSTONE_FEED_URL`.
2. **Instant Update**: (If Duda is live) Refresh the Duda showcase to show "AI-Powered Recycling v2" appearing automatically.

## Setup Instructions (Technical Staff)
1. `npm install`
2. `npm run dev` (starts backend on 5000 and frontend on 5173)
3. Copy `.env.example` to `.env` and add Supabase credentials.
4. Ensure the `feeds` bucket in Supabase is **Public**.

## Validation
Run `npm run validate-feed` to ensure the public JSON schema is 100% Duda-compatible.
