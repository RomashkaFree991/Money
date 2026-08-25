const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'index.html');
const targetDir = path.join(root, '.tmp');
const targetPath = path.join(targetDir, 'index-inline.js');
const html = fs.readFileSync(sourcePath, 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1].trim())
  .filter(Boolean);

if (scripts.length !== 1) {
  throw new Error(`Expected exactly one inline script in index.html, found ${scripts.length}`);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.writeFileSync(targetPath, `${scripts[0]}\n`, 'utf8');
console.log(`Extracted ${targetPath}`);
