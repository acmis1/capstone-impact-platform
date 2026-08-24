import 'server-only';

import { createSupabaseAdminClient } from '../lib/supabase/admin';
import { SupabaseFeedHistoryRepositoryCore } from './SupabaseFeedHistoryRepositoryCore';

export class SupabaseFeedHistoryRepository
  extends SupabaseFeedHistoryRepositoryCore {
  constructor() {
    super(createSupabaseAdminClient());
  }
}