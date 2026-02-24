const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'manifest.json');
const DIST_DIR = path.join(ROOT, 'dist');
const STAGE_DIR = path.join(ROOT, '.dist', 'package');
const BUILD_INFO_PATH = path.join(ROOT, 'extension', 'buildInfo.json');

function normalizeRelPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function walkFiles(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  const out = [];
  const stack = [dirPath];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((entry) => {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          return;
        }
        if (entry.isFile()) {
          out.push(fullPath);
        }
      });
  }
  return out;
}

function getManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  return JSON.parse(raw);
}

function resolveGitSha() {
  try {
    const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    if (result.status === 0 && typeof result.stdout === 'string') {
      const sha = result.stdout.trim();
      if (sha) {
        return sha;
      }
    }
  } catch (_) {
    // best-effort only
  }
  return 'unknown';
}

function writeBuildInfo(manifest) {
  const version = manifest && manifest.version ? String(manifest.version) : '0.0.0';
  const buildInfo = {
    version,
    gitSha: resolveGitSha(),
    buildTime: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(BUILD_INFO_PATH), { recursive: true });
  fs.writeFileSync(BUILD_INFO_PATH, `${JSON.stringify(buildInfo, null, 2)}\n`, 'utf8');
  return buildInfo;
}

function shouldExclude(relPath) {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) {
    return true;
  }
  if (normalized.endsWith('.map')) {
    return true;
  }
  const blockedPrefixes = [
    '.git/',
    '.github/',
    'node_modules/',
    'tests/',
    'test-results/',
    'docs/'
  ];
  return blockedPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function collectAllowlistFiles() {
  const out = new Set();
  const pushIfFile = (fullPath) => {
    if (!fullPath || !fs.existsSync(fullPath)) {
      return;
    }
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) {
      return;
    }
    const relPath = path.relative(ROOT, fullPath);
    if (shouldExclude(relPath)) {
      return;
    }
    out.add(normalizeRelPath(relPath));
  };

  pushIfFile(MANIFEST_PATH);
  walkFiles(path.join(ROOT, 'extension')).forEach(pushIfFile);

  const iconsDir = path.join(ROOT, 'icons');
  walkFiles(iconsDir).forEach(pushIfFile);

  const rootEntries = fs.readdirSync(ROOT, { withFileTypes: true });
  rootEntries.forEach((entry) => {
    if (!entry.isFile()) {
      return;
    }
    if (!/^(icon.*\.(png|svg|ico)|favicon\.ico)$/i.test(entry.name)) {
      return;
    }
    pushIfFile(path.join(ROOT, entry.name));
  });

  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function stageFiles(relFiles) {
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGE_DIR, { recursive: true });
  relFiles.forEach((relPath) => {
    const src = path.join(ROOT, relPath);
    const dest = path.join(STAGE_DIR, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  });
}

function runZipCommand(zipPath) {
  if (process.platform === 'win32') {
    const escapedDestination = String(zipPath).replace(/'/g, "''");
    const script = `Compress-Archive -Path '*' -DestinationPath '${escapedDestination}' -Force`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
      cwd: STAGE_DIR,
      stdio: 'inherit'
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`Compress-Archive failed with code ${result.status}`);
    }
    return;
  }

  const result = spawnSync('zip', ['-X', '-r', zipPath, '.'], {
    cwd: STAGE_DIR,
    stdio: 'inherit'
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`zip command failed with code ${result.status}`);
  }
}

function buildZip() {
  const manifest = getManifest();
  const version = manifest && manifest.version ? String(manifest.version) : '0.0.0';
  const buildInfo = writeBuildInfo(manifest);
  const relFiles = collectAllowlistFiles();
  if (!relFiles.length) {
    throw new Error('No files selected for package');
  }
  stageFiles(relFiles);

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const zipName = `neuro-translate-edge-mv3-${version}.zip`;
  const zipPath = path.join(DIST_DIR, zipName);
  fs.rmSync(zipPath, { force: true });
  runZipCommand(zipPath);

  const size = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
  console.log(`manifest version: ${version}`);
  console.log(`build info: ${path.relative(ROOT, BUILD_INFO_PATH)}`);
  console.log(`files packaged: ${relFiles.length}`);
  console.log(`zip: ${path.relative(ROOT, zipPath)} (${size} bytes)`);
  console.log(`git sha: ${buildInfo.gitSha}`);
  console.log(`build time: ${buildInfo.buildTime}`);
}

try {
  buildZip();
} catch (error) {
  console.error(`build:zip failed: ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
}
