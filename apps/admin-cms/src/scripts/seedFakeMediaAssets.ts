import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { uploadDraftMediaAsset, promoteDraftMediaAssetToPublic } from '../storage/mediaStorage';

async function seedMedia() {
  const supabase = createSupabaseAdminClientCore();

  console.log('Verifying staging projects exist...');
  const { data: projects, error: projectsError } = await supabase
    .from('projects')
    .select('id, public_id, status');

  if (projectsError) {
    console.error('❌ Failed to fetch projects:', projectsError.message);
    process.exit(1);
  }

  if (!projects || projects.length === 0) {
    console.error('❌ No staging projects found. Please run "npm run seed:staging" first.');
    process.exit(1);
  }

  const approvedProject = projects.find((p) => p.status === 'approved');
  const publishedProject = projects.find((p) => p.status === 'published');

  if (!approvedProject || !publishedProject) {
    console.error('❌ Could not find both "approved" and "published" showcase mock projects in database.');
    process.exit(1);
  }

  console.log('Clearing existing media_assets rows for idempotency...');
  const { error: deleteError } = await supabase
    .from('media_assets')
    .delete()
    .in('project_id', [approvedProject.id, publishedProject.id]);

  if (deleteError) {
    console.error('❌ Failed to clean up legacy media assets:', deleteError.message);
    process.exit(1);
  }

  // --- 1. SEED APPROVED PROJECT MEDIA (Poster Image + Poster PDF) ---
  console.log('\n--- Seeding Media for Approved Staging Showcase ---');
  
  // A. Fake PNG Buffer (1x1 pixel transparent PNG)
  const fakePng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  // B. Fake PDF Buffer
  const fakePdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');

  // Upload private drafts
  const draftPosterImage = await uploadDraftMediaAsset({
    projectPublicId: approvedProject.public_id,
    projectDbId: approvedProject.id,
    assetType: 'poster_image',
    fileName: 'staging-poster-showcase.png',
    content: fakePng,
    mimeType: 'image/png'
  });

  const draftPosterPdf = await uploadDraftMediaAsset({
    projectPublicId: approvedProject.public_id,
    projectDbId: approvedProject.id,
    assetType: 'poster_pdf',
    fileName: 'staging-poster-document.pdf',
    content: fakePdf,
    mimeType: 'application/pdf'
  });

  console.log('Draft media assets successfully uploaded privately.');

  // Promote both to public assets
  const publicPosterImage = await promoteDraftMediaAssetToPublic(draftPosterImage.id);
  const publicPosterPdf = await promoteDraftMediaAssetToPublic(draftPosterPdf.id);

  console.log('Draft media assets successfully promoted to public showcase.');

  // Update approved project records
  console.log('Linking public URLs back to approved project record...');
  const { error: updateApprovedError } = await supabase
    .from('projects')
    .update({
      poster_url: publicPosterImage.publicUrl,
      poster_pdf_url: publicPosterPdf.publicUrl
    })
    .eq('id', approvedProject.id);

  if (updateApprovedError) {
    console.error('❌ Failed to update approved project with media URLs:', updateApprovedError.message);
    process.exit(1);
  }

  // --- 2. SEED PUBLISHED PROJECT MEDIA (Snapshot Image) ---
  console.log('\n--- Seeding Media for Published Staging Showcase ---');

  const draftSnapshotImage = await uploadDraftMediaAsset({
    projectPublicId: publishedProject.public_id,
    projectDbId: publishedProject.id,
    assetType: 'snapshot_image',
    fileName: 'staging-snapshot-one.png',
    content: fakePng,
    mimeType: 'image/png'
  });

  console.log('Draft snapshot asset uploaded privately.');

  const publicSnapshotImage = await promoteDraftMediaAssetToPublic(draftSnapshotImage.id);
  console.log('Snapshot successfully promoted to public showcase.');

  // Update published project records
  console.log('Linking snapshot URL back to published project record...');
  const { error: updatePublishedError } = await supabase
    .from('projects')
    .update({
      snapshots: [publicSnapshotImage.publicUrl]
    })
    .eq('id', publishedProject.id);

  if (updatePublishedError) {
    console.error('❌ Failed to update published project with snapshot array:', updatePublishedError.message);
    process.exit(1);
  }

  console.log('\n====================================================');
  console.log('✅ STAGING WORKSPACE MEDIA SEEDING COMPLETED!');
  console.log('====================================================');
  console.log(`Approved poster URL:     ${publicPosterImage.publicUrl}`);
  console.log(`Approved poster PDF URL: ${publicPosterPdf.publicUrl}`);
  console.log(`Published snapshot URL:  ${publicSnapshotImage.publicUrl}`);
  console.log('====================================================\n');
}

seedMedia();
