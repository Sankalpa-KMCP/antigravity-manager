const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src', 'ui');
const distDir = path.join(__dirname, '..', 'dist', 'ui');

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

for (const file of fs.readdirSync(srcDir)) {
  const srcFile = path.join(srcDir, file);
  const destFile = path.join(distDir, file);
  if (fs.statSync(srcFile).isFile()) {
    fs.copyFileSync(srcFile, destFile);
    console.log(`Copied ${file} to dist/ui/`);
  }
}
