import { seedLocalSupabaseFixtures } from '../local-development/localSupabaseFixtures';

async function main() {
  try {
    const result = await seedLocalSupabaseFixtures();
    console.log('✅ Local Supabase storage buckets and synthetic fixtures verified.');
    console.log(`Buckets verified: ${result.bucketsVerified.join(', ')}`);
    console.log(`Fixtures uploaded: ${result.fixturesUploaded.length}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Local fixture seeding failed.';
    console.error(`❌ Local fixture seeding failed: ${msg}`);
    process.exit(1);
  }
}

main();
