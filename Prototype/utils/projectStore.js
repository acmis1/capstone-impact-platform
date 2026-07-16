import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSupabaseKey, verifyProjectRef } from './authHelper.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = getSupabaseKey();
const expectedRef = process.env.SUPABASE_EXPECTED_PROJECT_REF;

const verification = verifyProjectRef(supabaseUrl, expectedRef);

// Only initialize Supabase client if verification succeeds
const supabase = (verification === 'TARGET_MATCH' && supabaseUrl && supabaseKey) 
  ? createClient(supabaseUrl, supabaseKey) 
  : null;

/**
 * Enforces the target safety checks before executing any database or storage writes.
 */
function enforceClient() {
  if (verification !== 'TARGET_MATCH') {
    throw new Error(verification === 'TARGET_CONFIGURATION_MISSING' ? 'TARGET_CONFIGURATION_MISSING' : 'TARGET_MISMATCH');
  }
  if (!supabase) {
    throw new Error('SUPABASE_CLIENT_UNAVAILABLE');
  }
}

/**
 * Returns all project records from the Supabase database.
 * Returns the inner 'data' objects which contain the full project record.
 */
export async function getProjects() {
  enforceClient();
  
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('id', { ascending: true });

  if (error) throw new Error('DATABASE_READ_FAILED');
  
  return data.map(record => record.data);
}

/**
 * Returns a single project record by ID.
 */
export async function getProjectById(id) {
  enforceClient();
  
  const { data, error } = await supabase
    .from('projects')
    .select('data')
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    throw new Error('DATABASE_READ_FAILED');
  }
  
  return data.data;
}

/**
 * Creates a new project record.
 */
export async function createProject(project) {
  enforceClient();
  
  const record = {
    id: project.id,
    data: project,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('projects')
    .insert([record])
    .select()
    .single();

  if (error) throw new Error('DATABASE_WRITE_FAILED');
  return data.data;
}

/**
 * Updates a project record (partial patch).
 */
export async function updateProject(id, patch) {
  enforceClient();
  
  const existing = await getProjectById(id);
  if (!existing) throw new Error('PROJECT_NOT_FOUND');

  const updatedProject = {
    ...existing,
    ...patch,
    lastUpdated: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('projects')
    .update({ 
      data: updatedProject,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error('DATABASE_WRITE_FAILED');
  return data.data;
}

/**
 * Replaces a project record entirely.
 */
export async function replaceProject(id, fullRecord) {
  enforceClient();
  
  const { data, error } = await supabase
    .from('projects')
    .update({ 
      data: fullRecord,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error('DATABASE_WRITE_FAILED');
  return data.data;
}

/**
 * Creates or replaces a full project record without regenerating public feeds.
 */
export async function upsertProject(project) {
  enforceClient();

  const record = {
    id: project.id,
    data: project,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('projects')
    .upsert(record, { onConflict: 'id' })
    .select()
    .single();

  if (error) throw new Error('DATABASE_WRITE_FAILED');
  return data.data;
}

/**
 * Uploads an import asset to the configured Supabase Storage bucket.
 */
export async function uploadProjectAsset(storagePath, buffer, contentType) {
  enforceClient();

  const bucketName = process.env.SUPABASE_ASSET_BUCKET || 'project-assets';
  const { error } = await supabase.storage
    .from(bucketName)
    .upload(storagePath, buffer, {
      contentType,
      upsert: true
    });

  if (error) throw new Error('STORAGE_UPLOAD_FAILED');

  const { data: { publicUrl } } = supabase.storage
    .from(bucketName)
    .getPublicUrl(storagePath);

  return publicUrl;
}

/**
 * Seeds the projects table if it is currently empty.
 * Returns true if seeding occurred, false otherwise.
 */
export async function seedProjectsIfEmpty(seedProjects) {
  // If verification fails, block database check
  enforceClient();

  const { count, error: countError } = await supabase
    .from('projects')
    .select('*', { count: 'exact', head: true });

  if (countError) {
    throw new Error('DATABASE_READ_FAILED');
  }

  if (count === 0 && seedProjects && seedProjects.length > 0) {
    const records = seedProjects.map(p => ({
      id: p.id,
      data: p,
      updated_at: new Date().toISOString()
    }));

    const { error: insertError } = await supabase
      .from('projects')
      .insert(records);

    if (insertError) {
      throw new Error('DATABASE_WRITE_FAILED');
    }
    return true;
  }

  return false;
}

/**
 * Generates the public projects list (stripped of internal fields).
 */
export async function generatePublicProjects() {
  const projects = await getProjects();
  
  return projects
    .filter(p => p.status === 'approved' || p.status === 'published')
    .map(({ 
      status, 
      internalNotes, 
      reviewNotes, 
      missingItems, 
      previewUrl, 
      previewSentAt, 
      studentConfirmedAt, 
      publishedAt, 
      archivedAt, 
      archiveReason,
      validationFlags, 
      ocrStatus, 
      adminId, 
      validationErrors, 
      validationWarnings, 
      staffNotes, 
      privateNotes, 
      lastUpdated, 
      importBatchId,
      sourceFolder,
      sampleImportId,
      packageValidation,
      pendingRemovalFromPublic,
      publicRemovalCompletedAt,
      archivedFromStatus,
      ...publicFields 
    }) => publicFields);
}

/**
 * Deletes a project record by ID. Safety checks are enforced by the caller.
 */
export async function deleteProject(id) {
  enforceClient();

  const { data, error } = await supabase
    .from('projects')
    .delete()
    .eq('id', id)
    .select('data')
    .maybeSingle();

  if (error) throw new Error('DATABASE_WRITE_FAILED');
  return data ? { success: true, project: data.data } : { success: false, project: null };
}
