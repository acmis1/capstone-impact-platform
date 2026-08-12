import 'server-only';
import { createSupabaseAdminClient } from '../lib/supabase/admin';
import { SupabaseParticipantPreviewRepositoryCore } from './SupabaseParticipantPreviewRepositoryCore';

export class SupabaseParticipantPreviewRepository extends SupabaseParticipantPreviewRepositoryCore {
  constructor() {
    super(createSupabaseAdminClient());
  }
}
