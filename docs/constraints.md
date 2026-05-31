# Project Constraints

This document details the immutable constraints that govern the Capstone Impact Platform. These constraints must be respected in all architectural decisions, design plans, and future implementation phases.

## 1. Duda Platform Constraints

> [!WARNING]
> **No Duda Upgrade Under Any Scenario**
> Upgrading the Duda account subscription or site plan is permanently out of scope. The platform must operate entirely within the limits of the current active plan.

*   **No Native Collections/Dynamic Pages**: Because the current plan does not support Duda's advanced database features (dynamic pages, native collection syncing, or custom internal API endpoints), all dynamic loading must be simulated client-side via JavaScript.
*   **Public Layer Only**: Duda must remain solely as a public-facing presentation shell. Under no circumstances should Duda act as the operational database, content editing system, or operational source of truth.
*   **Single stable JSON Feed**: The custom Duda integration script (`bodyend.html`) must pull from a single, static public feed URL. The structure of this feed must be strictly kept backward-compatible to avoid breaking existing showcase pages.
*   **No Break Changes**: **No Duda-facing changes should be made during the break; current Duda prototype evidence must be preserved and reconfirmed in July.**

## 2. Technology & Architecture Constraints

*   **No WordPress Replacement Path**: Transitioning the system to WordPress or another traditional monolithic CMS is excluded. The school-owned admin/CMS + React frontend + Express backend is the selected development pathway.
*   **Free-Tier First**: Until the project budget is officially confirmed, the architecture must assume a free-tier hosting option to be verified later. All break work must be completely reversible.
    *   No paid cloud databases, compute resources, or premium APIs.
    *   Storage and database structures must accommodate free-tier resource limits (e.g., Supabase free-tier database limits and monthly bandwidth caps).
*   **School-Owned Admin/CMS as Operational Source of Truth**: The standalone admin portal is the absolute operational source of truth. Data flows from the admin portal outward to the public feed, never the other way around.
*   **Prototype Status**: The current Prototype v2 is feasibility evidence only, not the production baseline.

## 3. Data & Privacy Constraints

*   **Approved-Only Public Feed**: The public JSON feed must *never* contain internal metadata, review history, validation flags, administrative comments, draft projects, or unpublished records. It must expose approved, public-facing fields only.
*   **Secure Storage Bucket Isolation**: Private database backups and intermediate submission drafts containing student details must reside in private storage buckets or database tables with restricted access. Only fully approved project assets (posters, snapshot images, PDFs) may be written to public storage buckets.

## 4. Break Period Constraints (June 2026)

*   **No Irreversible Changes**: Any work performed during the break must be completely reversible. No permanent changes to the staging database schema, public buckets, or production keys.
*   **No Stakeholder-Facing Changes**: Stakeholders, university coordinators, and academic advisors are unavailable for confirmation. No changes may be pushed to staging or production environments that alter the visual presentation or administrative workflows seen by active users.
*   **No Production Deployment**: Deployment to production environments is strictly prohibited until official stakeholder and academic advisor confirmation is obtained.
*   **No Schema/Workflow Lock**: The core project schema, import rules, and validation workflows must remain flexible. The final schema and operational lock cannot occur before the formal July confirmation session.
