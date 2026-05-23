# Presentation Layout & Presets Strategy

This document details the Staff-Controlled dynamic layout engine implemented in **Prototype v2**.

---

## 1. Overview & Architectural Boundary

The Capstone Impact Platform Redesign enables RMIT administrative staff to fully control the visual hierarchy, content ordering, and presentation styles of capstone project detail pages. 

> [!IMPORTANT]
> **Client-Side Rendering Engine Boundary:**
> - **CMS-Controlled Presets:** These layout options are custom presentation templates rendered dynamically by the client script inside a single reusable Duda detail page. They are **not** native Duda page templates, meaning separate physical pages or native templates do not need to be created or maintained in Duda.
> - **Staff Layout Controls:** RMIT administrative staff can freely reorder or toggle the visibility of any supported content blocks (background, solution, snapshots, video, and links) through the CMS dashboard.
> - **Developer Extensibility:** Adding brand-new content block types or implementing completely different visual grid styles/CSS structures still requires developer extension of the `bodyend.html` rendering logic and `App.jsx` previewer.
> - **Self-Contained Detail Module:** The embedded project detail module defines its own light or dark panel backgrounds, text colors, cards, and CTA styling. It must remain readable on both the local dark preview and Duda's normal white/light page background.
> - **Showcase Sync Decoupling:** Adjusting any visual preset or block visibility configs for a Published project inside the CMS will immediately mark its sync state as **Unpublished CMS changes / Out of Sync**. This layout adjustment **will not** propagate to the live public Duda showcase until the **Publish to Duda** button is activated on the Dashboard. This prevents accidental half-formed visual modifications from instantly changing the live exhibition pages.

---

## 2. Layout Presets (Templates)

Prototype v2 supports three responsive CMS-controlled layout presets inside one reusable Duda detail page. These are visual presets, not native Duda page templates.

### 1. Poster Showcase (`poster_showcase`)
- **Visual Direction:** Exhibition/poster-first page. Optimized for traditional poster-based projects and designed to feel like a capstone exhibition display rather than an article.
- **Expected Structure:**
  - **Poster Wall Hero:** The poster is the visual centrepiece of the first screen, paired with title, summary, compact metadata chips/tags, and a prominent poster PDF button.
  - **Snapshot Highlight Strip:** Snapshots appear as a horizontal exhibition strip below the hero when that block is visible.
  - **Supporting Content:** Background, solution, links, and team information sit lower on the page as supporting material.

### 2. Technical Detail (`technical_detail`)
- **Visual Direction:** Formal report/article-first page. Ideal for software, engineering, research, or explanation-heavy projects.
- **Expected Structure:**
  - **Paper Report Panel:** Uses a light paper-like surface with dark readable text and formal typography.
  - **Structured Sections:** Main content uses numbered report-style sections and can include a table-of-contents/sidebar index.
  - **Appendix Poster:** The poster is treated as a small appendix/support asset, not a hero.

### 3. Media Rich (`media_rich`)
- **Visual Direction:** Demo/media-first page. Perfect for robotics, hardware, video, interactive, or media-heavy projects.
- **Expected Structure:**
  - **Cinema/Gallery Hero:** A full-width media banner directly below the title/header block dominates the first screen.
    - **Video First:** If a `videoUrl` is present, it embeds an interactive 16:9 YouTube/Vimeo frame as the main feature.
    - **Snapshots Grid Fallback:** If no video is present, it showcases the prototype snapshots gallery in a prominent banner.
    - **Poster Fallback:** If neither is present, it falls back to the poster image in a media hero frame.
  - **Body Content Grid:** A responsive two-column grid below the media hero:
    - **Left Main Column:** Renders the narrative content sections.
    - **Project Launchpad:** Demo, repository, and external links render as large CTA buttons in a visible launchpad section.
    - **Poster Support:** Poster remains secondary unless it is the only available media.

---

## 3. Contrast & Self-Contained Styling

Across all three presets, specifications cards, metadata labels, body text, CTA buttons, and media containers define their own backgrounds and text colors inside `#project-detail`. Poster Showcase and Media Rich use dark self-contained panels; Technical Detail uses a light article/report panel with dark readable text. The designs do not depend on Duda's page background.

---

## 4. Featured Media Element

Staff can choose which media asset is elevated to the "Hero" position at the top of the detail page. This is handled by `layoutConfig.featuredMedia`:

1.  **Poster Image** (`poster`): Renders the primary high-resolution poster image as the hero banner.
2.  **Project Video** (`video`): Embeds the interactive YouTube or Vimeo player in a responsive 16:9 container as the hero.
3.  **Snapshots Grid** (`snapshots`): Displays the gallery of prototype snapshots in a grid or masonry-style layout.
4.  **None** (`none`): Standard sidebar presentation with no media hero, ideal for purely text-driven projects.

---

## 5. Content Section Ordering & Visibility Loop

Detail pages are composed of modular content sections. Staff can hide individual sections or reorder them vertically via the CMS UI:

-   **Modular Sections**:
    -   `background`: Project background / problem statement.
    -   `solution`: Project solution / innovation description.
    -   `snapshots`: Photo and screenshot gallery.
    -   `video`: Embedded video player (if not already featured as hero).
    -   `links`: Custom external resources (repository, demo, externalLinks).

### Dynamic Rendering Loop
In `bodyend.html`, the project detail container (`#project-detail`) parses the custom config and renders blocks in a clean, iterative flow:

```javascript
// Step 1: Filter out hidden sections
const visibleSections = layoutConfig.sectionOrder.filter(
  sec => !layoutConfig.hiddenSections.includes(sec)
);

// Step 2: Render each visible section sequentially
visibleSections.forEach(sectionId => {
  renderSectionBlock(sectionId, projectData);
});
```

---

## 6. Developer Guide for Extending Block Types

To add a new block type (e.g., "Student Bios" or "Interactive Mockup Widget"), follow this standard workflow:

### Step A: Update the Schema and CMS UI
1. Add the new block ID (e.g., `bios`) to the default section order array in `src/App.jsx` (`handleEdit` and `prepareProjectForSave` functions):
   ```javascript
   sectionOrder: ['background', 'solution', 'snapshots', 'video', 'links', 'bios']
   ```
2. Update the CMS UI label map in the Section Order render list so that staff see a friendly name.

### Step B: Update the Detail Renderer in Duda
In `duda/bodyend.html`, add a handler in the dynamic rendering switch statement:
```javascript
function renderSectionBlock(sectionId, project) {
  switch (sectionId) {
    case 'bios':
      return `
        <div class="showcase-section block-bios">
          <h3>Meet the Team</h3>
          <div class="team-bios-grid">
            <!-- Dynamic bios list from project metadata -->
          </div>
        </div>
      `;
    // Existing cases...
  }
}
```

### Step C: Update Feed Schema Validator
Add checks to `scripts/validate-feed.js` to verify any new metadata fields required by the extended block.
