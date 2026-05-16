# Prototype Publishing Notes

## Status Definitions
- **Draft**: Incomplete record, internal only.
- **Submitted**: Student submission received.
- **Awaiting OCR/AI**: Queued for assistive analysis.
- **In Review**: Staff currently reviewing content.
- **Changes Requested**: Feedback sent to students.
- **Preview Sent**: Student group has received a preview link.
- **Student Confirmed**: Students have approved the metadata.
- **Approved**: Verified by staff, queued for the next public sync.
- **Published**: Live on the official Duda showcase.
- **Archived**: Preserved internally but removed from the official public feed.

## How to Remove a Project from the Official Listing
1. Open the project in the **Project Repository**.
2. Click **Edit & Review**.
3. If the project is currently `Published`, an **Archive Project** button will appear in the Management Lifecycle panel.
4. Click **Archive Project** and provide an optional reason.
5. Click **Save & Update Record**.
6. **CRITICAL**: Archiving a record changes its internal status, but you must click **Publish to Duda** on the Dashboard to regenerate the official feed and remove the project from the live site.

## Internal vs Public Fields
The system automatically strips sensitive administrative fields from the public feed.
Excluded fields include:
- `status`
- `internalNotes`
- `reviewNotes`
- `archivedAt`
- `archiveReason`
- `staffNotes`
- `privateNotes`
- `validationErrors`
- (and other administrative metadata)

## Production Notes
- In a production environment, archiving a project should also revoke public access to its associated media files (Posters, Snapshots) in the S3/Storage layer.
- Archived records are never deleted; they remain in the RMIT system of record for historical auditing.
