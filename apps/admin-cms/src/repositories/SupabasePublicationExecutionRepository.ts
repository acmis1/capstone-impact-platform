import 'server-only';
import { getServerEnv } from '../lib/env';
import { createSupabaseAdminClient } from '../lib/supabase/admin';
import { SupabasePublicationExecutionRepositoryCore } from './SupabasePublicationExecutionRepositoryCore';

export class SupabasePublicationExecutionRepository extends SupabasePublicationExecutionRepositoryCore {
  constructor() {
    super(createSupabaseAdminClient(), getServerEnv().supabaseUrl);
  }
}
