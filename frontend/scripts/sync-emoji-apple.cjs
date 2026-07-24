/**
 * Copy Apple emoji PNGs from emoji-datasource-apple into public/, for fully offline installs.
 * Picks img/apple/128 when present, else img/apple/64 (fewer/smaller pixels).
 *
 * Runs from frontend/: node scripts/sync-emoji-apple.cjs
 */

const fs = require('fs');
const path = require('path');

const pkgJson = require.resolve('emoji-datasource-apple/package.json');
const pkgRoot = path.dirname(pkgJson);
const imgRoot = path.join(pkgRoot, 'img', 'apple');

const preferredSizes = ['128', '96', '72', '64'];
let picked = null;
for (let i = 0; i < preferredSizes.length; i += 1) {
  const cand = path.join(imgRoot, preferredSizes[i]);
  if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) {
    picked = { dir: cand, label: preferredSizes[i] };
    break;
  }
}

const destRoot = path.join(__dirname, '..', 'public', 'emoji-vendor', 'apple');

if (!picked) {
  console.error(
    '[sync-emoji-apple] No apple size folder found under',
    imgRoot,
    '(install dependency: npm install emoji-datasource-apple)',
  );
  process.exit(1);
}

fs.rmSync(destRoot, { recursive: true, force: true });
fs.mkdirSync(destRoot, { recursive: true });
fs.cpSync(picked.dir, destRoot, { recursive: true });

const count = fs.readdirSync(destRoot).filter((f) => f.endsWith('.png')).length;
console.log(`[sync-emoji-apple] Copied Apple ${picked.label}px set (${count} files) → public/emoji-vendor/apple/`);
