const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');

function load(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  const code = fs.readFileSync(fullPath, 'utf8');
  vm.runInThisContext(code, { filename: fullPath });
}

async function run() {
  global.NT = {};
  load('extension/core/redaction.js');
  load('extension/core/safe-logger.js');
  load('extension/bg/security-audit.js');

  const SecurityAudit = global.NT.SecurityAudit;
  assert(SecurityAudit, 'SecurityAudit must be defined');

  const chromeApi = {
    runtime: {
      getManifest() {
        return {
          name: 'Neuro Translate',
          version: '1.0.0',
          manifest_version: 3,
          permissions: ['storage', 'downloads'],
          host_permissions: ['<all_urls>'],
          optional_host_permissions: ['https://*/*'],
          content_security_policy: {
            extension_pages: "script-src 'self'; object-src 'self'"
          },
          web_accessible_resources: [{
            resources: ['extension/ui/debug.html'],
            matches: ['<all_urls>']
          }]
        };
      }
    }
  };

  const credentialsStore = {
    async getPublicSnapshot() {
      return {
        mode: 'BYOK',
        byokPersisted: true,
        hasByokKey: true
      };
    }
  };

  const toolManifest = {
    getPublicSummary() {
      return {
        toolsetHash: 'hash-1',
        tools: [
          { name: 'page.get_stats', descriptionShort: 'Read page stats' }
        ]
      };
    }
  };

  const audit = new SecurityAudit({
    chromeApi,
    credentialsStore,
    toolManifest
  });

  const report = await audit.run();
  assert(report && typeof report === 'object', 'Audit report should be an object');
  assert(report.dangerousFlags.broadHostPermissions, 'Audit must flag broad host permissions');
  assert(report.dangerousFlags.broadWebAccessibleMatches, 'Audit must flag broad web accessible matches');
  assert(report.dangerousFlags.downloadsPermissionEnabled, 'Audit must flag enabled downloads permission');
  assert(report.dangerousFlags.byokPersisted, 'Audit must flag persistent BYOK key');
  assert.strictEqual(report.dangerousFlags.cspUnsafeEval, false, 'Audit must not falsely flag unsafe-eval');
  assert.strictEqual(report.dangerousFlags.cspUnsafeInline, false, 'Audit must not falsely flag unsafe-inline');
  assert(
    Array.isArray(report.recommendations)
    && report.recommendations.some((line) => /proxy mode/i.test(String(line))),
    'Audit should recommend proxy mode when BYOK is active'
  );

  console.log('PASS: security audit');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
