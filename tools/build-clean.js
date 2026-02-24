const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const TARGETS = [
  path.join(ROOT, 'dist'),
  path.join(ROOT, '.dist'),
  path.join(ROOT, 'extension', 'buildInfo.json')
];

function removeIfExists(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return false;
  }
  fs.rmSync(targetPath, { recursive: true, force: true });
  return true;
}

function run() {
  let removed = 0;
  TARGETS.forEach((targetPath) => {
    if (removeIfExists(targetPath)) {
      removed += 1;
      console.log(`removed: ${path.relative(ROOT, targetPath)}`);
    }
  });
  if (!removed) {
    console.log('nothing to clean');
  }
}

run();
