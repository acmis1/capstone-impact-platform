-- Capstone Impact Platform - Local Development Synthetic Seed Data
-- infra/supabase/seed.sql
-- Idempotent, synthetic-only seed data for local testing.

BEGIN;

-- 1. Lookup Tables
INSERT INTO public.programs (id, name) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Bachelor of Software Engineering'),
  ('a0000000-0000-0000-0000-000000000002', 'Bachelor of Engineering'),
  ('a0000000-0000-0000-0000-000000000003', 'Bachelor of IT'),
  ('a0000000-0000-0000-0000-000000000004', 'Bachelor of Digital Media')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.disciplines (id, name) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'Software Engineering'),
  ('b0000000-0000-0000-0000-000000000002', 'IT'),
  ('b0000000-0000-0000-0000-000000000003', 'Mechanical Engineering'),
  ('b0000000-0000-0000-0000-000000000004', 'Aviation'),
  ('b0000000-0000-0000-0000-000000000005', 'IoT Systems'),
  ('b0000000-0000-0000-0000-000000000006', 'Agriculture'),
  ('b0000000-0000-0000-0000-000000000007', 'Virtual Reality'),
  ('b0000000-0000-0000-0000-000000000008', 'Digital Media')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.industry_categories (id, name) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'Technology'),
  ('c0000000-0000-0000-0000-000000000002', 'Healthcare'),
  ('c0000000-0000-0000-0000-000000000003', 'Agriculture')
ON CONFLICT (name) DO NOTHING;

-- 2. Import Batches
INSERT INTO public.import_batches (id, batch_name, mode, source_folder, status, total_projects, warning_count, error_count) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'local-seed-batch-2026', 'batch', 'capstone-batch-demo', 'completed', 4, 1, 0)
ON CONFLICT (id) DO NOTHING;

