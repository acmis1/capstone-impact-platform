import 'server-only';
import { createSupabaseAdminClient } from '../lib/supabase/admin';
import { SupabaseProjectRepositoryCore } from './SupabaseProjectRepositoryCore';

export class SupabaseProjectRepository extends SupabaseProjectRepositoryCore {
  constructor() {
    super(createSupabaseAdminClient());
  }
}
