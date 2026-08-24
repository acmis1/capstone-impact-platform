import { getServerEnv } from '../lib/env';

import {
  isLoopbackUrl,
} from '../local-development/localEnvironmentFile';

import {
  SupabaseFeedHistoryRepository,
} from '../repositories/SupabaseFeedHistoryRepository';

import {
  downloadCanonicalPublicFeed,
  uploadExactCanonicalPublicFeed,
} from '../storage/publicFeedStorage';

import type {
  LocalFeedRollbackExecutionDependencies,
} from './localFeedRollbackExecution';

export function createLocalFeedRollbackDependencies():
  LocalFeedRollbackExecutionDependencies {
  const repository =
    new SupabaseFeedHistoryRepository();

  return {
    getVersion:
      repository.getVersion.bind(
        repository,
      ),

    recorder: repository,

    storage: {
      download:
        downloadCanonicalPublicFeed,

      uploadExact:
        uploadExactCanonicalPublicFeed,
    },

    isLocalExecutionAvailable() {
      const env = getServerEnv();

      return isLoopbackUrl(
        env.supabaseUrl,
      );
    },
  };
}