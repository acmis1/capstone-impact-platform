# Duda Integration Plan - Capstone Impact Showcase

This document outlines the standard integration process for the Capstone Showcase on the Duda platform.

## 1. Container IDs
To ensure the dynamic script can find and inject content, the following IDs must be used exactly as specified. Do not use camelCase versions.

### Listing Page
The main showcase page must contain exactly one root container:
```html
<div id="capstone-showcase-root">
    <div id="capstone-project-grid"></div>
</div>
```

### Detail Page
The dedicated project detail page (path: `/project-detail`) must contain:
```html
<div id="project-detail"></div>
```

## 2. Script Placement & Runtime Configuration

To support configurable deployment environments, the integration script separates code from config:

1.  **Configuration Script**: Insert this small configuration script block into Duda's **Head HTML** or at the top of **Body End** (before the main script):
    ```html
    <script>
    window.CAPSTONE_FEED_URL = "<PUBLIC_FEED_URL>";
    </script>
    ```
    Replace `<PUBLIC_FEED_URL>` with your public Supabase Storage feed URL format:
    `https://<GENERATED_PROJECT_REFERENCE>.supabase.co/storage/v1/object/public/feeds/capstones-latest.json`
    
    *   **Security Notice**: The feed URL is public; the secret API key is never placed in Duda. Duda does not query `public.projects` directly. It only reads the public JSON Storage object.
    
2.  **Main Showcase Script**: Paste the contents of `duda/bodyend.html` into the **Body End** section of the Duda Site HTML/CSS editor.

## 3. Styling
The contents of `duda/listing-page.css` and `duda/detail-page.css` should be added to the site-wide CSS or page-specific CSS in Duda.

## 4. CRITICAL: Static Content Warning
> [!WARNING]
> The Duda listing page must not contain old static or manually pasted project cards. The script in `bodyend.html` is designed to clear the `#capstone-project-grid` container and render projects dynamically from the Supabase feed. 
> 
> Any old manually created widgets, rows, or columns representing previous projects must be removed from the Duda editor to prevent layout issues or stale data from appearing above/below the dynamic grid.

## 5. Fetching & Caching
The integration uses a cache-busting strategy to ensure the latest project data is always displayed:
- A unique version parameter (`?v=TIMESTAMP`) is appended to the feed URL.
- The `fetch` call uses `{ cache: "no-store" }`.

## 7. Duda Integration Steps

Follow these steps to update the live Duda site:

### Step A: Update the Global Script
1.  Open the Duda Editor.
2.  Go to **Settings** > **Site HTML/CSS**.
3.  Locate the **Body End** tab.
4.  Replace the entire existing script block with the contents of `duda/bodyend.html`.
5.  Click **Save**.

### Step B: Update the Listing Page
1.  Navigate to the **Projects Showcase** page in the Duda Editor.
2.  Remove any old "Posters" or "Project Cards" that were manually created.
3.  Add an **HTML Widget**.
4.  Paste the contents of `duda/listing-page.html`.
5.  Add the contents of `duda/listing-page.css` to the page-specific CSS.

### Step C: Update the Detail Page
1.  Navigate to the **Project Detail** page (URL path must be `/project-detail`).
2.  Remove any static placeholders.
3.  Add an **HTML Widget**.
4.  Paste the contents of `duda/detail-page.html`.
5.  Add the contents of `duda/detail-page.css` to the page-specific CSS.

### Step D: Publish Changes
1.  Click **Republish** in the Duda Editor.
2.  Open the live site in an Incognito window to verify.
3.  Check the browser console; you should see logs starting with `[Showcase]`.

---

## 8. Dynamic Client-Side Presentation & Layout Engine (New in v2)

The Duda public showcase rendering script (`bodyend.html`) has been refactored in Prototype v2 to support administrative layout control dynamically on the client side.

