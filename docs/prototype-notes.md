# Prototype Notes & Demo Script

## Project Context
**Project**: Capstone Impact Platform Redesign
**Strategy**: Hybrid Publishing Workflow (Admin/CMS + Stable JSON Feed + Duda)

## Workflow & Status Model
The system uses a refined submission-review-publish lifecycle:

| Status | Meaning |
| :--- | :--- |
| **Draft** | Internal staff draft or incomplete record. |
| **Submitted** | Student/group submission received from portal (Conceptual). |
| **Awaiting OCR** | Files uploaded and waiting for AI/OCR extraction. |
| **In Review** | Admin is checking extracted fields and validation flags. |
| **Changes Requested** | Admin requested updates from the student group. |
| **Preview Sent** | A simulated preview link has been sent to students. |
| **Student Confirmed** | Student group confirmed the preview is acceptable. |
| **Approved** | Admin approved for publishing (Pending Duda sync). |
| **Published** | Record is live in the official public Duda feed. |
| **Archived** | Historical or hidden record. |

### Approved vs Published
*   **Approved**: The record is ready and will be included in the next "Publish to Duda" batch.
*   **Published**: The record is live on the public site. Records automatically move from *Approved* to *Published* after a successful cloud sync.

## Feature Status
- [x] Admin UI with full workflow lifecycle
- [x] Status-based dashboard and repository
- [x] Workflow Action Panel (Conceptual actions)
- [x] Automatic JSON feed generation (Approved + Published)
- [x] Cloud Sync with Auto-Status Transition
- [x] Duda-compatible script logic
- [x] Premium snapshot lightbox
- [x] Poster PDF file handling

## Production Vision (Phase 2)
The current prototype uses **manual URL-based media** to demonstrate the feed architecture. The production workflow will add:

1. **Integrated File Storage**: Direct uploads to RMIT-approved cloud buckets.
2. **Assistive AI/OCR**: Automatic metadata suggestion from posters (Conceptual flags shown in form).
3. **Student Portal**: Secure interface for groups to submit, view review notes, and confirm previews.
4. **Automated Messaging**: Real email/notifications for "Changes Requested" and "Preview Sent".

## Stakeholder Demo Script

### Part 1: Submission & Review
1. **Dashboard**: Show the **Submission & Publishing Workflow** panel.
2. **Project Repository**: Point out the new status badges and the **Add / Import Submission** button.
3. **Workflow Actions**: Open a "Submitted" project.
   - Show the **Workflow Action Panel**.
   - **Request Changes**: Enter a note and show the generated message preview.
   - **AI/OCR Flags**: Highlight the conceptual analysis flags (Title Match, Confidence, etc.).
   - **Preview**: Click "Send Preview Link" to show the simulated link behavior.
   - **Approval**: Mark the project as **Approved**.

### Part 2: Batch Publishing
1. **Approval State**: Show that the project is now "Approved" in the list.
2. **Publish**: Click **"Publish to Duda"**.
3. **Transition**: Observe the success message: *"X approved records changed to Published."*
4. **Live Verification**: Check the list again to see the "Published" status.

### Part 3: Presentation (Duda Site)
1. **Showcase**: Demonstrate that only "Published" (and "Approved") records appear on the Duda site.
2. **Media**: Verify "Get Project Poster" and Gallery Lightbox behavior.

## Technical Setup
1. `npm install`
2. `npm run dev`
3. Copy `.env.example` to `.env` with Supabase keys.
4. Run `npm run validate-feed` to check public schema safety.
