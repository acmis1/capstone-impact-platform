import { generateLocalEnvironmentFile } from '../local-development/localEnvironmentFile';

function main() {
  const args = process.argv.slice(2);
  let outputPath: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && i + 1 < args.length) {
      outputPath = args[i + 1];
      i++;
    } else if (args[i] === '--force-local') {
      force = true;
    }
  }

  try {
    generateLocalEnvironmentFile({ outputPath, force });
    console.log('✅ Local environment file successfully written.');
    console.log('Local environment configuration completed.');
  } catch (err: unknown) {
    const msg = 'Local environment configuration failed.';
    console.error(`❌ Local environment generation failed: ${msg}`);
    process.exit(1);
  }
}

main();
