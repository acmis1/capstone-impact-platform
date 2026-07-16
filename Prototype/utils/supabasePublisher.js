import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import * as dotenv from 'dotenv';
import { getSupabaseKey, verifyProjectRef } from './authHelper.js';

dotenv.config();

/**
 * Publishes a local file to Supabase Storage.
 * This is a backend-only utility.
 */
export const publishToCloud = async (localFilePath) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = getSupabaseKey();
  const bucketName = process.env.SUPABASE_FEED_BUCKET || 'feeds';
  const fileName = process.env.SUPABASE_FEED_FILE || 'capstones-latest.json';
  const expectedRef = process.env.SUPABASE_EXPECTED_PROJECT_REF;

  const verification = verifyProjectRef(supabaseUrl, expectedRef);
  if (verification !== 'TARGET_MATCH') {
    return { 
      success: false, 
      error: verification === 'TARGET_CONFIGURATION_MISSING' ? 'TARGET_CONFIGURATION_MISSING' : 'TARGET_MISMATCH' 
    };
  }

  if (!supabaseUrl || !supabaseKey) {
    return { success: false, error: 'SUPABASE_CLIENT_UNAVAILABLE' };
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    const fileBuffer = fs.readFileSync(localFilePath);

    const { error } = await supabase.storage
      .from(bucketName)
      .upload(fileName, fileBuffer, {
        contentType: 'application/json',
        upsert: true
      });

    if (error) {
      return { success: false, error: 'FEED_UPLOAD_FAILED' };
    }

    const { data: { publicUrl } } = supabase.storage
      .from(bucketName)
      .getPublicUrl(fileName);

    return { 
      success: true, 
      publicUrl, 
      timestamp: new Date().toISOString() 
    };
  } catch (err) {
    return { 
      success: false, 
      error: 'FEED_UPLOAD_FAILED' 
    };
  }
};

/**
 * Fetches the current published feed status from Supabase Storage.
 * It reads the stable file and returns exists, count, lastPublished timestamp, and publicUrl.
 */
export const getPublishedFeedStatus = async () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = getSupabaseKey();
  const bucketName = process.env.SUPABASE_FEED_BUCKET || 'feeds';
  const fileName = process.env.SUPABASE_FEED_FILE || 'capstones-latest.json';
  const expectedRef = process.env.SUPABASE_EXPECTED_PROJECT_REF;

  const verification = verifyProjectRef(supabaseUrl, expectedRef);
  if (verification !== 'TARGET_MATCH') {
    return { 
      exists: false, 
      error: verification === 'TARGET_CONFIGURATION_MISSING' ? 'TARGET_CONFIGURATION_MISSING' : 'TARGET_MISMATCH' 
    };
  }

  if (!supabaseUrl || !supabaseKey) {
    return { exists: false, error: 'SUPABASE_CLIENT_UNAVAILABLE' };
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: files, error: listError } = await supabase.storage
      .from(bucketName)
      .list();

    if (listError) {
      return { exists: false, error: 'FEED_STATUS_READ_FAILED' };
    }

    const fileMeta = files.find(f => f.name === fileName);
    if (!fileMeta) {
      return { exists: false };
    }

    const { data: blob, error: downloadError } = await supabase.storage
      .from(bucketName)
      .download(fileName);

    if (downloadError) {
      return { exists: false, error: 'FEED_STATUS_READ_FAILED' };
    }

    const text = await blob.text();
    const content = JSON.parse(text);

    const { data: { publicUrl } } = supabase.storage
      .from(bucketName)
      .getPublicUrl(fileName);

    return {
      exists: true,
      count: Array.isArray(content) ? content.length : 0,
      lastPublished: fileMeta.updated_at || fileMeta.created_at || new Date().toISOString(),
      publicUrl
    };
  } catch (err) {
    return { 
      exists: false, 
      error: 'FEED_STATUS_READ_FAILED' 
    };
  }
};