-- 3. Synthetic Projects
INSERT INTO public.projects (
  id,
  public_id,
  title,
  slug,
  summary,
  background,
  solution,
  year,
  program_id,
  program_name,
  study_program,
  discipline,
  industry,
  industry_partner,
  academic_supervisor,
  group_name,
  team_members,
  poster_url,
  poster_pdf_url,
  poster_text_public,
  accessibility_text_public,
  snapshots,
  video_url,
  demo_url,
  repository_url,
  external_links,
  citations,
  layout_config,
  status,
  import_batch_id,
  source_folder,
  internal_staff_notes,
  private_review_comments
) VALUES
  (
    'e0000000-0000-0000-0000-000000000001',
    '2026-traffic-engine',
    'Dynamic Traffic Optimization Engine',
    'traffic-engine',
    'An AI-powered grid system designed to dynamically schedule traffic signals.',
    'Modern urban intersections suffer from gridlock due to rigid static scheduling cycles.',
    'Developed an edge-compute camera grid that schedules signal offsets dynamically based on queuing.',
    2026,
    'a0000000-0000-0000-0000-000000000001',
    'Bachelor of Software Engineering',
    'Bachelor of Software Engineering',
    'Software Engineering',
    'Technology',
    'Urban Grid Solutions (Synthetic)',
    'Dr. Academic Supervisor A (Synthetic)',
    'GreenLight Traffic (Synthetic)',
    ARRAY['Synthetic Member 1', 'Synthetic Member 2'],
    'http://127.0.0.1:54321/storage/v1/object/public/project-public-assets/2026/traffic-engine/poster.png',
    'http://127.0.0.1:54321/storage/v1/object/public/project-public-assets/2026/traffic-engine/poster.pdf',
    'Traffic Optimization Systems. Dynamic Signal Management.',
    'Poster showcasing a synthetic intersection flow with green routing signal vectors.',
    ARRAY['http://127.0.0.1:54321/storage/v1/object/public/project-public-assets/2026/traffic-engine/snapshot1.png'],
    'https://www.youtube.com/watch?v=mocktraffic',
    'http://localhost:3000/demo/traffic',
    'https://github.com/example/synthetic-repo',
    '[{"label": "Local Demo", "url": "http://localhost:3000/demo/traffic"}]'::jsonb,
    ARRAY['Citation A: Urban Grid Management Systems, 2025.'],
    '{"templateId": "media_rich", "featuredMedia": "video", "sectionOrder": ["video", "solution", "background"]}'::jsonb,
    'published',
    'd0000000-0000-0000-0000-000000000001',
    'group1-greenlight-traffic',
    'Approved during local synthetic seeding.',
    'No structural errors.'
  ),
  (
    'e0000000-0000-0000-0000-000000000002',
    '2026-medical-drone',
    'Smart Medical Drone Delivery',
    'medical-drone',
    'Automating high-speed delivery of critical medical parcels in rural regions.',
    'Medical centers in mountainous areas experience prolonged wait times for vital cargo.',
    'Designed an autonomous medical payload carrier utilizing static flight vectors.',
    2026,
    'a0000000-0000-0000-0000-000000000002',
    'Bachelor of Engineering',
    'Bachelor of Engineering',
    'Mechanical Engineering',
    'Healthcare',
    'Mountain Med-Kit Corp (Synthetic)',
    'Dr. Academic Supervisor B (Synthetic)',
    'AeroMed Delivery (Synthetic)',
    ARRAY['Synthetic Member 3', 'Synthetic Member 4'],
    'http://127.0.0.1:54321/storage/v1/object/public/project-public-assets/2026/aeromed/poster.png',
    'http://127.0.0.1:54321/storage/v1/object/public/project-public-assets/2026/aeromed/poster.pdf',
    'AeroMed Cargo Delivery. Safe mountain routing.',
    'Infographic depicting drone models with insulated internal temperature chambers.',
    ARRAY['http://127.0.0.1:54321/storage/v1/object/public/project-public-assets/2026/aeromed/snapshot1.png'],
    NULL,
    NULL,
    NULL,
    '[]'::jsonb,
    ARRAY[]::text[],
    '{"templateId": "poster_showcase", "featuredMedia": "poster", "sectionOrder": ["background", "solution"]}'::jsonb,
    'approved',
    'd0000000-0000-0000-0000-000000000001',
    'group2-aeromed-drone',
    'Approved locally.',
    NULL
  ),
  (
    'e0000000-0000-0000-0000-000000000003',
    '2026-agri-iot',
    'Agricultural IoT Hydration Roster',
    'agri-iot',
    'A wireless soil sensor grid optimizing irrigation thresholds for crops.',
    'Farming methods consume excessive water resources due to guess-based schedules.',
    'Engineered multi-node soil probes communicating over LoRa to automate crop valves.',
    2026,
    'a0000000-0000-0000-0000-000000000003',
    'Bachelor of IT',
    'Bachelor of IT',
    'IoT Systems',
    'Agriculture',
    'SmartCrop (Synthetic)',
    'Dr. Academic Supervisor C (Synthetic)',
    'HydroGrid Systems (Synthetic)',
    ARRAY['Synthetic Member 5'],
    'http://127.0.0.1:54321/storage/v1/object/authenticated/project-drafts-private/2026/hydrogrid/poster.png',
    'http://127.0.0.1:54321/storage/v1/object/authenticated/project-drafts-private/2026/hydrogrid/poster.pdf',
    'LoRa Soil Valve Control.',
    'Poster showcasing LoRa node hardware diagrams.',
    ARRAY[]::text[],
    NULL,
    NULL,
    NULL,
    '[]'::jsonb,
    ARRAY[]::text[],
    '{"templateId": "technical_detail", "featuredMedia": "snapshots", "sectionOrder": ["background"]}'::jsonb,
    'in_review',
    'd0000000-0000-0000-0000-000000000001',
    'group3-hydrogrid-sensors',
    'Pending review.',
    NULL
  ),
  (
    'e0000000-0000-0000-0000-000000000004',
    '2026-vr-rehab',
    'VR Rehabilitation Roster',
    'vr-rehab',
    'Gamified virtual environments to accelerate standard physical rehabilitation processes.',
    'Recovering patients experience low adherence to tedious standard exercise guidelines.',
    'Designed immersive target-hitting VR games that map to limb rotation guidelines.',
    2026,
    'a0000000-0000-0000-0000-000000000004',
    'Bachelor of Digital Media',
    'Bachelor of Digital Media',
    'Virtual Reality',
    'Healthcare',
    'Health-Vibe Clinic (Synthetic)',
    'Dr. Academic Supervisor D (Synthetic)',
    'NeuroVR Games (Synthetic)',
    ARRAY['Synthetic Member 6'],
    'http://127.0.0.1:54321/storage/v1/object/authenticated/project-drafts-private/2026/neurovr/poster.png',
    'http://127.0.0.1:54321/storage/v1/object/authenticated/project-drafts-private/2026/neurovr/poster.pdf',
    'Virtual Reality limb exercises.',
    'Poster showcasing headset configuration models.',
    ARRAY[]::text[],
    NULL,
    NULL,
    NULL,
    '[]'::jsonb,
    ARRAY[]::text[],
    '{"templateId": "poster_showcase", "featuredMedia": "poster", "sectionOrder": ["background"]}'::jsonb,
    'draft',
    'd0000000-0000-0000-0000-000000000001',
    'group4-neurovr-rehab',
    'Draft state.',
    NULL
  )
ON CONFLICT (id) DO NOTHING;

-- 4. Project Mapping Tables
INSERT INTO public.project_disciplines (project_id, discipline_id) VALUES
  ('e0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001'),
  ('e0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002'),
  ('e0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000003'),
  ('e0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000005'),
  ('e0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000007')
ON CONFLICT DO NOTHING;

INSERT INTO public.project_industry_categories (project_id, industry_category_id) VALUES
  ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001'),
  ('e0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002'),
  ('e0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000003'),
  ('e0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000002')
ON CONFLICT DO NOTHING;

-- 5. Media Assets Metadata
INSERT INTO public.media_assets (id, project_id, asset_type, file_name, storage_bucket, storage_path, public_url, mime_type, file_size_bytes, is_public_approved) VALUES
  (
    'f0000000-0000-0000-0000-000000000001',
    'e0000000-0000-0000-0000-000000000001',
    'poster_image',
    'poster.png',
    'project-public-assets',
    '2026/traffic-engine/poster.png',
    'http://127.0.0.1:54321/storage/v1/object/public/project-public-assets/2026/traffic-engine/poster.png',
    'image/png',
    1048576,
    true
  ),
  (
    'f0000000-0000-0000-0000-000000000002',
    'e0000000-0000-0000-0000-000000000002',
    'poster_image',
    'poster.png',
    'project-public-assets',
    '2026/aeromed/poster.png',
    'http://127.0.0.1:54321/storage/v1/object/public/project-public-assets/2026/aeromed/poster.png',
    'image/png',
    1048576,
    true
  )
ON CONFLICT (id) DO NOTHING;

COMMIT;
