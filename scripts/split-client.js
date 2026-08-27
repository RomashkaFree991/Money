const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

if (html.includes('href="css/app.css"') && html.includes('src="js/core/runtime.js"')) {
  console.log('Client is already modular; no files were changed.');
  process.exit(0);
}

function requireMatch(source, regex, label) {
  const match = source.match(regex);
  if (!match) throw new Error(`Cannot find ${label}`);
  return match;
}

const styleMatch = requireMatch(html, /\n\s*<style>\n([\s\S]*?)\n\s*<\/style>/, 'inline style block');
const scriptMatch = requireMatch(html, /\n\s*<script>\n([\s\S]*?const API_BASE[\s\S]*?)\n\s*<\/script>/, 'inline application script');
const css = styleMatch[1];
const js = scriptMatch[1];

const boundaries = [
  ['js/core/runtime.js', 0, '  // Balance\n'],
  ['js/core/state.js', '  // Balance\n', '  // Generate stars for crash\n'],
  ['js/modes/crash.js', '  // Generate stars for crash\n', '  const pvpTimerEl=document.getElementById(\'pvpTimer\');\n'],
  ['js/modes/pvp.js', '  const pvpTimerEl=document.getElementById(\'pvpTimer\');\n', '  let currentTab=\'game\';\n'],
  ['js/app.js', '  let currentTab=\'game\';\n', null],
];

function resolveOffset(marker, from = 0) {
  if (typeof marker === 'number') return marker;
  const offset = js.indexOf(marker, from);
  if (offset === -1) throw new Error(`Cannot find script marker: ${marker.trim()}`);
  return offset;
}

let previousEnd = 0;
const modulePaths = [];
for (const [relativePath, startMarker, endMarker] of boundaries) {
  const start = resolveOffset(startMarker, previousEnd);
  const end = endMarker === null ? js.length : resolveOffset(endMarker, start + 1);
  if (start !== previousEnd) throw new Error(`Gap or reordered source before ${relativePath}`);
  if (end <= start) throw new Error(`Invalid boundaries for ${relativePath}`);
  const outputPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, js.slice(start, end).replace(/^\n+|\n+$/g, '') + '\n');
  modulePaths.push(relativePath);
  previousEnd = end;
}
if (previousEnd !== js.length) throw new Error('Unassigned client JavaScript remains');

const cssPath = path.join(root, 'css', 'app.css');
fs.mkdirSync(path.dirname(cssPath), { recursive: true });
fs.writeFileSync(cssPath, css.replace(/^\n+|\n+$/g, '') + '\n');

const styleReplacement = '\n  <link rel="stylesheet" href="css/app.css">';
const scriptReplacement = '\n  <script defer src="js/core/runtime.js"></script>\n  <script defer src="js/core/state.js"></script>\n  <script defer src="js/modes/crash.js"></script>\n  <script defer src="js/modes/pvp.js"></script>\n  <script defer src="js/app.js"></script>';
let modularHtml = html.replace(styleMatch[0], styleReplacement);
modularHtml = modularHtml.replace(scriptMatch[0], scriptReplacement);

const backupDir = path.join(root, 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(backupDir, 'index.before-modularization.html');
if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, html);
fs.writeFileSync(htmlPath, modularHtml);

console.log(`Split client into css/app.css and ${modulePaths.join(', ')}`);
console.log(`Original monolith backup: ${path.relative(root, backupPath)}`);
