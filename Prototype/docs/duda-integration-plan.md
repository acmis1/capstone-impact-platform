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

## 2. Script Placement
The contents of `duda/bodyend.html` must be pasted into the **Body End** section of the Duda Site HTML/CSS editor.

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

## 6. Feed Source
Official Stable Feed URL:
`https://xojnnhilqaldxoilmxli.supabase.co/storage/v1/object/public/feeds/capstones-latest.json`
