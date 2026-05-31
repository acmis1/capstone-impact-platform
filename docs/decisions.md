# Confirmed Design Decisions

This document summarizes the core technical and operational decisions agreed upon for the Capstone Impact Platform. These decisions form the foundation of the Part 2 implementation plan.

---

## 1. Selected Architecture: Hybrid Model

*   **Decision**: Implement a decoupled **Hybrid Architecture** combining a custom School-Owned Admin/CMS with a stable client-side Duda Integration.
*   **Rationale**: Duda offers an excellent, responsive, and brand-compliant showcase container, but its high-tier subscription plans (required for native dynamic data collections and database syncing) are permanently out of scope. A custom React + Express admin portal provides full operational control and data validation at zero additional licensing cost, publishing to Duda via a public JSON feed.
*   **Status**: **Confirmed** (Proven via Prototype v2, which represents feasibility evidence only).

---

## 2. Duda Presentation Layer Strategy

*   **Decision**: Retain Duda strictly as a responsive public showcase shell (public layer only). Bypass the lack of Duda-native collections/dynamic pages by injecting a lightweight, custom JavaScript payload (`bodyend.html`) into Duda's footer.
*   **Rationale**: The body-end script intercepts page requests at runtime. 
    *   If the user is on the project listing page, the script dynamically fetches the approved JSON feed and renders the grid.
    *   If the user is on the detail page, the script parses the URL hash query, finds the corresponding project in the cached feed, and populates the details dynamically.
*   **Safety Lock**: **No Duda-facing changes should be made during the break; current Duda prototype evidence must be preserved and reconfirmed in July.**
*   **Status**: **Confirmed**.

---

## 3. Operational Source of Truth

*   **Decision**: Establish the standalone, school-owned Admin/CMS as the absolute operational source of truth.
*   **Rationale**: Managing data directly in Duda is impractical and error-prone due to subscription limits and lack of fine-grained workflow states. By maintaining a custom admin dashboard (utilizing Supabase as the backing database), staff can safely track project lifecycles (Draft, Submitted, In Review, Approved, Published, Archived) without risk of exposing incomplete data to the public.
*   **Status**: **Confirmed**.

---

## 4. Staff-Facing Metadata Format

*   **Decision**: Standardize `project-details.xlsx` (an Excel spreadsheet template) as the primary, staff-facing metadata ingestion format.
*   **Rationale**: Academic coordinators and administrative staff are highly familiar with spreadsheet management. Forcing staff to manually copy and paste 20+ fields (team members, citations, study programs, poster text) for dozens of student projects through Web UI forms is inefficient and prone to input errors. Standardizing on an Excel template enables easy preparation, folder-level batch imports, and automated parsing.
*   **Status**: **Confirmed**.

---

## 5. Rules-First Data Validation

*   **Decision**: Implement a **Rules-First Validation Pipeline** in the admin backend to check package structure, file type correctness, file sizes, and metadata schema compliance.
*   **Rationale**: Quality control is the single biggest operational challenge during Capstone publishing. Automated, rules-based validation flags missing images, oversized PDFs, incorrect file path nesting, or malformed metadata fields immediately upon import, before admin reviews begin.
*   **Status**: **Confirmed**.

---

## 6. Role of OCR and AI Extraction

*   **Decision**: Classify OCR (Optical Character Recognition) and AI-driven poster text extraction as **optional, assistive support only**.
*   **Rationale**: OCR and AI language models can automatically extract titles, supervisor names, or summaries from poster PDFs to prepopulate metadata. However, these tools are inherently probabilistic and can make errors. The core workflow must remain driven by the rules-first Excel parser, with AI/OCR acting as an optional "efficiency helper" that pre-fills forms but *never* bypasses human review or acts as a blocker.
*   **Status**: **Confirmed**.

---

## 7. Media Handling and Public/Private Asset Separation

*   **Decision**: Establish strict **media handling and public/private asset separation** rules for all student-submitted and staff-approved images.
*   **Rationale**: Currently, image fields (`poster`, `snapshots`) store absolute public URLs. Moving forward, the system must process student assets to verify formats and size bounds, while ensuring private metadata remains completely separate from public static media paths. Under the hood, a free-tier hosting option to be verified later will host the stable feed and public assets, while private drafts and submission details will be strictly isolated.
*   **Status**: **Confirmed**.

---

## 8. Voting and Engagement Features

*   **Decision**: Classify student or public voting as **optional / later phase** and ensure it does *not* block or interfere with the core publishing workflow.
*   **Rationale**: A public showcase must prioritize stability and ease of publishing first. Social engagement mechanisms (like upvoting or project likes) introduce substantial database state tracking, session management, and potential abuse vectors. These will be treated as secondary enhancements for a later sprint.
*   **Status**: **Confirmed**.