> [!NOTE]
> **Key Architectural Boundaries:**
> - **CMS-Controlled Presets:** These layout options are custom presentation templates rendered dynamically by the client script inside a single reusable Duda detail page. They are **not** native Duda page templates, meaning you do not need to create or maintain separate physical pages in Duda.
> - **Supported Blocks:** Administrative staff can freely reorder or toggle the visibility of any supported content blocks (background, solution, snapshots, video, and links) through the CMS dashboard.
> - **Developer Extensibility:** Adding brand new content block types or implementing completely different visual grid styles/CSS structures still requires developer extension of the `bodyend.html` rendering logic.
> - **Self-Contained Module Styling:** The project detail renderer scopes styles to `#project-detail` and preset classes. It does not style `body` or `html`, and each preset defines its own readable backgrounds, cards, metadata, and CTA colors so it works on Duda's white/light page background.

### Dynamic Feed Fetching & Routing
- The script intercepts page loading on `/project-detail?id=...`.
- It fetches the stable feed `feeds/capstones-latest.json` with aggressive cache busting (`?v=TIMESTAMP`).
- It extracts the `layoutConfig` object from the matching project record. If no configuration is provided, it falls back to the standard `poster_showcase` template and default section ordering.

### CSS Flex/Grid Dynamic Ordering & Visibility
- **Presets & Grid Structuring**:
  - The script maps the chosen `templateId` (`poster_showcase`, `technical_detail`, `media_rich`) to high-fidelity container CSS classes (e.g. `layout-preset-poster_showcase`, `layout-preset-technical_detail`, `layout-preset-media_rich`).
  - These presets use modern CSS Grid and Flexbox rules to reorganize text and media columns responsively, creating three highly distinct visual structures:
    - **Poster Showcase (`poster_showcase`) - Exhibition/poster-first page**: Presents the project like a capstone exhibition wall. The poster is the first-screen centrepiece, metadata appears as compact chips/tags, the poster PDF button is prominent, and visible snapshots appear as a horizontal highlight strip below the hero.
    - **Technical Detail (`technical_detail`) - Formal report/article-first page**: Uses a light paper/report panel, dark readable text, numbered section headings, and a table-of-contents/sidebar index. The poster is a small appendix/support asset rather than a hero.
    - **Media Rich (`media_rich`) - Demo/media-first page**: Uses a full-width cinema/gallery hero at the top. Video is preferred first, snapshots become a large gallery hero when no video exists, and the poster is only primary when it is the only media. Demo, repository, and external links render as large Project Launchpad CTA buttons.
- **Hero Element Elevations**:
  - The elevated media element defined in `featuredMedia` (`poster`, `video`, `snapshots`, or `none`) is extracted from the normal content flow where that preset uses a featured treatment. The Media Rich preset prefers video first, then snapshots, then poster fallback.
- **Section Ordering & Visibility**:
  - Administrative staff can freely reorder or toggle the visibility of any supported content blocks (background, solution, snapshots, video, and links) through the CMS dashboard. The rendering loop iterates over `layoutConfig.sectionOrder`, checking `layoutConfig.hiddenSections` to skip hidden elements while rendering approved content blocks sequentially.
  - This architecture achieves absolute presentation control without modifying native Duda layouts or creating redundant pages.
  - Adding brand-new content block types or implementing completely different visual grid styles/CSS structures still requires developer extension of the `bodyend.html` rendering logic.

---

## 8.5 Publishing State & Duda Sync Alignment

To prevent confusing simple CMS record saves with live public site distribution, the platform manages **CMS Lifecycle Status** and **Duda Sync Status** separately.

- **Status Separation**: A project's CMS Status can be `Published` while its Duda Sync Status is `Unpublished CMS changes`. This indicates that although the project is live on Duda, staff have made local updates (such as changing a layout preset or editing descriptions) that will not appear live until they click the **Publish to Duda** button from the dashboard.
- **Stable Fingerprinting**: The CMS calculates a cryptographic-style fingerprint (hash) of the public-facing subset of each project. When a publish succeeds, the current fingerprint is saved as `lastPublishedPublicHash`. If subsequent CMS changes alter any public details, the current hash deviates from the last published hash, immediately alerting staff that Duda is out of sync.

---

## 9. Feed Source

Official Stable Feed URL (configured at runtime via script injection):
`https://<GENERATED_PROJECT_REFERENCE>.supabase.co/storage/v1/object/public/feeds/capstones-latest.json`
