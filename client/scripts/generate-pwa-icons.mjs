// Renders the install icons in public/ from the FreeLLMAPI mark (favicon.svg).
// Re-run after changing the mark:  node client/scripts/generate-pwa-icons.mjs
import path from 'node:path';
import sharp from 'sharp';

const PUBLIC = path.resolve(import.meta.dirname, '..', 'public');

// The mark on a full-bleed square. `scale` shrinks the mark so it sits inside
// the maskable safe zone (the inner 80% circle) that launchers crop to.
function mark({ scale = 1, rounded = false } = {}) {
  const t = 32 - 32 * scale;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 64 64">
  <rect width="64" height="64" ${rounded ? 'rx="14"' : ''} fill="#09090b"/>
  <g transform="translate(${t} ${t}) scale(${scale})">
    <circle cx="32" cy="32" r="9.5" fill="#fafafa"/>
    <circle cx="32" cy="32" r="18" fill="none" stroke="#fafafa" stroke-opacity=".4"
            stroke-width="3.5" stroke-linecap="round" stroke-dasharray="86 27"
            transform="rotate(-60 32 32)"/>
  </g>
</svg>`);
}

const outputs = [
  { file: 'icon-192.png', size: 192, svg: mark({ rounded: true }) },
  { file: 'icon-512.png', size: 512, svg: mark({ rounded: true }) },
  { file: 'icon-maskable-512.png', size: 512, svg: mark({ scale: 0.8 }) },
  // iOS rounds the corners itself and shows transparency as black.
  { file: 'apple-touch-icon.png', size: 180, svg: mark({ scale: 0.9 }) },
];

for (const { file, size, svg } of outputs) {
  await sharp(svg, { density: 512 }).resize(size, size).png().toFile(path.join(PUBLIC, file));
  console.log(`wrote public/${file}`);
}
