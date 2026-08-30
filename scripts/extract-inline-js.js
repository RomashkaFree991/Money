const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'index.html');
const targetDir = path.join(root, '.tmp');
const targetPath = path.join(targetDir, 'index-inline.js');
const html = fs.readFileSync(sourcePath, 'utf8');

const localModuleSources = [...html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/gi)]
  .map((match) => match[1])
  .filter((src) => src.startsWith('js/'));
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1].trim())
  .filter(Boolean);

if (!localModuleSources.length && !inlineScripts.length) {
  throw new Error('No application JavaScript found in index.html');
}

const moduleCode = localModuleSources.map((src) => {
  const cleanSrc = src.split('?')[0];
  const filePath = path.resolve(root, cleanSrc);
  if (!filePath.startsWith(`${root}${path.sep}`)) throw new Error(`Invalid module source: ${src}`);
  if (!fs.existsSync(filePath)) throw new Error(`Missing client module: ${src}`);
  return `// --- ${cleanSrc} ---\n${fs.readFileSync(filePath, 'utf8').trim()}`;
});

fs.mkdirSync(targetDir, { recursive: true });
fs.writeFileSync(targetPath, `${[...moduleCode, ...inlineScripts].join('\n\n')}\n`, 'utf8');
console.log(`Built ${targetPath} from ${localModuleSources.length} external modules and ${inlineScripts.length} inline scripts`);
