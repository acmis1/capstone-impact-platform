import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { createSupabaseAdminClient } from '../lib/supabase/admin';

const fakeProjects = [
  {
    public_id: '2026-runtime-demo-approved',
    title: 'Staging Approved Showcase Project',
    slug: 'staging-approved-showcase-project',
    summary: 'A comprehensive staging test case representing an approved project state.',
    background: 'This is the problem background for the approved showcase case. Detailed and descriptive.',
    solution: 'This is the solution developed for the approved showcase case. Fully functional and validated.',
    year: 2026,
    program_name: 'Bachelor of Software Engineering',
    study_program: 'BP096',
    discipline: 'Software Engineering',
    industry: 'Technology',
    industry_partner: 'RMIT School of Science',
    academic_supervisor: 'Dr. Staging Supervisor',
    group_name: 'Team Staging Alpha',
    team_members: ['Student Alice', 'Student Bob'],
    poster_url: 'https://jtwpsprlcxpzotppsoqq.supabase.co/storage/v1/object/public/project-public-assets/poster_approved.jpg',
    poster_pdf_url: 'https://jtwpsprlcxpzotppsoqq.supabase.co/storage/v1/object/public/project-public-assets/poster_approved.pdf',
    poster_text_public: 'This is the indexed poster text content for search matching.',
    accessibility_text_public: 'A green poster detailing the software engineering project architecture diagram.',
    snapshots: ['https://placehold.co/600x400/png', 'https://placehold.co/600x400/png'],
    video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    demo_url: 'https://example.com/demo',
    repository_url: 'https://github.com/example/repo',
    external_links: [{ label: 'Project Home', url: 'https://example.com' }],
    citations: ['Staging Academic Citation 2026'],
    layout_config: {
      templateId: 'poster_showcase',
      featuredMedia: 'poster',
      sectionOrder: ['background', 'solution', 'snapshots', 'video', 'links']
    },
    status: 'approved'
  },
  {
    public_id: '2026-runtime-demo-published',
    title: 'Staging Published Showcase Project',
    slug: 'staging-published-showcase-project',
    summary: 'A comprehensive staging test case representing a published project state.',
    background: 'This is the problem background for the published showcase case. Detailed and descriptive.',
    solution: 'This is the solution developed for the published showcase case. Fully functional and validated.',
    year: 2026,
    program_name: 'Bachelor of Computer Science',
    study_program: 'BP094',
    discipline: 'Computer Science',
    industry: 'Technology',
    industry_partner: 'RMIT School of Computing',
    academic_supervisor: 'Dr. Staging Advisor',
    group_name: 'Team Staging Beta',
    team_members: ['Student Charlie', 'Student Diane'],
    poster_url: 'https://jtwpsprlcxpzotppsoqq.supabase.co/storage/v1/object/public/project-public-assets/poster_published.jpg',
    poster_pdf_url: 'https://jtwpsprlcxpzotppsoqq.supabase.co/storage/v1/object/public/project-public-assets/poster_published.pdf',
    poster_text_public: 'This is the indexed poster text content for published showcase matching.',
    accessibility_text_public: 'A blue poster detailing the cloud machine learning model parameters.',
    snapshots: ['https://placehold.co/600x400/png'],
    video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    demo_url: 'https://example.com/demo2',
    repository_url: 'https://github.com/example/repo2',
    external_links: [{ label: 'Project Docs', url: 'https://example.com/docs' }],
    citations: ['Staging Academic Citation 2026 - CS'],
    layout_config: {
      templateId: 'technical_detail',
      featuredMedia: 'snapshots',
      sectionOrder: ['solution', 'background', 'snapshots', 'video', 'links']
    },
    status: 'published'
  },
  {
    public_id: '2026-runtime-demo-review',
    title: 'Staging Under-Review Project',
    slug: 'staging-under-review-project',
    summary: 'A staging project currently undergoing coordinator or supervisor review.',
    background: 'This is the problem background for the under-review case.',
    solution: 'This is the solution developed for the under-review case.',
    year: 2026,
    program_name: 'Bachelor of Information Technology',
    study_program: 'BP162',
    discipline: 'Information Technology',
    industry: 'Business',
    industry_partner: 'RMIT School of Business',
    academic_supervisor: 'Dr. Staging IT Reviewer',
    group_name: 'Team Staging Gamma',
    team_members: ['Student Evan', 'Student Fiona'],
    poster_url: 'https://jtwpsprlcxpzotppsoqq.supabase.co/storage/v1/object/public/project-public-assets/poster_review.jpg',
    poster_pdf_url: 'https://jtwpsprlcxpzotppsoqq.supabase.co/storage/v1/object/public/project-public-assets/poster_review.pdf',
    poster_text_public: 'This is the review poster text.',
    accessibility_text_public: 'An orange poster detailing cybersecurity threat vectors.',
    snapshots: [],
    video_url: '',
    demo_url: '',
    repository_url: '',
    external_links: [],
    citations: [],
    layout_config: {
      templateId: 'media_rich',
      featuredMedia: 'video',
      sectionOrder: ['background', 'solution']
    },
    status: 'in_review'
  },
  {
    public_id: '2026-runtime-demo-archived',
    title: 'Staging Archived Showcase Project',
    slug: 'staging-archived-showcase-project',
    summary: 'A staging project representing an archived legacy showcase project.',
    background: 'Archived case background.',
    solution: 'Archived case solution.',
    year: 2025,
    program_name: 'Bachelor of Software Engineering',
    study_program: 'BP096',
    discipline: 'Software Engineering',
    industry: 'Industrial',
    industry_partner: 'RMIT School of Science',
    academic_supervisor: 'Dr. Staging Archivist',
    group_name: 'Team Staging Delta',
    team_members: ['Student George', 'Student Hannah'],
    poster_url: 'https://jtwpsprlcxpzotppsoqq.supabase.co/storage/v1/object/public/project-public-assets/poster_archived.jpg',
    poster_pdf_url: 'https://jtwpsprlcxpzotppsoqq.supabase.co/storage/v1/object/public/project-public-assets/poster_archived.pdf',
    poster_text_public: 'Archived poster text.',
    accessibility_text_public: 'A grey poster detailing robotics hardware schematics.',
    snapshots: [],
    video_url: '',
    demo_url: '',
    repository_url: '',
    external_links: [],
    citations: [],
    layout_config: {
      templateId: 'poster_showcase',
      featuredMedia: 'poster',
      sectionOrder: ['background']
    },
    status: 'archived',
    archived_at: new Date().toISOString(),
    archive_reason: 'Archived due to age guidelines.'
  }
];

async function seed() {
  const supabase = createSupabaseAdminClient();
  const idsToDelete = fakeProjects.map((p) => p.public_id);

  console.log('Seeding staging database with fake projects...');
  
  // 1. Delete existing mock cases for clean re-run safety
  const { error: deleteError } = await supabase
    .from('projects')
    .delete()
    .in('public_id', idsToDelete);

  if (deleteError) {
    console.error('❌ Error clearing existing mock projects:', deleteError.message);
    process.exit(1);
  }

  // 2. Insert fake staging cases
  const { data, error: insertError } = await supabase
    .from('projects')
    .insert(fakeProjects)
    .select('public_id, status');

  if (insertError) {
    console.error('❌ Error seeding fake staging projects:', insertError.message);
    process.exit(1);
  }

  console.log('✅ Successfully seeded fake staging projects!');
  console.log('Seeded projects details:');
  data.forEach((p) => {
    console.log(` - ID: ${p.public_id} [Status: ${p.status}]`);
  });
}

seed();
