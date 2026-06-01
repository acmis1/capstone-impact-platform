# Capstone Impact Platform Monorepo

Welcome to the central repository for the Capstone Impact Platform. This repository has been structured as a monorepo using npm workspaces to coordinate infrastructure staging and application logic for Part 2 of the Capstone project.

## 📂 Repository Layout

*   **`apps/admin-cms/`**: Next.js workspace app, serving as the staging foundation for the future production Admin/CMS.
*   **`infra/supabase/`**: Staging Supabase database schema migrations, Row-Level Security (RLS) policies, and manual database application guides.
*   **`docs/`**: Central architecture mapping, constraints, and stakeholder decision checklist documents.
*   **`Prototype/`**: The original Prototype v2 codebase, preserved as feasibility evidence and untouched.

## 🏃 Quick Start Workspace Scripts

From the repository root, you can run convenience workspace commands:

*   **Install Dependencies**: `npm install`
*   **TypeScript Checks**: `npm run typecheck:admin`
*   **Audit Public feed**: `npm run check:feed`
*   **Build Workspace**: `npm run build:admin`
*   **Start Local CMS**: `npm run dev:admin`

## 🛡️ Staging Safety & Isolation Constraints
*   **Feasibility Proof Only**: The original Prototype v2 code is kept as evidence only and is completely isolated.
*   **Staging Project Buckets**: Database and feed operations are directed strictly to the new staging environment (`capstone-impact-staging`).
*   **Isolated Public showcase**: The live Duda showcase remains isolated from these staging feed updates until stakeholder workflow confirmations are finalized in July.
*   **No Real Data**: Mock or generated fake datasets are used exclusively; real RMIT stakeholder or supervisor lists are strictly prohibited.
