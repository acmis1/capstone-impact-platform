import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('Supabase configuration missing (SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY). DB operations will fail.');
}

const supabase = (supabaseUrl && supabaseServiceKey) 
  ? createClient(supabaseUrl, supabaseServiceKey) 
  : null;

/**
 * Returns all project records from the Supabase database.
 * Returns the inner 'data' objects which contain the full project record.
 */
export async function getProjects() {
  if (!supabase) throw new Error('Supabase client not initialized');
  
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('id', { ascending: true });

  if (error) throw error;
  
  // Return the inner data objects which match the App.jsx expectation
  return data.map(record => record.data);
}

/**
 * Returns a single project record by ID.
 */
export async function getProjectById(id) {
  if (!supabase) throw new Error('Supabase client not initialized');
  
  const { data, error } = await supabase
    .from('projects')
    .select('data')
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    throw error;
  }
  
  return data.data;
}

/**
 * Creates a new project record.
 */
export async function createProject(project) {
  if (!supabase) throw new Error('Supabase client not initialized');
  
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

  if (error) throw error;
  return data.data;
}

/**
 * Updates a project record (partial patch).
 */
export async function updateProject(id, patch) {
  if (!supabase) throw new Error('Supabase client not initialized');
  
  // First get the existing record to merge
  const existing = await getProjectById(id);
  if (!existing) throw new Error(`Project ${id} not found`);

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

  if (error) throw error;
  return data.data;
}

/**
 * Replaces a project record entirely.
 */
export async function replaceProject(id, fullRecord) {
  if (!supabase) throw new Error('Supabase client not initialized');
  
  const { data, error } = await supabase
    .from('projects')
    .update({ 
      data: fullRecord,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data.data;
}

/**
 * Creates or replaces a full project record without regenerating public feeds.
 */
export async function upsertProject(project) {
  if (!supabase) throw new Error('Supabase client not initialized');

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

  if (error) throw error;
  return data.data;
}

/**
 * Uploads an import asset to the configured Supabase Storage bucket.
 */
export async function uploadProjectAsset(storagePath, buffer, contentType) {
  if (!supabase) throw new Error('Supabase client not initialized');

  const bucketName = process.env.SUPABASE_ASSET_BUCKET || 'project-assets';
  const { error } = await supabase.storage
    .from(bucketName)
    .upload(storagePath, buffer, {
      contentType,
      upsert: true
    });

  if (error) throw error;

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
  if (!supabase) return false;

  const { count, error: countError } = await supabase
    .from('projects')
    .select('*', { count: 'exact', head: true });

  if (countError) {
    console.error('Error checking project count for seeding:', countError);
    return false;
  }

  if (count === 0 && seedProjects && seedProjects.length > 0) {
    console.log(`Supabase 'projects' table is empty. Seeding ${seedProjects.length} records...`);
    
    const records = seedProjects.map(p => ({
      id: p.id,
      data: p,
      updated_at: new Date().toISOString()
    }));

    const { error: insertError } = await supabase
      .from('projects')
      .insert(records);

    if (insertError) {
      console.error('Error seeding projects:', insertError);
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Generates the public projects list (stripped of internal fields).
 * Similar to generatePublicFeed in server.js but using Supabase.
 */
export async function generatePublicProjects() {
  const projects = await getProjects();
  
  // Strip internal fields and filter by status
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
      archivedFromStatus,
      ...publicFields 
    }) => publicFields);
}

/**
 * Deletes a project record by ID. Safety checks are enforced by the caller.
 */
export async function deleteProject(id) {
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('projects')
    .delete()
    .eq('id', id)
    .select('data')
    .maybeSingle();

  if (error) throw error;
  return data ? { success: true, project: data.data } : { success: false, project: null };
}
