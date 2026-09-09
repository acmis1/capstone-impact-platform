import assert from 'assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const bodyendPath = path.resolve(__dirname, '../duda/bodyend.html');
const html = fs.readFileSync(bodyendPath, 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
const configEnd = script?.indexOf('    const CAPSTONE_FEED_URL');

assert.ok(script && configEnd !== undefined && configEnd >= 0, 'Duda configuration block was not found.');

const context = { URL, window: {}, console };
vm.runInNewContext(
  `${script.slice(0, configEnd)}    globalThis.validateFeedUrl = validateFeedUrl;\n})();`,
  context,
  { filename: bodyendPath },
);

const validateFeedUrl = context.validateFeedUrl;
assert.strictEqual(typeof validateFeedUrl, 'function', 'Duda feed URL validator was not exposed.');

const validUrls = [
  'https://examplevalidref.supabase.co/storage/v1/object/public/feeds/capstones-latest.json',
  'https://examplevalidref.supabase.co/storage/v1/object/public/public-feeds/capstones-latest.json',
];

validUrls.forEach((url) => {
  assert.strictEqual(validateFeedUrl(url), url, `Expected accepted feed URL: ${url}`);
});

const invalidUrls = [
  'https://examplevalidref.supabase.co/storage/v1/object/public/other-feeds/capstones-latest.json',
  'https://examplevalidref.supabase.co/storage/v1/object/public/public-feeds/other.json',
  'https://examplevalidref.supabase.co/storage/v1/object/public/feeds/other.json',
  'https://examplevalidref.supabase.co/storage/v1/object/public/public-feeds/nested/capstones-latest.json',
  'https://examplevalidref.supabase.co/storage/v1/object/sign/public-feeds/capstones-latest.json',
  'https://examplevalidref.supabase.co/storage/v1/object/authenticated/public-feeds/capstones-latest.json',
  'https://examplevalidref.supabase.co/storage/v1/object/public/feeds/../public-feeds/capstones-latest.json',
  'https://examplevalidref.supabase.co/storage/v1/object/public/public-feeds/%2e%2e/feeds/capstones-latest.json',
  'http://examplevalidref.supabase.co/storage/v1/object/public/public-feeds/capstones-latest.json',
  'https://examplevalidref.supabase.co:8443/storage/v1/object/public/public-feeds/capstones-latest.json',
  'https://user:pass@examplevalidref.supabase.co/storage/v1/object/public/public-feeds/capstones-latest.json',
  'https://examplevalidref.supabase.co/storage/v1/object/public/public-feeds/capstones-latest.json?cache=1',
  'https://examplevalidref.supabase.co/storage/v1/object/public/public-feeds/capstones-latest.json#fragment',
  'https://examplevalidref.supabase.co.evil.example/storage/v1/object/public/public-feeds/capstones-latest.json',
  'https://example-valid-ref.supabase.co/storage/v1/object/public/public-feeds/capstones-latest.json',
  'https://xojnnhilqaldxoilmxli.supabase.co/storage/v1/object/public/public-feeds/capstones-latest.json',
];

invalidUrls.forEach((url) => {
  assert.strictEqual(validateFeedUrl(url), null, `Expected rejected feed URL: ${url}`);
});

console.log(`Duda feed URL validator: ${validUrls.length} accepted and ${invalidUrls.length} rejected cases passed.`);
