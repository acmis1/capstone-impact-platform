import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Utility for backing up and restoring the full Admin/CMS state (db.json)
 * to a private Supabase Storage bucket.
 */

const getSupabaseClient = () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return null;
  return createClient(supabaseUrl, supabaseKey);
};

const BUCKET = process.env.SUPABASE_ADMIN_STATE_BUCKET || 'admin-state';
const FILE_NAME = process.env.SUPABASE_ADMIN_STATE_FILE || 'admin-db-latest.json';

/**
 * Backs up the local db.json to Supabase Storage
 */
export const backupAdminState = async (localDbPath) => {
  if (process.env.ENABLE_ADMIN_STATE_BACKUP !== 'true') {
    return { success: false, error: 'Admin state backup is disabled.' };
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase configuration missing.' };
  }

  try {
    if (!fs.existsSync(localDbPath)) {
      return { success: false, error: `Local database file not found: ${localDbPath}` };
    }

    const fileBuffer = fs.readFileSync(localDbPath);

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .upload(FILE_NAME, fileBuffer, {
        contentType: 'application/json',
        upsert: true
      });

    if (error) {
      return { success: false, error: `Backup failed: ${error.message}` };
    }

    return { 
      success: true, 
      timestamp: new Date().toISOString() 
    };
  } catch (err) {
    return { success: false, error: `Unexpected backup error: ${err.message}` };
  }
};

/**
 * Restores the local db.json from Supabase Storage
 */
export const restoreAdminState = async (localDbPath) => {
  if (process.env.ENABLE_ADMIN_STATE_BACKUP !== 'true') {
    return { success: false, error: 'Admin state backup is disabled.' };
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase configuration missing.' };
  }

  try {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(FILE_NAME);

    if (error) {
      return { success: false, error: `Restore failed: ${error.message}` };
    }

    const content = await data.text();
    const json = JSON.parse(content);

    if (!Array.isArray(json)) {
      return { success: false, error: 'Invalid backup format: Expected a JSON array.' };
    }

    fs.writeFileSync(localDbPath, JSON.stringify(json, null, 2));

    return { 
      success: true, 
      recordCount: json.length,
      timestamp: new Date().toISOString() 
    };
  } catch (err) {
    return { success: false, error: `Unexpected restore error: ${err.message}` };
  }
};

/**
 * Checks the status of the admin backup
 */
export const getAdminStateBackupStatus = async () => {
  if (process.env.ENABLE_ADMIN_STATE_BACKUP !== 'true') {
    return { enabled: false, message: 'Admin state backup is disabled in .env' };
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return { enabled: true, configured: false, message: 'Supabase keys missing.' };
  }

  try {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list('', {
        limit: 1,
        search: FILE_NAME
      });

    if (error) {
      return { enabled: true, configured: true, exists: false, error: error.message };
    }

    const file = data.find(f => f.name === FILE_NAME);
    
    return {
      enabled: true,
      configured: true,
      exists: !!file,
      lastModified: file ? file.updated_at : null,
      size: file ? file.metadata.size : null
    };
  } catch (err) {
    return { enabled: true, configured: true, error: err.message };
  }
};
