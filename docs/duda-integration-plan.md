# Duda Integration Plan: Stable Public Feed

## 1. Overview
The Capstone Impact Platform uses a **Hybrid Architecture**. The Admin/CMS manages the "Source of Truth" and publishes a subset of data to a stable, public JSON feed. Duda acts as the presentation layer, consuming this feed to dynamically render project cards and detail pages.

## 2. The Stable Feed Principle
- **Single Source of Truth**: Duda points to exactly **one** stable URL.
- **Persistence**: This URL never changes. When the Admin/CMS publishes updates, it overwrites the contents of this file.
- **Dynamic Rendering**: The Duda front-end script handles new projects, new years, and content changes automatically without manual intervention in the Duda editor.
- **No-Hero Design**: To match the premium showcase style, the Duda listing page should not use a static hero title or subtitle. Only dynamic year headings (with white background bars) are rendered.
- **Poster-Only Listing**: The listing page intentionally renders poster-only cards to mimic the old showcase. Project metadata (title, program, etc.) is shown on the reusable detail page, not under listing cards.
- **Automated Year Sections**: New years appear automatically when approved records with that year are published into the feed.

## 3. The Public Hosting Requirement
Duda is a cloud-based platform. It cannot "see" your local machine (`localhost`). For the stakeholder demo to work:
- The **JSON Feed** must be reachable via a public HTTPS URL.
- All **Project Images** (posters and snapshots) must be reachable via public HTTPS URLs.

## 4. Public Hosting Implementation (Supabase)
For the stakeholder demo, we use **Supabase Storage** to host the stable public feed.

### Step 1: Create Supabase Bucket
1. Log in to [Supabase](https://supabase.com/).
2. Go to **Storage** -> **New Bucket**.
3. Name the bucket `feeds`.
4. **IMPORTANT**: Make the bucket **Public**.
5. (Optional) Create another public bucket named `assets` for future image mirroring.

### Step 2: Configure Environment Variables
Create a `.env` file in the `Prototype/` directory (based on `.env.example`) with your project credentials:
- `SUPABASE_URL`: Your project URL (e.g., `https://xyz.supabase.co`)
- `SUPABASE_SERVICE_ROLE_KEY`: Your secret service role key (Backend only!)
- `SUPABASE_FEED_BUCKET`: `feeds`
- `SUPABASE_FEED_FILE`: `capstones-latest.json`

### Step 3: Stable Feed URL Format
Once published, your stable feed URL will follow this pattern:
`https://xojnnhilqaldxoilmxli.supabase.co/storage/v1/object/public/feeds/capstones-latest.json`

### Step 4: One-Time Duda Setup
1. Copy the public URL from Step 3.
2. In the Duda **Body End** script (`bodyend.html`), update the `CAPSTONE_FEED_URL` constant.
3. Publish the Duda site.
4. **Do not change this URL again.** The Admin/CMS will overwrite the file at this exact path.

## 5. Design Guidelines
- **Listing Page**: Mimics the original poster grid on a gradient background. Posters are transparent with white pill buttons.
- **Detail Page**: Mimics the original white-background project detail page. **Duda Requirement**: Set the row/section background to white on the `project-detail` page to ensure maximum readability.
- **Project Snapshots**: Rendered as a compact thumbnail grid that opens into a lightbox for full-size viewing.
  - **Lightbox Close**: Supports clicking 'X', pressing 'Esc', or clicking the dark backdrop to return to the detail page.
- **Get Project Poster**: 
  - Opens the full poster file in a new tab. 
  - Priority: `posterPdf` (PDF/Full File) > `poster` (Image Preview).
- **Single Feed**: Duda uses one reusable project-detail page and one stable JSON URL for all project records across all years.

## 5. Image Strategy
Currently, image fields (`poster`, `snapshots`) store absolute public URLs. 
- **Phase 1 (Now)**: Continue using external public image URLs.
- **Phase 2 (Future)**: Implement automatic image mirroring to the Supabase `assets` bucket.

## 6. Duda Configuration Steps
- **Listing Page**: Create a Custom Widget using `listing-page.html` and `listing-page.css`.
- **Detail Page**: Create a page named `project-detail` using `detail-page.html` and `detail-page.css`.
- **Controller**: Add `bodyend.html` to the "Body End" section of the site.

### ⚠️ Duda Configuration Warnings
- **Container Separation**: The listing page must **only** contain the `capstone-project-grid` container (from `listing-page.html`). The detail page must **only** contain the `project-detail` container (from `detail-page.html`).
- **Do not paste both containers on the same Duda page.** The `bodyend.html` script is site-wide and uses these IDs to decide whether to render a listing or a detail view.
- **Slug Consistency**: Ensure the detail page slug is `project-detail` so the routing logic correctly identifies the page.

## 7. Feed Schema (19 Fields)
The Duda script expects the following JSON structure:
- `id`, `title`, `summary`, `year`, `program`, `discipline`.
- `background`, `solution`, `poster`, `snapshots`, `imageAlt`.
- `teamMembers` (Array), `disciplines` (Array), `citations` (Array).
- `industryPartner`, `academicSupervisor`, `groupName`, `studyProgram`, `posterText`.
