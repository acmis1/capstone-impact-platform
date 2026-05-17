import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Publishes a local file to Supabase Storage.
 * This is a backend-only utility.
 */
export const publishToCloud = async (localFilePath) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucketName = process.env.SUPABASE_FEED_BUCKET || 'feeds';
  const fileName = process.env.SUPABASE_FEED_FILE || 'capstones-latest.json';

  // 1. Validation
  if (!supabaseUrl || !supabaseKey) {
    return { 
      success: false, 
      error: 'Supabase configuration missing. Please check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your .env file.' 
    };
  }

  try {
    // 2. Initialize Supabase
    const supabase = createClient(supabaseUrl, supabaseKey);
    const fileBuffer = fs.readFileSync(localFilePath);

    // 3. Upload/Overwrite
    const { data, error } = await supabase.storage
      .from(bucketName)
      .upload(fileName, fileBuffer, {
        contentType: 'application/json',
        upsert: true
      });

    if (error) {
      return { success: false, error: `Supabase Upload Error: ${error.message}` };
    }

    // 4. Construct Public URL Safely using SDK
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
      error: `Unexpected Publisher Error: ${err.message}` 
    };
  }
};

/**
 * Fetches the current published feed status from Supabase Storage.
 * It reads the stable file and returns exists, count, lastPublished timestamp, and publicUrl.
 */
export const getPublishedFeedStatus = async () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucketName = process.env.SUPABASE_FEED_BUCKET || 'feeds';
  const fileName = process.env.SUPABASE_FEED_FILE || 'capstones-latest.json';

  if (!supabaseUrl || !supabaseKey) {
    return { 
      exists: false, 
      error: 'Supabase configuration missing.' 
    };
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: files, error: listError } = await supabase.storage
      .from(bucketName)
      .list();

    if (listError) {
      return { exists: false, error: listError.message };
    }

    const fileMeta = files.find(f => f.name === fileName);
    if (!fileMeta) {
      return { exists: false };
    }

    const { data: blob, error: downloadError } = await supabase.storage
      .from(bucketName)
      .download(fileName);

    if (downloadError) {
      return { exists: false, error: downloadError.message };
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
      error: err.message 
    };
  }
};

