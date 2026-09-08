# Duda TEST acceptance evidence — 2026-09-08

Status: `TEST_SITE_DATA_BACKED_ACCEPTANCE` / `VERIFIED_STAGING`.

This is sanitized, non-production evidence for exact repository SHA
`50d02632f4403f3acb5620d6b9a2e482e8ac5688`. The authorized PP1 Duda TEST
editor received the repository search renderer and Save completed. No Duda
Publish or Republish occurred, the live RMIT/Impact site was untouched, and
no credentials, editor URLs, cookies, tokens, or session material are stored
here.

## Renderer installation

- Body End before update: `20AB5ADA5DDCE8FE9494CB78DFEF0950FC24BA84B097DE5B918E700370304A7B`
- Installed Body End target: `379B0AD2C24AB3AC992E72325320A942D3E6154B3190E9AEA5EE432D6E6B4863`
- Page CSS before update: `B00432768EE275EC167FB29CF9ECA4FC06CEEFF4B652F9C7B499B005887F0F47`
- Applied search CSS delta: `2251F0F69646A6414FD6F141F13EE3CCC2925AF927810D2E7A2BB8C5F7B1726A`
- Canonical TEST feed: `public-feeds/capstones-latest.json`

## Synthetic data-backed sequence

The single synthetic project was `2020-community-flood-alert` / **Community
Flood Alert**. The governed sequence was:

`approved → participant preview → participant confirmation → READY → fresh READY_TO_STAGE plan → governed staging publication → feed 0 → 1 → Duda TEST acceptance → governed staging archive/removal → feed 1 → 0`.

Publication completed with one record and feed SHA-256
`98bf861e86974d37bcd0f4e1dcd70bdbfcb70e3f8dc41e96e213931a651295c5`.
Inspection found no obvious private/internal fields, including participant
contact email, staff notes, private review comments, preview token/hash,
private draft paths, or internal administrative workflow state. This bounded
inspection is not a universal security proof.

The Duda TEST renderer passed:

- populated listing;
- title `Flood`, case-insensitive `FLOOD`, public ID `community-flood`, industry-partner `Resilience Lab`, and group/team `Resilience 2020` searches;
- deterministic no-match with exact text `No projects match the current search or filters.` and clear search;
- Year `2020`, Program `Information Technology`, Discipline `Data and software systems`, and Industry `Climate resilience` facets, including `Flood` + Year `2020` intersection;
- reusable detail-page navigation;
- populated listing mobile preview: scroll width equaled client width with no horizontal overflow;
- canonical feed request HTTP 200 and zero fatal JavaScript errors.

The explicit responsive acceptance covers the populated listing and its
search/filter/card controls. The detail screenshot proves rendering and
navigation only; it is not a separate mobile detail accessibility/no-overflow
acceptance.

## Cleanup and current staging posture

Governed staging archive/removal completed. The final project state was
`archived`, `archived-from=published`, `public removal pending=false`, and
the project was absent from the Duda TEST listing and previously used detail
route after refresh. The final canonical feed contained zero records with
SHA-256
`4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.

The authoritative current deployment is Render
`capstone-admin-cms-staging-v2`, deployment `dep-dafimfn9l3cc73c8blog`, exact
SHA `50d02632f4403f3acb5620d6b9a2e482e8ac5688`. Post-disable read-only
`/api/health` and `/api/readiness` checks returned 200, readiness was `READY`,
and `CAPSTONE_STAGING_PUBLICATION_ENABLED=false` was restored immediately
after the supervised acceptance window. A duplicate identical `false`
environment update caused one redundant shutdown redeploy; it is not a
product defect or data incident.

The legacy `/api/publish-cloud-feed` path was not called. No direct feed edit,
Supabase dashboard/SQL browser action, or live Duda/Impact publication occurred.
This evidence was generated through the authorized hosted staging Admin/CMS,
canonical public feed, and Duda TEST site; Render configuration changes were
performed separately by the ChatGPT orchestrator and are recorded above.

## Sanitized screenshot manifest

| File | Bytes | SHA-256 | Purpose |
| --- | ---: | --- | --- |
| `populated-listing.png` | 84393 | `EBE506E06C3D62F4C7D5EC3E2B21568F210CDF400918B555EFD42149CB3F5008` | Synthetic populated TEST listing |
| `search-title.png` | 95719 | `95733A1BB0CD34618330954210A85B6E7097ACD6AC0664FD0A463ACD9403971F` | Title-search result |
| `search-public-id.png` | 95719 | `95733A1BB0CD34618330954210A85B6E7097ACD6AC0664FD0A463ACD9403971F` | Public-ID search result |
| `search-no-match.png` | 70084 | `D6BC5CA9E6309620928CD6DB4DDD2B665F3041158A8D195C1407501E9585710A` | Deterministic empty state |
| `search-facet-intersection.png` | 95719 | `95733A1BB0CD34618330954210A85B6E7097ACD6AC0664FD0A463ACD9403971F` | Search plus facet intersection |
| `reusable-detail-page.png` | 27838 | `EC0E27DA40731DDBA75EC9ED4C956B7FC03071785AB60B34649AE079A5755B3F` | Reusable detail rendering/navigation |
| `populated-mobile-listing.png` | 66426 | `AA6284C31522900545E15D989715ADE4D9AD1345785DC44EA096085252814724` | Duda mobile preview of populated listing |
| `post-cleanup-listing.png` | 68975 | `71F5553C0A5B0A46651D93459D1E9240880D03385772A290C41CE825D0E110CD` | Empty TEST presentation after cleanup |

`search-title.png`, `search-public-id.png`, and `search-facet-intersection.png`
are byte-identical captures. The browser was scrolled to the same resulting project card,
so the query/facet controls are outside those image frames. They are retained as the original
sanitized captures, but they are not three independent visual proofs; the distinct title, public-ID,
and search-plus-facet results come from the recorded browser interaction assertions.

## Evidence boundary

### VERIFIED

- Repository renderer installed in the authorized Duda TEST editor.
- Test editor Save completed.
- No Duda Publish/Republish.
- Governed staging publication succeeded.
- One synthetic approved record rendered.
- Public-field search worked.
- All four facets worked with the test record.
- Reusable detail navigation worked.
- Governed removal returned the feed to `[]`.
- The synthetic record disappeared from the TEST presentation.
- The populated listing passed the explicit Duda mobile preview/no-overflow check.

### NOT PROVED

- Live/production Duda.
- Production Impact publication.
- 100+ projects simultaneously published through Duda.
- Production throughput/SLA.
- Human stakeholder UAT.
- Staff-effort reduction.
- Mobile detail-page accessibility certification.
- Institutional release acceptance.

Remaining open evidence includes KPI-01 human staff-effort measurement,
KPI-12 intended-user task completion/satisfaction where human evidence is
absent, KPI-15 `>=80%` unaided documentation-based training, institutional
ownership, credential transfer, monitoring recipient/alert routing, hosted
database and Storage restore rehearsals, Render rollback rehearsal, hosted
RPO/RTO, and live Duda/Impact publication. The release checklist remains an
unchecked `0/67` template.
