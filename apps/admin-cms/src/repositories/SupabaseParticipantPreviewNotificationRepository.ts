import 'server-only';
import { createSupabaseAdminClient } from '../lib/supabase/admin';
import { SupabaseParticipantPreviewNotificationRepositoryCore } from './SupabaseParticipantPreviewNotificationRepositoryCore';

export class SupabaseParticipantPreviewNotificationRepository extends SupabaseParticipantPreviewNotificationRepositoryCore {
  constructor() {
    super(createSupabaseAdminClient());
  }
}
