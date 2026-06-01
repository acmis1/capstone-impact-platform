import { SAMPLE_PROJECTS } from '../fixtures/sampleProjects';
import { compilePublicFeed } from '../feed/compilePublicFeed';
import { validatePublicFeed } from '../feed/validatePublicFeed';

function main() {
  console.log('====================================================');
  console.log('STAGING WORKSPACE: RUNNING PUBLIC FEED AUDIT RUN');
  console.log('====================================================');

  console.log(`Loading sample projects database... Total records: ${SAMPLE_PROJECTS.length}`);

  // 1. Compile public feed
  console.log('Compiling approved-only public feed array...');
  const publicFeed = compilePublicFeed(SAMPLE_PROJECTS);
  console.log(`Compilation complete. Public feed record count: ${publicFeed.length}`);

  // 2. Validate feed contract
  console.log('Enforcing public schema contract validation gates...');
  const validation = validatePublicFeed(publicFeed);

  console.log('\n--- VERIFICATION METRICS ---');
  console.log(`Input Projects Count:         ${SAMPLE_PROJECTS.length}`);
  console.log(`Public Showcase Feed Count:   ${publicFeed.length}`);
  console.log(`Validation Errors Detected:   ${validation.errors.length}`);
  console.log(`Validation Warnings Detected: ${validation.warnings.length}`);

  if (validation.warnings.length > 0) {
    console.log('\n--- VALIDATION WARNINGS (NON-BLOCKING) ---');
    validation.warnings.forEach((warning) => console.warn(`⚠️  ${warning}`));
  }

  if (validation.errors.length > 0) {
    console.error('\n--- VALIDATION ERRORS (CRITICAL BLOCKERS) ---');
    validation.errors.forEach((error) => console.error(`❌  ${error}`));
    console.error('\nResult: Verification FAILED due to critical schema contract errors.');
    process.exit(1);
  }

  console.log('\nResult: Verification PASSED! Showcase feed is schema-compliant.');
  console.log('====================================================');
}

main();
