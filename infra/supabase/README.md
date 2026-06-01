# Staging Supabase Migrations (`admin-cms/supabase`)

This directory contains the initial staging database schema and RLS policies for the new Capstone Admin/CMS application.

## ⚠️ Important Constraints

1. **Target Environment Only:** These migrations are designed **exclusively** for the new `capstone-impact-staging` Supabase project.
2. **Never Apply to Old Projects:** Under no circumstances should these files be executed on the old demo Supabase project or any other existing production baseline.
3. **Staging Foundations:** These tables, indexes, and policies represent a staging foundation, not the final production schema. Structure, column names, and RLS will be refined before production release.
4. **Manual Application:** Execute these files manually through the **Supabase SQL Editor** UI of your staging project. Do not use the Supabase CLI to push migrations unless explicitly authorized at a later stage.
5. **No Duda Connection:** The Duda showcase website must not be connected to this database or any live feed generated from this staging schema yet.
6. **No Real Data:** Do not insert real stakeholder, supervisor, or student personal data into this staging environment. Use only mock or synthetic data.

## Migration Files

* **[0001_staging_schema.sql](file:///d:/IT%20RMIT/Capstone/admin-cms/supabase/migrations/0001_staging_schema.sql):** Creates core tables (`programs`, `disciplines`, `industry_categories`, `admin_users`, `user_roles`, `import_batches`, `projects`, `project_disciplines`, `project_industry_categories`, `media_assets`, `validation_flags`, `approval_records`, `published_snapshots`), check constraints, indices, and an `updated_at` auto-updating trigger.
* **[0002_staging_rls_policies.sql](file:///d:/IT%20RMIT/Capstone/admin-cms/supabase/migrations/0002_staging_rls_policies.sql):** Enables Row-Level Security (RLS) on all tables and configures strict, restrictive rules (no public anonymous access, only basic authenticated reads for lookups, block browser-side admin writes).
