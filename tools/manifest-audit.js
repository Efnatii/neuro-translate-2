const fs = require('fs');
const path = require('path');

const DEFAULT_MANIFEST_PATH = path.resolve(__dirname, '..', 'manifest.json');
const SEVERITY = Object.freeze({
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info'
});

function normalizeRelPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function isBroadMatch(pattern) {
  const raw = String(pattern || '').trim().toLowerCase();
  if (!raw) {
    return false;
  }
  if (raw === '<all_urls>') {
    return true;
  }
  if (raw === '*://*/*') {
    return true;
  }
  if (raw === 'http://*/*' || raw === 'https://*/*') {
    return true;
  }
  if (raw === 'file://*/*') {
    return true;
  }
  return false;
}

function isRemoteUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function walkFiles(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.forEach((entry) => {
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

function parseScriptSrcDirective(csp) {
  const directives = String(csp || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const scriptDirective = directives.find((part) => part.toLowerCase().startsWith('script-src '));
  if (!scriptDirective) {
    return [];
  }
  return scriptDirective
    .split(/\s+/)
    .slice(1)
    .map((token) => token.trim())
    .filter(Boolean);
}

function collectManifestScriptRefs(manifest) {
  const refs = [];
  const pushRef = (location, value) => {
    if (typeof value !== 'string' || !value.trim()) {
      return;
    }
    refs.push({ location, value: value.trim() });
  };

  pushRef('background.service_worker', manifest && manifest.background ? manifest.background.service_worker : null);
  pushRef('action.default_popup', manifest && manifest.action ? manifest.action.default_popup : null);
  pushRef('options_page', manifest ? manifest.options_page : null);

  const contentScripts = Array.isArray(manifest && manifest.content_scripts) ? manifest.content_scripts : [];
  contentScripts.forEach((entry, index) => {
    const scripts = Array.isArray(entry && entry.js) ? entry.js : [];
    scripts.forEach((item, idx) => pushRef(`content_scripts[${index}].js[${idx}]`, item));
  });

  const webAccessible = Array.isArray(manifest && manifest.web_accessible_resources)
    ? manifest.web_accessible_resources
    : [];
  webAccessible.forEach((entry, index) => {
    const resources = Array.isArray(entry && entry.resources) ? entry.resources : [];
    resources.forEach((item, idx) => pushRef(`web_accessible_resources[${index}].resources[${idx}]`, item));
  });

  return refs;
}

function scanForRemoteScriptPatterns(projectRoot) {
  const extensionRoot = path.join(projectRoot, 'extension');
  const files = walkFiles(extensionRoot).filter((fullPath) => /\.(html|js|mjs|cjs)$/i.test(fullPath));
  const findings = [];
  files.forEach((fullPath) => {
    const relPath = normalizeRelPath(path.relative(projectRoot, fullPath));
    const source = fs.readFileSync(fullPath, 'utf8');
    const patterns = [
      /<script[^>]+src\s*=\s*["']https?:\/\/[^"']+["']/i,
      /importScripts\s*\(\s*["']https?:\/\/[^"']+["']/i,
      /import\s*\(\s*["']https?:\/\/[^"']+["']/i
    ];
    patterns.forEach((pattern) => {
      const hit = source.match(pattern);
      if (!hit) {
        return;
      }
      findings.push({
        file: relPath,
        snippet: String(hit[0]).slice(0, 180)
      });
    });
  });
  return findings;
}

function hasDownloadsUsage(projectRoot) {
  const extensionRoot = path.join(projectRoot, 'extension');
  const files = walkFiles(extensionRoot).filter((fullPath) => /\.(js|mjs|cjs)$/i.test(fullPath));
  return files.some((fullPath) => {
    const source = fs.readFileSync(fullPath, 'utf8');
    return /chrome\s*\.\s*downloads\b/.test(source);
  });
}

function auditTestCommandGuards(projectRoot) {
  const bgPath = path.join(projectRoot, 'extension', 'bg', 'background-app.js');
  const buildFlagsPath = path.join(projectRoot, 'extension', 'core', 'build-flags.js');
  if (!fs.existsSync(bgPath)) {
    return {
      foundTestCommands: false,
      hasGuardCheck: false,
      hasDefaultDisabled: false,
      hasBuildFlagGuard: false,
      hasBuildFlagFile: false
    };
  }
  const source = fs.readFileSync(bgPath, 'utf8');
  const foundTestCommands = /BG_TEST_[A-Z0-9_]+/m.test(source);
  const hasGuardCheck = /_isTestCommandsEnabled\s*\(/m.test(source)
    && /debugAllowTestCommands/m.test(source);
  const hasDefaultDisabled = /debugAllowTestCommands\s*:\s*false/m.test(source);
  const hasBuildFlagGuard = /_isBuildTestCommandsEnabled\s*\(/m.test(source)
    && /allowTestCommandsInBuild/m.test(source);
  const hasBuildFlagFile = fs.existsSync(buildFlagsPath)
    && /allowTestCommandsInBuild\s*:\s*(true|false)/m.test(fs.readFileSync(buildFlagsPath, 'utf8'));
  return { foundTestCommands, hasGuardCheck, hasDefaultDisabled, hasBuildFlagGuard, hasBuildFlagFile };
}

function newIssue(severity, code, message, details = null) {
  return {
    severity,
    code,
    message,
    details: details && typeof details === 'object' ? details : null
  };
}

function auditManifest({ manifestPath = DEFAULT_MANIFEST_PATH, projectRoot = null } = {}) {
  const resolvedManifestPath = path.resolve(manifestPath);
  const resolvedProjectRoot = path.resolve(projectRoot || path.dirname(resolvedManifestPath));
  const issues = [];

  if (!fs.existsSync(resolvedManifestPath)) {
    issues.push(newIssue(SEVERITY.CRITICAL, 'MANIFEST_NOT_FOUND', 'manifest.json was not found', {
      manifestPath: resolvedManifestPath
    }));
    return {
      ok: false,
      manifestPath: resolvedManifestPath,
      projectRoot: resolvedProjectRoot,
      version: null,
      summary: { critical: 1, warning: 0, info: 0 },
      issues,
      timestamp: new Date().toISOString()
    };
  }

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(resolvedManifestPath, 'utf8'));
  } catch (error) {
    issues.push(newIssue(SEVERITY.CRITICAL, 'MANIFEST_PARSE_FAILED', 'manifest.json is invalid JSON', {
      error: error && error.message ? error.message : String(error || 'parse failed')
    }));
    return {
      ok: false,
      manifestPath: resolvedManifestPath,
      projectRoot: resolvedProjectRoot,
      version: null,
      summary: { critical: 1, warning: 0, info: 0 },
      issues,
      timestamp: new Date().toISOString()
    };
  }

  const version = manifest && manifest.version ? String(manifest.version) : null;
  const csp = manifest
    && manifest.content_security_policy
    && typeof manifest.content_security_policy.extension_pages === 'string'
    ? manifest.content_security_policy.extension_pages
    : '';

  if (!csp) {
    issues.push(newIssue(SEVERITY.CRITICAL, 'CSP_MISSING', 'content_security_policy.extension_pages is missing'));
  } else {
    const cspLower = csp.toLowerCase();
    if (cspLower.includes("'unsafe-eval'") || cspLower.includes('unsafe-eval') || cspLower.includes('wasm-unsafe-eval')) {
      issues.push(newIssue(SEVERITY.CRITICAL, 'CSP_UNSAFE_EVAL', 'CSP contains unsafe-eval'));
    }
    const scriptTokens = parseScriptSrcDirective(csp);
    if (!scriptTokens.length) {
      issues.push(newIssue(SEVERITY.WARNING, 'CSP_SCRIPT_SRC_MISSING', 'CSP has no explicit script-src directive'));
    } else {
      const hasSelf = scriptTokens.includes("'self'");
      if (!hasSelf) {
        issues.push(newIssue(SEVERITY.WARNING, 'CSP_SCRIPT_SELF_MISSING', "script-src does not include 'self'"));
      }
      scriptTokens.forEach((token) => {
        const lowered = token.toLowerCase();
        const remoteLike = lowered.startsWith('http://')
          || lowered.startsWith('https://')
          || lowered === '*'
          || lowered === 'data:'
          || lowered === 'blob:';
        if (remoteLike) {
          issues.push(newIssue(SEVERITY.CRITICAL, 'CSP_SCRIPT_REMOTE', 'script-src allows non-packaged script source', {
            token
          }));
        }
      });
    }
  }

  const refs = collectManifestScriptRefs(manifest);
  refs.forEach((ref) => {
    if (isRemoteUrl(ref.value)) {
      issues.push(newIssue(SEVERITY.CRITICAL, 'REMOTE_SCRIPT_REFERENCE', 'Manifest references remote script/resource', {
        location: ref.location,
        value: ref.value
      }));
    }
  });

  const remoteScriptPatterns = scanForRemoteScriptPatterns(resolvedProjectRoot);
  remoteScriptPatterns.forEach((item) => {
    issues.push(newIssue(SEVERITY.CRITICAL, 'REMOTE_SCRIPT_IN_CODE', 'Source contains remote script reference pattern', {
      file: item.file,
      snippet: item.snippet
    }));
  });

  const hostPermissions = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
  hostPermissions.forEach((pattern) => {
    if (isBroadMatch(pattern)) {
      issues.push(newIssue(SEVERITY.CRITICAL, 'HOST_PERMISSION_BROAD', 'host_permissions contains broad match', {
        pattern
      }));
    }
  });

  const optionalHostPermissions = Array.isArray(manifest.optional_host_permissions)
    ? manifest.optional_host_permissions
    : [];
  optionalHostPermissions.forEach((pattern) => {
    if (isBroadMatch(pattern)) {
      issues.push(newIssue(SEVERITY.WARNING, 'OPTIONAL_HOST_PERMISSION_BROAD', 'optional_host_permissions contains broad match', {
        pattern
      }));
    }
  });

  const warEntries = Array.isArray(manifest.web_accessible_resources) ? manifest.web_accessible_resources : [];
  warEntries.forEach((entry, index) => {
    const matches = Array.isArray(entry && entry.matches) ? entry.matches : [];
    matches.forEach((pattern) => {
      if (!isBroadMatch(pattern)) {
        return;
      }
      issues.push(newIssue(SEVERITY.CRITICAL, 'WEB_ACCESSIBLE_MATCH_BROAD', 'web_accessible_resources.matches is too broad', {
        index,
        pattern
      }));
    });
  });

  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const riskyPermissions = ['downloads', 'webRequest', 'webRequestBlocking', 'debugger', 'management', 'history'];
  riskyPermissions.forEach((permission) => {
    if (!permissions.includes(permission)) {
      return;
    }
    if (permission === 'downloads') {
      const used = hasDownloadsUsage(resolvedProjectRoot);
      if (!used) {
        issues.push(newIssue(SEVERITY.CRITICAL, 'DOWNLOADS_PERMISSION_UNUSED', 'downloads permission is declared but no chrome.downloads usage found'));
      } else {
        issues.push(newIssue(SEVERITY.INFO, 'DOWNLOADS_PERMISSION_USED', 'downloads permission is declared and chrome.downloads usage exists'));
      }
      return;
    }
    issues.push(newIssue(SEVERITY.WARNING, 'PERMISSION_HIGH_RISK', 'Manifest uses high-risk permission', {
      permission
    }));
  });

  if (permissions.length > 10) {
    issues.push(newIssue(SEVERITY.WARNING, 'PERMISSION_COUNT_HIGH', 'Large permission set detected', {
      count: permissions.length
    }));
  }

  const testGuard = auditTestCommandGuards(resolvedProjectRoot);
  if (testGuard.foundTestCommands && !testGuard.hasGuardCheck) {
    issues.push(newIssue(
      SEVERITY.CRITICAL,
      'TEST_COMMAND_GUARD_MISSING',
      'BG_TEST_* commands are present but no debugAllowTestCommands guard was detected'
    ));
  }
  if (testGuard.foundTestCommands && !testGuard.hasDefaultDisabled) {
    issues.push(newIssue(
      SEVERITY.CRITICAL,
      'TEST_COMMAND_DEFAULT_UNSAFE',
      'debugAllowTestCommands default=false was not detected in background defaults'
    ));
  }
  if (testGuard.foundTestCommands && !testGuard.hasBuildFlagGuard) {
    issues.push(newIssue(
      SEVERITY.CRITICAL,
      'TEST_COMMAND_BUILD_GUARD_MISSING',
      'BG_TEST_* commands are present but allowTestCommandsInBuild guard was not detected'
    ));
  }
  if (testGuard.foundTestCommands && !testGuard.hasBuildFlagFile) {
    issues.push(newIssue(
      SEVERITY.CRITICAL,
      'TEST_COMMAND_BUILD_FLAG_FILE_MISSING',
      'extension/core/build-flags.js with allowTestCommandsInBuild flag was not detected'
    ));
  }

  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  contentScripts.forEach((entry, index) => {
    const matches = Array.isArray(entry && entry.matches) ? entry.matches : [];
    if (!matches.length) {
      issues.push(newIssue(SEVERITY.CRITICAL, 'CONTENT_SCRIPT_MATCHES_EMPTY', 'content_scripts entry has empty matches', { index }));
      return;
    }
    matches.forEach((pattern) => {
      if (!isBroadMatch(pattern)) {
        return;
      }
      issues.push(newIssue(SEVERITY.WARNING, 'CONTENT_SCRIPT_MATCH_BROAD', 'content_scripts.matches contains broad match', {
        index,
        pattern
      }));
    });
  });

  const summary = issues.reduce((acc, item) => {
    if (item && item.severity === SEVERITY.CRITICAL) {
      acc.critical += 1;
    } else if (item && item.severity === SEVERITY.WARNING) {
      acc.warning += 1;
    } else {
      acc.info += 1;
    }
    return acc;
  }, { critical: 0, warning: 0, info: 0 });

  return {
    ok: summary.critical === 0,
    manifestPath: resolvedManifestPath,
    projectRoot: resolvedProjectRoot,
    version,
    summary,
    issues,
    timestamp: new Date().toISOString()
  };
}

function printHumanReport(report) {
  const status = report && report.ok ? 'PASS' : 'FAIL';
  console.log(`Manifest audit: ${status}`);
  console.log(`Manifest: ${report.manifestPath}`);
  console.log(`Version: ${report.version || 'unknown'}`);
  console.log(`Critical: ${report.summary.critical}, Warnings: ${report.summary.warning}, Info: ${report.summary.info}`);
  if (!Array.isArray(report.issues) || !report.issues.length) {
    console.log('No issues found.');
    return;
  }
  report.issues.forEach((item) => {
    const sev = String(item.severity || '').toUpperCase();
    const details = item.details ? ` ${JSON.stringify(item.details)}` : '';
    console.log(`- [${sev}] ${item.code}: ${item.message}${details}`);
  });
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const out = {
    manifestPath: DEFAULT_MANIFEST_PATH,
    projectRoot: path.resolve(__dirname, '..'),
    jsonOnly: false
  };
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (current === '--manifest' && typeof args[i + 1] === 'string') {
      out.manifestPath = path.resolve(args[i + 1]);
      i += 1;
      continue;
    }
    if (current === '--root' && typeof args[i + 1] === 'string') {
      out.projectRoot = path.resolve(args[i + 1]);
      i += 1;
      continue;
    }
    if (current === '--json-only') {
      out.jsonOnly = true;
    }
  }
  return out;
}

function runCli() {
  const options = parseArgs(process.argv.slice(2));
  const report = auditManifest({
    manifestPath: options.manifestPath,
    projectRoot: options.projectRoot
  });
  if (options.jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
    console.log('JSON report:');
    console.log(JSON.stringify(report, null, 2));
  }
  if (!report.ok) {
    process.exit(1);
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  SEVERITY,
  auditManifest,
  isBroadMatch,
  parseScriptSrcDirective
};
