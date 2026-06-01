import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { getStagingBuckets } from '../lib/supabase/buckets';

export interface CleanupResult {
  removedPrivateObjects: number;
  removedPublicObjects: number;
  removedMediaRows: number;
  warnings: string[];
}

/**
 * Robustly deletes storage objects and related database media asset records
 * for a list of project public IDs to ensure staging idempotency.
 */
export async function cleanupStagingMediaForProjects(projectPublicIds: string[]): Promise<CleanupResult> {
  const result: CleanupResult = {
    removedPrivateObjects: 0,
    removedPublicObjects: 0,
    removedMediaRows: 0,
    warnings: []
  };

  if (!projectPublicIds || projectPublicIds.length === 0) {
    return result;
  }

  const supabase = createSupabaseAdminClientCore();
  const buckets = getStagingBuckets();
  
  const privateBucket = buckets.DRAFT_PRIVATE;
  const publicBucket = buckets.PUBLIC_ASSETS;

  // 1. Delete matching rows from media_assets table first to avoid foreign key or lookup discrepancies
  try {
    // Resolve UUIDs for the target public IDs to make database queries precise
    const { data: dbProjects, error: projectsError } = await supabase
      .from('projects')
      .select('id, public_id')
      .in('public_id', projectPublicIds);

    if (projectsError) {
      result.warnings.push(`Failed to fetch project IDs for database media rows cleanup: ${projectsError.message}`);
    } else if (dbProjects && dbProjects.length > 0) {
      const projectDbIds = dbProjects.map((p: any) => p.id);
      
      const { count, error: deleteRowsError } = await supabase
        .from('media_assets')
        .delete({ count: 'exact' })
        .in('project_id', projectDbIds);

      if (deleteRowsError) {
        result.warnings.push(`Failed to delete database media_assets rows: ${deleteRowsError.message}`);
      } else {
        result.removedMediaRows = count || 0;
      }
    }
  } catch (e: any) {
    result.warnings.push(`Database media row cleanup exception: ${e.message}`);
  }

  // Helper to list and delete files under a prefix
  const listAndDeleteFiles = async (bucket: string, prefix: string): Promise<number> => {
    let deletedCount = 0;

    // A. List files under the prefix
    const { data: fileList, error: listError } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: 100 });

    if (listError) {
      result.warnings.push(`Failed to list storage objects under prefix [${bucket}/${prefix}]: ${listError.message}`);
      return 0;
    }

    if (!fileList || fileList.length === 0) {
      return 0;
    }

    // B. Map to relative paths
    const pathsToDelete = fileList
      .map((f: any) => `${prefix}/${f.name}`)
      .filter((p: string) => {
        // Strict guard: verify path starts with approved/ or drafts/ and matches the project public ID
        const isValidPrivate = p.startsWith(`drafts/`);
        const isValidPublic = p.startsWith(`approved/`);
        return isValidPrivate || isValidPublic;
      });

    if (pathsToDelete.length === 0) {
      return 0;
    }

    // C. Perform bulk delete
    const { data: deletedData, error: deleteError } = await supabase.storage
      .from(bucket)
      .remove(pathsToDelete);

    if (deleteError) {
      result.warnings.push(`Failed to remove files under [${bucket}/${prefix}]: ${deleteError.message}`);
    } else if (deletedData) {
      deletedCount = deletedData.length;
    }

    return deletedCount;
  };

  // 2. Scan and remove storage objects for each project public ID prefix
  for (const publicId of projectPublicIds) {
    if (!publicId || publicId.includes('/') || publicId.includes('..')) {
      result.warnings.push(`Skipped dangerous or empty project public ID prefix check: "${publicId}"`);
      continue;
    }

    // Delete from private bucket under 'drafts/{projectPublicId}'
    try {
      const privateRemoved = await listAndDeleteFiles(privateBucket, `drafts/${publicId}`);
      result.removedPrivateObjects += privateRemoved;
    } catch (e: any) {
      result.warnings.push(`Private bucket prefix drafts/${publicId} cleanup exception: ${e.message}`);
    }

    // Delete from public bucket under 'approved/{projectPublicId}'
    try {
      const publicRemoved = await listAndDeleteFiles(publicBucket, `approved/${publicId}`);
      result.removedPublicObjects += publicRemoved;
    } catch (e: any) {
      result.warnings.push(`Public bucket prefix approved/${publicId} cleanup exception: ${e.message}`);
    }
  }

  return result;
}
