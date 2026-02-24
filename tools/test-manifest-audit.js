const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { auditManifest } = require('./manifest-audit');

function mkTempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-manifest-audit-'));
  fs.mkdirSync(path.join(root, 'extension', 'bg'), { recursive: true });
  return root;
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function runBadManifestCase() {
  const root = mkTempProject();
  const manifestPath = path.join(root, 'manifest.json');
  writeJson(manifestPath, {
    manifest_version: 3,
    name: 'Bad',
    version: '1.0.0',
    background: {
      service_worker: 'https://evil.example/sw.js'
    },
    permissions: ['downloads', 'storage'],
    host_permissions: ['https://*/*'],
    content_scripts: [
      {
        matches: ['<all_urls>'],
        js: ['https://evil.example/cs.js']
      }
    ],
    web_accessible_resources: [
      {
        resources: ['extension/ui/popup.js'],
        matches: ['<all_urls>']
      }
    ],
    content_security_policy: {
      extension_pages: "script-src 'self' https://evil.example; object-src 'self';"
    }
  });
  fs.writeFileSync(path.join(root, 'extension', 'bg', 'background.js'), 'console.log("no downloads usage");\n', 'utf8');

  const report = auditManifest({ manifestPath, projectRoot: root });
  const codes = (report.issues || []).map((item) => item.code);
  assert.strictEqual(report.ok, false, 'bad manifest must fail');
  assert(codes.includes('REMOTE_SCRIPT_REFERENCE'), 'must detect remote script reference');
  assert(codes.includes('HOST_PERMISSION_BROAD'), 'must detect broad host permission');
  assert(codes.includes('WEB_ACCESSIBLE_MATCH_BROAD'), 'must detect broad web_accessible_resources match');
  assert(codes.includes('DOWNLOADS_PERMISSION_UNUSED'), 'must detect unused downloads permission');
}

function runDownloadsUsedCase() {
  const root = mkTempProject();
  const manifestPath = path.join(root, 'manifest.json');
  writeJson(manifestPath, {
    manifest_version: 3,
    name: 'DownloadsUsed',
    version: '1.0.0',
    background: {
      service_worker: 'extension/bg/background.js'
    },
    permissions: ['downloads', 'storage'],
    host_permissions: ['https://api.openai.com/*'],
    content_scripts: [
      {
        matches: ['http://localhost/*'],
        js: ['extension/content/content-runtime.js']
      }
    ],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self';"
    }
  });
  fs.writeFileSync(
    path.join(root, 'extension', 'bg', 'background.js'),
    'chrome.downloads.download({ url: "https://example.com/file.txt" });\n',
    'utf8'
  );
  fs.mkdirSync(path.join(root, 'extension', 'content'), { recursive: true });
  fs.writeFileSync(path.join(root, 'extension', 'content', 'content-runtime.js'), 'console.log("ok");\n', 'utf8');

  const report = auditManifest({ manifestPath, projectRoot: root });
  const codes = (report.issues || []).map((item) => item.code);
  assert(!codes.includes('DOWNLOADS_PERMISSION_UNUSED'), 'downloads permission should not be flagged as unused');
}

function run() {
  runBadManifestCase();
  runDownloadsUsedCase();
  console.log('PASS: manifest audit');
}

run();
