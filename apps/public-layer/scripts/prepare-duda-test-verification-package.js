import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const dudaDirectory = path.join(repositoryRoot, 'apps', 'public-layer', 'duda');
const defaultOutput = path.join(repositoryRoot, 'artifacts', 'duda-test-verification-package-20260914');
const outputDirectory = path.resolve(process.argv[2] ?? defaultOutput);

const sourceFiles = [
  { file: 'bodyend.html', installTarget: 'TEST site body-end HTML, after the reviewed feed URL configuration' },
  { file: 'listing-page.html', installTarget: 'TEST listing page HTML widget (/sst-school-projects)' },
  { file: 'listing-page.css', installTarget: 'TEST listing page CSS' },
  { file: 'detail-page.html', installTarget: 'TEST reusable detail page HTML widget (/project-detail)' },
  { file: 'detail-page.css', installTarget: 'TEST reusable detail page CSS' },
];

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

try {
  const outputStat = await stat(outputDirectory).catch(() => null);
  if (outputStat) throw new Error(`Refusing to overwrite existing package: ${outputDirectory}`);
  await mkdir(outputDirectory, { recursive: true });

  const packaged = [];
  for (const entry of sourceFiles) {
    const sourcePath = path.join(dudaDirectory, entry.file);
    const destinationPath = path.join(outputDirectory, entry.file);
    await copyFile(sourcePath, destinationPath);
    const [sourceHash, packagedHash, fileStat] = await Promise.all([
      sha256(sourcePath), sha256(destinationPath), stat(destinationPath),
    ]);
    if (sourceHash !== packagedHash) throw new Error(`Byte mismatch after packaging ${entry.file}`);
    packaged.push({
      packageFile: entry.file,
      sourcePath: path.relative(repositoryRoot, sourcePath).replaceAll('\\', '/'),
      installTarget: entry.installTarget,
      bytes: fileStat.size,
      sha256: sourceHash,
    });
  }

  const operatorSource = path.join(dudaDirectory, 'TEST-VERIFICATION-OPERATOR.md');
  await copyFile(operatorSource, path.join(outputDirectory, 'TEST-VERIFICATION-OPERATOR.md'));
  await writeFile(path.join(outputDirectory, 'feed-url-config.example.html'),
    `<script>\nwindow.CAPSTONE_FEED_URL = 'REPLACE_WITH_SEPARATELY_REVIEWED_TEST_PUBLIC_FEED_URL';\n</script>\n`,
    { encoding: 'utf8', flag: 'wx' });

  const manifest = {
    packageVersion: 1,
    classification: 'OPERATOR_INSTALLABLE_DUDA_TEST_PACKAGE_HOSTED_ACCEPTANCE_PENDING',
    target: {
      environment: 'TEST_ONLY',
      siteId: 'c5bc8c6b',
      siteAlias: 'testwww-rmitvn-showcase-comsset',
      listingSlug: 'sst-school-projects',
      detailSlug: 'project-detail',
    },
    restrictions: {
      liveSiteMutation: 'FORBIDDEN',
      publishOrRepublish: 'FORBIDDEN',
      privateDudaAccessPerformedByPackageGenerator: false,
      hostedFeedWritePerformedByPackageGenerator: false,
    },
    rendererFiles: packaged,
  };
  await writeFile(path.join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(outputDirectory, 'SHA256SUMS.txt'),
    `${packaged.map((entry) => `${entry.sha256}  ${entry.packageFile}`).join('\n')}\n`,
    { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(outputDirectory, 'verify-package.mjs'), `import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(path.join(here, 'manifest.json'), 'utf8'));
for (const file of manifest.rendererFiles) {
  const bytes = await readFile(path.join(here, file.packageFile));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== file.sha256 || bytes.length !== file.bytes) throw new Error('PACKAGE_CHECKSUM_MISMATCH:' + file.packageFile);
}
console.log('PASS: exact maintained Duda renderer bytes match manifest');
`, { encoding: 'utf8', flag: 'wx' });

  console.log(`PASS: Duda TEST verification package prepared at ${outputDirectory}`);
  for (const entry of packaged) console.log(`${entry.sha256}  ${entry.packageFile}`);
  console.log('DUDA_CONTACTED=NO');
  console.log('HOSTED_FEED_WRITTEN=NO');
  console.log('LIVE_SITE_MUTATION=NO');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Duda TEST package generation failed');
  process.exitCode = 1;
}
