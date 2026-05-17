# Demo Readiness — Capstone Impact Platform Prototype

> **Last updated:** 2026-05-17
>
> This document is the single reference for stakeholder demonstrations of the Capstone Impact Platform prototype.

---

## 1. Deployed URLs

| Component | URL |
| :--- | :--- |
| **Render Admin/CMS** | `https://capstone-impact-platform.onrender.com` |
| **Supabase Stable Feed** | `https://xojnnhilqaldxoilmxli.supabase.co/storage/v1/object/public/feeds/capstones-latest.json` |
| **Duda Public Listing** | `[insert Duda listing URL]` |
| **Duda Project Detail** | `[insert Duda detail URL]` (path: `/project-detail?id=…`) |
| **GitHub Repository** | `https://github.com/acmis1/capstone-impact-platform` |

> [!IMPORTANT]
> The staging access key is shared separately with authorised stakeholders. It is **never** committed to the repository.

---

## 2. Stakeholder Demo Script

Use the following step-by-step script during live demonstrations.

### Setup
1. Open the **Render Admin/CMS** URL in a browser.
2. Enter the **staging access key** in the sidebar field.
3. **Note on Persistence**: Even on the Render Free Tier, project records are now persisted in the **Supabase Database**. No manual restore steps are needed after a server restart.

### Dashboard & Publishing Workflow
3. Observe the **Dashboard** — it shows the project summary and publishing controls.
4. Click **"Projects"** in the sidebar to open the Project Repository.

### Editing & Importing
5. Select a project and click **Edit & Review** to show the editor.
6. Demonstrate adding or editing a project record.
7. Point out the **source files/media fields**:
   - Poster Image URL
   - Poster PDF URL
   - Snapshot gallery URLs
   - `posterText` field (long-form poster text)
8. **Explain**: AI/OCR-assisted text extraction is conceptual in this prototype — the `posterText` field is manually entered or imported.

### Approval & Publishing
9. Set the project status to **Approved** and click **Save & Update Record**. (This automatically regenerates the local preview feed).
10. Return to the **Dashboard** — observe that the public record counts update.
11. Click **"Publish to Duda"** — confirm the feed is uploaded to Supabase and the project status transitions to **Published**.

### Verification — Feed & Duda
13. Open the **Supabase Stable Feed URL** in a new tab — show the JSON contains the approved project.
14. Open the **Duda Public Listing URL** — refresh the page and show the project card appears.
15. Click the project card to navigate to the **Detail Page** and confirm all fields render.

### Archive / Removal Flow
16. Return to the Admin/CMS and open the published project.
17. Click **"Archive Project"** and provide an optional reason.
18. Return to the Dashboard and click **"Publish to Duda"** again.
19. Refresh the **Supabase feed** — the archived project should no longer appear.
20. Refresh the **Duda listing** — the archived project card should be gone.

---

## 3. What This Prototype Proves

- ✅ Admin/CMS can manage capstone project records end-to-end.
- ✅ **Cloud Persistence**: Records survive server restarts and redeploys without local disk storage.
- ✅ Non-technical staff do not need to edit JSON, GitHub, or Duda code manually.
- ✅ A stable public feed URL (`capstones-latest.json`) remains unchanged — consumers always fetch the same endpoint.
- ✅ The Duda public layer updates dynamically from approved public data.
- ✅ Poster images, poster PDF links, and snapshot galleries are supported in the data model and rendered on Duda.
- ✅ Archive/removal workflow prevents removed projects from appearing on the live site after republishing.

---

## 4. What It Does Not Prove Yet

These features are **out of scope** for the prototype and are planned for production:

- ❌ Real OCR/AI extraction from poster files.
- ❌ Real student submission form (intake from students).
- ❌ Real preview email sent to student groups.
- ❌ Real student confirmation link.
- ❌ Production authentication and role management (RMIT SSO, RBAC).
- ❌ Production media upload automation (direct file upload to cloud storage).

---

## 5. Known Staging Limitations

> [!WARNING]
> The current deployment is a **staging prototype**. Be aware of the following:

| Limitation | Detail |
| :--- | :--- |
| **Render Free spin-down** | The free-tier service spins down after inactivity. The first request after idle may take 30–60 seconds. |
| **Shared access key** | The staging access key is a single shared secret — it is not a production auth system. |
| **Production requirements** | Production should use proper authentication (RMIT SSO) and managed file upload storage. |

---

## 6. Final Validation Checklist

Run through this checklist before any stakeholder demo.

| # | Check | Pass? |
| :--- | :--- | :---: |
| 1 | Render app loads (Dashboard visible) | ☐ |
| 2 | `/api/projects` returns JSON project array from database | ☐ |
| 3 | `/capstones-latest.json` returns the public feed | ☐ |
| 4 | Local preview feed updates automatically after save | ☐ |
| 5 | "Publish to Duda" completes without error | ☐ |
| 6 | Supabase feed URL returns updated JSON | ☐ |
| 7 | Duda listing page shows approved projects | ☐ |
| 8 | Archive → Publish removes project from Duda | ☐ |
| 9 | No secrets committed (`.env` is in `.gitignore`) | ☐ |

---

## 7. Related Documentation

- [Deployment & Staging Guide](./deployment-staging.md)
- [Duda Integration Plan](./duda-integration-plan.md)
- [Prototype Publishing Notes](./prototype-notes.md)
