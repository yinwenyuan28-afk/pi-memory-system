import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(siteRoot, '..');
const assets = [
  ['assets/icons/main-icon-d4-layer-bridges.svg', 'brand/icon.svg'],
  ['assets/promo/pi-memory-system-promo-zh.mp4', 'media/promo-zh.mp4'],
  ['assets/promo/pi-memory-system-promo-en.mp4', 'media/promo-en.mp4'],
  ['assets/promo/poster.jpg', 'media/poster-zh.jpg'],
  ['assets/promo/poster-en.jpg', 'media/poster-en.jpg']
];
for (const [source, target] of assets) {
  const destination = resolve(siteRoot, 'public', target);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(resolve(repositoryRoot, source), destination);
}
console.log('Website assets synced from the canonical icon and promotional videos.');
