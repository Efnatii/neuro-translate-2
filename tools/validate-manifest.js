const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

function walkForManifestFiles(dir, results) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach((entry) => {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      return;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkForManifestFiles(fullPath, results);
      return;
    }

    if (entry.isFile() && entry.name === 'manifest.json') {
      results.push(fullPath);
    }
  });
}

function hasCanonicalExtensionSiblings(rootDir) {
  const required = ['background.js', 'popup.html', 'debug.html'];
  return required.every((fileName) => fs.existsSync(path.join(rootDir, fileName)));
}

function findManifest() {
  const rootManifest = path.join(REPO_ROOT, 'manifest.json');
  if (fs.existsSync(rootManifest)) {
    return { manifestPath: rootManifest, rootDir: REPO_ROOT };
  }

  const preferredRoot = path.join(REPO_ROOT, 'extension');
  const preferredManifest = path.join(preferredRoot, 'manifest.json');

  if (fs.existsSync(preferredManifest)) {
    return { manifestPath: preferredManifest, rootDir: preferredRoot };
  }

  const manifests = [];
  walkForManifestFiles(REPO_ROOT, manifests);

  if (!manifests.length) {
    return null;
  }

  const canonical = manifests.find((manifestPath) =>
    hasCanonicalExtensionSiblings(path.dirname(manifestPath))
  );

  const selectedManifest = canonical || manifests[0];
  return {
    manifestPath: selectedManifest,
    rootDir: path.dirname(selectedManifest)
  };
}

function pushPathRefs(list, kind, values) {
  if (typeof values === 'string' && values.trim()) {
    list.push({ kind, relPath: values });
    return;
  }

  if (Array.isArray(values)) {
    values.forEach((item, index) => {
      if (typeof item === 'string' && item.trim()) {
        list.push({ kind: `${kind}[${index}]`, relPath: item });
      }
    });
  }
}

function collectManifestPaths(manifest) {
  const refs = [];

  pushPathRefs(refs, 'background.service_worker', manifest.background && manifest.background.service_worker);
  pushPathRefs(refs, 'action.default_popup', manifest.action && manifest.action.default_popup);
  pushPathRefs(refs, 'options_page', manifest.options_page);

  if (manifest.chrome_url_overrides && typeof manifest.chrome_url_overrides === 'object') {
    Object.entries(manifest.chrome_url_overrides).forEach(([key, value]) => {
      pushPathRefs(refs, `chrome_url_overrides.${key}`, value);
    });
  }

  if (Array.isArray(manifest.content_scripts)) {
    manifest.content_scripts.forEach((entry, index) => {
      pushPathRefs(refs, `content_scripts[${index}].js`, entry.js);
      pushPathRefs(refs, `content_scripts[${index}].css`, entry.css);
    });
  }

  if (manifest.icons && typeof manifest.icons === 'object') {
    Object.entries(manifest.icons).forEach(([size, filePath]) => {
      pushPathRefs(refs, `icons.${size}`, filePath);
    });
  }

  if (Array.isArray(manifest.web_accessible_resources)) {
    manifest.web_accessible_resources.forEach((entry, index) => {
      pushPathRefs(refs, `web_accessible_resources[${index}].resources`, entry.resources);
    });
  }

  return refs;
}

function validateManifest() {
  const found = findManifest();
  if (!found) {
    console.error('FAIL');
    console.error('Manifest not found in repository');
    process.exit(1);
  }

  const manifestRelPath = path.relative(REPO_ROOT, found.manifestPath);
  const rootRelPath = path.relative(REPO_ROOT, found.rootDir) || '.';
  let manifest;

  try {
    manifest = JSON.parse(fs.readFileSync(found.manifestPath, 'utf8'));
  } catch (error) {
    console.error('FAIL');
    console.error(`Manifest JSON parse error: ${error.message}`);
    console.error(`Manifest file: ${manifestRelPath}`);
    console.error(`Load unpacked нужно делать из папки: ${rootRelPath}`);
    process.exit(1);
  }

  const refs = collectManifestPaths(manifest);
  const missing = refs.filter((ref) => !fs.existsSync(path.join(found.rootDir, ref.relPath)));

  if (missing.length) {
    console.error('FAIL');
    console.error(`Manifest file: ${manifestRelPath}`);
    console.error('Missing files:');
    missing.forEach((item) => {
      console.error(`- ${item.kind}: ${item.relPath}`);
    });
    console.error(`Load unpacked нужно делать из папки: ${rootRelPath}`);
    process.exit(1);
  }

  console.log('OK');
  console.log(`Manifest file: ${manifestRelPath}`);
  if (!refs.length) {
    console.log('Missing files: none (no path-based entries in checked sections)');
  } else {
    console.log('Missing files: none');
  }
  console.log(`Load unpacked нужно делать из папки: ${rootRelPath}`);
}

validateManifest();
