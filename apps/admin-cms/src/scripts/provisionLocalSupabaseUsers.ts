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
    await provisionLocalStaffUsers({ credentialsOutputPath });
    console.log('✅ Local synthetic staff users successfully provisioned.');
    console.log('Local development accounts provisioned.');
  } catch (err: unknown) {
    const msg = 'Local account provisioning failed.';
    console.error(`❌ Local staff user provisioning failed: ${msg}`);
    process.exit(1);
  }
}

main();
