const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const popupHtmlPath = path.join(ROOT, 'extension/ui/popup.html');
const popupJsPath = path.join(ROOT, 'extension/ui/popup.js');
const popupVmPath = path.join(ROOT, 'extension/ui/popup-view-model.js');

function run() {
  const html = fs.readFileSync(popupHtmlPath, 'utf8');
  const js = fs.readFileSync(popupJsPath, 'utf8');
  const vmJs = fs.readFileSync(popupVmPath, 'utf8');

  const chooserSectionRegex = /<(section|div)[^>]*data-section="category-chooser"[^>]*>/i;
  const chooserMatch = html.match(chooserSectionRegex);
  assert(chooserMatch, 'popup must contain category chooser section');
  assert(/hidden/i.test(chooserMatch[0]), 'category chooser must be hidden by default before planning');

  assert(
    /data-action="reclassify-force"/i.test(html),
    'popup must expose Reclassify (force) action for stale/mismatch flow'
  );
  assert(
    /return stage === 'awaiting_categories';/.test(vmJs),
    'popup view-model must derive awaiting-categories state from job stage'
  );
  assert(
    /const awaiting = this\.vm\.awaitingCategories === true;/.test(js)
      && /Ui\.setHidden\(this\.fields\.categoryChooser,\s*!awaiting\);/.test(js),
    'popup gating logic must explicitly depend on vm.awaitingCategories state'
  );

  console.log('PASS: popup category gating');
}

try {
  run();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
