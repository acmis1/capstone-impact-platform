import 'server-only';
import { createSupabaseAdminClient } from '../lib/supabase/admin';
import { ImportBatchRepositoryCore } from './ImportBatchRepositoryCore';

export class ImportBatchRepository extends ImportBatchRepositoryCore {
  constructor() {
    super(createSupabaseAdminClient());
  }
}
