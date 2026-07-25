import { provisionLocalStaffUsers } from '../local-development/localStaffUsers';

async function main() {
  const args = process.argv.slice(2);
  let credentialsOutputPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--credentials-output' && i + 1 < args.length) {
      credentialsOutputPath = args[i + 1];
      i++;
    }
  }

  try {
    const result = await provisionLocalStaffUsers({ credentialsOutputPath });
    console.log('✅ Local synthetic staff users successfully provisioned.');
    console.log(`Credentials file: ${result.credentialsPath}`);
    console.log('Roles assigned:');
    for (const r of result.provisionedRoles) {
      console.log(`  - ${r}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Local staff user provisioning failed: ${msg}`);
    process.exit(1);
  }
}

main();
