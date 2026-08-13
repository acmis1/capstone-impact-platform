import 'server-only';
import { createSupabaseAdminClient } from '../lib/supabase/admin';
import { SupabaseParticipantPreviewReminderRepositoryCore } from './SupabaseParticipantPreviewReminderRepositoryCore';

export class SupabaseParticipantPreviewReminderRepository
  extends SupabaseParticipantPreviewReminderRepositoryCore {
  constructor() {
    super(createSupabaseAdminClient());
  }
}
