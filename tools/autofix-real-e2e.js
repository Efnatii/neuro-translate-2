#!/usr/bin/env node

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const RESULTS_DIR = path.join(ROOT, 'test-results');
const MAX_FIX_ATTEMPTS = 2;
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses';
const MODEL_ALLOWLIST = ['gpt-5', 'gpt-5.1', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'];
const ALLOWED_PATCH_PREFIXES = ['extension/', 'tests/', 'tools/'];

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeRelPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function redactText(input) {
  let out = String(input || '');
  out = out.replace(/(authorization\s*:\s*bearer\s+)([^\s,;]+)/gi, '$1[REDACTED]');
  out = out.replace(/(api[_-]?key\s*[=:]\s*)([^\s,;]+)/gi, '$1[REDACTED]');
  out = out.replace(/([?&](?:api[_-]?key|token|access[_-]?token|session|sess|key)=)([^&#]+)/gi, '$1[REDACTED]');
  out = out.replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi, 'Bearer [REDACTED]');
  return out;
}

function limitText(input, maxLen = 20000) {
  const raw = String(input || '');
  if (raw.length <= maxLen) {
    return raw;
  }
  return raw.slice(raw.length - maxLen);
}

function listFilesRecursive(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  const out = [];
  const stack = [dirPath];
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

function readJsonSafe(filePath, fallback = null) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runCommandCapture({ command, args, logPath, cwd = ROOT, env = process.env }) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const launchError = result && result.error
    ? (result.error.message || String(result.error))
    : '';
  const combined = `${stdout}${stderr ? `\n${stderr}` : ''}${launchError ? `\n[spawn-error] ${launchError}` : ''}`;
  fs.writeFileSync(logPath, `${redactText(combined)}\n`, 'utf8');
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout,
    stderr,
    combined,
    error: result.error || null,
    launchError
  };
}

function parseFailingTests(logText) {
  const lines = String(logText || '').split(/\r?\n/);
  const failingTests = [];
  const stack = [];

  lines.forEach((line) => {
    if (/^\s*\d+\)\s+/.test(line)) {
      failingTests.push(line.trim());
    }
    if (/\b(Error|AssertionError|Expect|Timeout|at\s+.+\(|failed)\b/i.test(line)) {
      stack.push(line);
    }
  });

  return {
    failingTests: Array.from(new Set(failingTests)).slice(0, 30),
    stack: stack.slice(-180)
  };
}

function summarizeReport(report) {
  const src = report && typeof report === 'object' ? report : {};
  const job = src.job && typeof src.job === 'object' ? src.job : {};
  const agent = src.agent && typeof src.agent === 'object' ? src.agent : {};
  const toolTrace = Array.isArray(agent.toolExecutionTrace) ? agent.toolExecutionTrace : [];
  const toolNames = toolTrace
    .map((row) => String(row && row.toolName ? row.toolName : '').trim())
    .filter(Boolean)
    .slice(-40);

  return {
    exportedAt: src.exportedAt || null,
    tabId: src.tabId || null,
    job: {
      id: job.id || null,
      status: job.status || null,
      stage: job.stage || null,
      hasLastError: Boolean(job.lastError),
      selectedCategoriesCount: Array.isArray(job.selectedCategories) ? job.selectedCategories.length : 0,
      pendingCount: Array.isArray(job.pendingBlockIds) ? job.pendingBlockIds.length : 0,
      failedCount: Array.isArray(job.failedBlockIds) ? job.failedBlockIds.length : 0
    },
    agent: {
      checklistCount: Array.isArray(agent.checklist) ? agent.checklist.length : 0,
      reportCount: Array.isArray(agent.reports) ? agent.reports.length : 0,
      patchHistoryCount: Array.isArray(agent.patchHistory) ? agent.patchHistory.length : 0,
      toolNames
    },
    logsCount: Array.isArray(src.logs) ? src.logs.length : 0
  };
}

function summarizeState(statePayload) {
  const src = statePayload && typeof statePayload === 'object' ? statePayload : {};
  const state = src.lastState && typeof src.lastState === 'object' ? src.lastState : src;
  return {
    tabId: src.tabId || null,
    jobId: src.jobId || null,
    status: state.status || null,
    stage: state.stage || null,
    pending: state.pending || state.pendingCount || null,
    done: state.done || state.doneCount || null,
    failed: state.failed || state.failedCount || null,
    leaseUntilTs: state.leaseUntilTs || null,
    hasLastError: Boolean(state.lastError),
    lastError: state.lastError || null
  };
}

function collectIssueBundle({ attempt, testLogPath, testLogText }) {
  const parsed = parseFailingTests(testLogText);
  const resultFiles = listFilesRecursive(RESULTS_DIR);
  const rel = (fullPath) => normalizeRelPath(path.relative(ROOT, fullPath));

  const reportFiles = resultFiles
    .filter((fullPath) => /\.report\.json$/i.test(fullPath))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, 6);

  const stateFiles = resultFiles
    .filter((fullPath) => /\.state\.json$/i.test(fullPath))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, 6);

  const reportJsonSummary = reportFiles.map((fullPath) => ({
    file: rel(fullPath),
    summary: summarizeReport(readJsonSafe(fullPath, {}))
  }));

  const lastJobState = stateFiles.length
    ? summarizeState(readJsonSafe(stateFiles[0], {}))
    : null;

  const artifacts = resultFiles
    .filter((fullPath) => /(trace\.zip|screenshot|video|\.png$|\.jpg$|\.jpeg$|\.webm$|\.mp4$)/i.test(fullPath))
    .map(rel)
    .slice(-120);

  const packageJson = readJsonSafe(path.join(ROOT, 'package.json'), {});

  return {
    attempt,
    repoSummary: {
      name: packageJson && packageJson.name ? packageJson.name : 'unknown',
      cwd: ROOT,
      scripts: packageJson && packageJson.scripts ? {
        testE2eReal: packageJson.scripts['test:e2e:real'] || null,
        testManifestAudit: packageJson.scripts['test:manifest-audit'] || null,
        testUnitPipeline: packageJson.scripts['test:unit:pipeline'] || null
      } : null,
      focusFiles: [
        'extension/bg/background-app.js',
        'tests/e2e/fixtures/extension-fixture.js',
        'tests/e2e/real-fimfiction-uno.spec.js'
      ]
    },
    failingTests: parsed.failingTests,
    stack: parsed.stack,
    lastJobState,
    reportJsonSummary,
    artifacts,
    logExcerpt: limitText(redactText(testLogText), 30000),
    keyConstraints: [
      'MV3 SW can be terminated on idle; do not leave RUNNING forever.',
      'Offscreen: only one offscreen document may be open.',
      'Playwright extension tests: Chromium + persistent context.',
      'OpenAI tool calling: function_call_output must reference call_id.',
      'Streaming SSE: output_text.delta and response.completed.',
      'Do not log or persist OPENAI_API_KEY or secrets.',
      'Patch must be minimal and limited to extension/, tests/, tools/.'
    ],
    sourceLog: normalizeRelPath(path.relative(ROOT, testLogPath))
  };
}

function selectModel() {
  const explicit = String(process.env.AUTOFIX_MODEL || '').trim();
  if (explicit) {
    return explicit;
  }
  return MODEL_ALLOWLIST[0];
}

function extractOutputText(responseJson) {
  if (responseJson && typeof responseJson.output_text === 'string' && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }

  const collect = [];
  const output = Array.isArray(responseJson && responseJson.output) ? responseJson.output : [];
  output.forEach((item) => {
    const content = Array.isArray(item && item.content) ? item.content : [];
    content.forEach((entry) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      if (typeof entry.text === 'string' && (entry.type === 'output_text' || entry.type === 'text')) {
        collect.push(entry.text);
      }
    });
  });

  return collect.join('\n').trim();
}

function normalizePatchText(rawText) {
  let out = String(rawText || '').trim();
  if (!out) {
    return '';
  }

  if (out.startsWith('```')) {
    out = out.replace(/^```(?:diff)?\s*/i, '');
    out = out.replace(/```\s*$/i, '');
    out = out.trim();
  }

  const diffIdx = out.indexOf('diff --git ');
  if (diffIdx >= 0) {
    out = out.slice(diffIdx).trim();
  }

  return out;
}

async function requestPatchFromModel(issueBundle) {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for autofix');
  }

  const model = selectModel();
  const systemPrompt = [
    'You are a patch generator.',
    'Return ONLY a unified diff patch (diff --git format).',
    'Make minimal targeted edits for the failing tests only.',
    'Do not touch secrets, do not add remote code, and do not change manifest permissions without explicit cause.',
    'Respect MV3 constraints, function_call_output call_id linkage, and lease/watchdog behavior.'
  ].join(' ');

  const payload = {
    model,
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: systemPrompt }]
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: JSON.stringify(issueBundle, null, 2) }]
      }
    ],
    max_output_tokens: 3200,
    stream: false
  };

  const response = await fetch(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Responses API failed: ${response.status} ${response.statusText} ${limitText(redactText(body), 1000)}`);
  }

  const json = await response.json();
  const text = extractOutputText(json);
  const patchText = normalizePatchText(text);
  if (!patchText) {
    throw new Error('Model returned empty patch text');
  }

  if (!patchText.includes('diff --git ')) {
    throw new Error('Model output is not unified diff (missing diff --git header)');
  }

  return patchText;
}

function touchedPathsFromPatch(patchText) {
  const lines = String(patchText || '').split(/\r?\n/);
  const files = [];
  lines.forEach((line) => {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (!m) {
      return;
    }
    files.push(normalizeRelPath(m[1]));
    files.push(normalizeRelPath(m[2]));
  });
  return Array.from(new Set(files));
}

function assertPatchSafety(patchText) {
  const touched = touchedPathsFromPatch(patchText)
    .filter((item) => item && item !== '/dev/null');

  if (!touched.length) {
    throw new Error('Patch does not touch any files');
  }

  touched.forEach((filePath) => {
    if (filePath.startsWith('/') || filePath.includes('..')) {
      throw new Error(`Unsafe file path in patch: ${filePath}`);
    }
    const allowed = ALLOWED_PATCH_PREFIXES.some((prefix) => filePath.startsWith(prefix));
    if (!allowed) {
      throw new Error(`Patch touches disallowed path: ${filePath}`);
    }
  });

  const addedLines = String(patchText || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'));

  const dangerousSecret = addedLines.find((line) => {
    const content = line.slice(1);
    return /sk-[A-Za-z0-9_-]{20,}/.test(content)
      || /OPENAI_API_KEY\s*=/.test(content)
      || /authorization\s*:\s*bearer\s+[A-Za-z0-9._-]{20,}/i.test(content)
      || /api[_-]?key\s*[=:]\s*['"][^'\"]+['"]/i.test(content);
  });

  if (dangerousSecret) {
    throw new Error('Patch appears to add secret material');
  }

  if (addedLines.length > 1200) {
    throw new Error(`Patch too large (${addedLines.length} added lines)`);
  }
}

function parsePathToken(token) {
  const raw = String(token || '').trim().split(/\t/)[0];
  if (!raw || raw === '/dev/null') {
    return null;
  }
  return normalizeRelPath(raw.replace(/^a\//, '').replace(/^b\//, ''));
}

function parseUnifiedDiff(patchText) {
  const lines = String(patchText || '').replace(/\r\n/g, '\n').split('\n');
  const files = [];
  let current = null;
  let i = 0;

  const pushCurrent = () => {
    if (current) {
      files.push(current);
      current = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const diffMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (diffMatch) {
      pushCurrent();
      current = {
        oldPath: normalizeRelPath(diffMatch[1]),
        newPath: normalizeRelPath(diffMatch[2]),
        hunks: []
      };
      i += 1;
      continue;
    }

    if (!current) {
      i += 1;
      continue;
    }

    if (line.startsWith('--- ')) {
      current.oldPath = parsePathToken(line.slice(4));
      i += 1;
      continue;
    }

    if (line.startsWith('+++ ')) {
      current.newPath = parsePathToken(line.slice(4));
      i += 1;
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkMatch) {
      const hunk = {
        oldStart: Number(hunkMatch[1]),
        oldCount: Number(hunkMatch[2] || '1'),
        newStart: Number(hunkMatch[3]),
        newCount: Number(hunkMatch[4] || '1'),
        lines: []
      };
      i += 1;
      while (i < lines.length) {
        const next = lines[i];
        if (next.startsWith('diff --git ') || next.startsWith('@@ ')) {
          break;
        }
        if (/^[ +\-]/.test(next) || next.startsWith('\\')) {
          hunk.lines.push(next);
          i += 1;
          continue;
        }
        break;
      }
      current.hunks.push(hunk);
      continue;
    }

    i += 1;
  }

  pushCurrent();
  return files;
}

function readFileLines(absPath) {
  if (!fs.existsSync(absPath)) {
    return { exists: false, lines: [], hadFinalNewline: true };
  }
  const raw = fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
  const hadFinalNewline = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (hadFinalNewline) {
    lines.pop();
  }
  return {
    exists: true,
    lines,
    hadFinalNewline
  };
}

function oldLinesFromHunk(hunk) {
  const out = [];
  (hunk.lines || []).forEach((line) => {
    const type = line[0];
    if (type === ' ' || type === '-') {
      out.push(line.slice(1));
    }
  });
  return out;
}

function matchesHunkAt(lines, hunk, startIndex) {
  const oldLines = oldLinesFromHunk(hunk);
  if ((startIndex + oldLines.length) > lines.length) {
    return false;
  }
  for (let i = 0; i < oldLines.length; i += 1) {
    if (lines[startIndex + i] !== oldLines[i]) {
      return false;
    }
  }
  return true;
}

function findHunkPosition(lines, hunk, expectedIndex) {
  const expected = Math.max(0, Math.min(lines.length, expectedIndex));
  if (matchesHunkAt(lines, hunk, expected)) {
    return expected;
  }

  const radius = 260;
  const start = Math.max(0, expected - radius);
  const end = Math.min(lines.length, expected + radius);
  for (let pos = start; pos <= end; pos += 1) {
    if (matchesHunkAt(lines, hunk, pos)) {
      return pos;
    }
  }

  for (let pos = 0; pos <= lines.length; pos += 1) {
    if (matchesHunkAt(lines, hunk, pos)) {
      return pos;
    }
  }

  return -1;
}

function applyHunkToLines(lines, hunk, expectedIndex, filePath) {
  const pos = findHunkPosition(lines, hunk, expectedIndex);
  if (pos < 0) {
    throw new Error(`Cannot place hunk for ${filePath} near line ${hunk.oldStart}`);
  }

  const replacement = [];
  let consumeCount = 0;
  let cursor = pos;

  (hunk.lines || []).forEach((line) => {
    const type = line[0];
    const content = line.slice(1);
    if (type === ' ') {
      if (lines[cursor] !== content) {
        throw new Error(`Context mismatch in ${filePath} at line ${cursor + 1}`);
      }
      replacement.push(lines[cursor]);
      cursor += 1;
      consumeCount += 1;
      return;
    }
    if (type === '-') {
      if (lines[cursor] !== content) {
        throw new Error(`Remove mismatch in ${filePath} at line ${cursor + 1}`);
      }
      cursor += 1;
      consumeCount += 1;
      return;
    }
    if (type === '+') {
      replacement.push(content);
      return;
    }
    if (type === '\\') {
      return;
    }
    throw new Error(`Unsupported diff marker "${type}" in ${filePath}`);
  });

  lines.splice(pos, consumeCount, ...replacement);
  return replacement.length - consumeCount;
}

function applyPatchManually(patchText) {
  const parsed = parseUnifiedDiff(patchText);
  if (!parsed.length) {
    throw new Error('No file hunks found for manual patch apply');
  }

  const actions = [];

  parsed.forEach((filePatch) => {
    const oldPath = filePatch.oldPath;
    const newPath = filePatch.newPath;
    const sourceRel = oldPath || newPath;
    if (!sourceRel) {
      throw new Error('Invalid patch entry without path');
    }

    const sourceAbs = oldPath ? path.join(ROOT, oldPath) : null;
    const source = sourceAbs ? readFileLines(sourceAbs) : { exists: false, lines: [], hadFinalNewline: true };
    const working = source.lines.slice();

    let offset = 0;
    (filePatch.hunks || []).forEach((hunk) => {
      const expected = Math.max(0, (Number(hunk.oldStart) || 1) - 1 + offset);
      const delta = applyHunkToLines(working, hunk, expected, sourceRel);
      offset += delta;
    });

    if (newPath === null) {
      if (oldPath) {
        actions.push({ type: 'delete', relPath: oldPath });
      }
      return;
    }

    actions.push({
      type: 'write',
      relPath: newPath,
      content: `${working.join('\n')}\n`
    });

    if (oldPath && oldPath !== newPath) {
      actions.push({ type: 'delete', relPath: oldPath });
    }
  });

  actions.forEach((action) => {
    const relPath = normalizeRelPath(action.relPath);
    const absPath = path.join(ROOT, relPath);
    if (action.type === 'write') {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, action.content, 'utf8');
      return;
    }
    if (action.type === 'delete') {
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
      }
    }
  });

  return { ok: true, method: 'manual', actions: actions.length };
}

function applyPatch(patchText) {
  const hasGitRepo = fs.existsSync(path.join(ROOT, '.git'));
  const gitAvailable = spawnSync('git', ['--version'], { cwd: ROOT, encoding: 'utf8' });
  const canUseGit = hasGitRepo && !gitAvailable.error && gitAvailable.status === 0;

  if (canUseGit) {
    const check = spawnSync('git', ['apply', '--check', '--whitespace=nowarn', '-'], {
      cwd: ROOT,
      input: patchText,
      encoding: 'utf8'
    });
    if (check.status === 0) {
      const applyRes = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], {
        cwd: ROOT,
        input: patchText,
        encoding: 'utf8'
      });
      if (applyRes.status === 0) {
        return { ok: true, method: 'git' };
      }
      throw new Error(`git apply failed: ${limitText((applyRes.stderr || applyRes.stdout || '').trim(), 500)}`);
    }
  }

  return applyPatchManually(patchText);
}

function runValidationChecks(attempt) {
  const npm = npmCommand();
  const checks = [
    { script: 'test:manifest-audit', logName: `autofix-check-manifest-attempt-${attempt}.log` },
    { script: 'test:unit:pipeline', logName: `autofix-check-unit-attempt-${attempt}.log` }
  ];

  return checks.map((check) => {
    const logPath = path.join(LOG_DIR, check.logName);
    const result = runCommandCapture({
      command: npm,
      args: ['run', check.script],
      logPath
    });
    return {
      script: check.script,
      status: result.status,
      logPath: normalizeRelPath(path.relative(ROOT, logPath))
    };
  });
}

async function main() {
  ensureDirSync(LOG_DIR);

  const npm = npmCommand();
  for (let runIndex = 1; runIndex <= (MAX_FIX_ATTEMPTS + 1); runIndex += 1) {
    const testLogPath = path.join(LOG_DIR, `real-e2e-attempt-${runIndex}.log`);
    const runResult = runCommandCapture({
      command: npm,
      args: ['run', 'test:e2e:real'],
      logPath: testLogPath
    });

    if (runResult.status === 0) {
      console.log(`PASS: real e2e passed on run ${runIndex}`);
      process.exit(0);
    }

    if (runResult.launchError) {
      console.error(`FAIL: unable to start test process on run ${runIndex}: ${runResult.launchError}`);
      console.error('Aborting autofix loop because this is an environment/runtime launch issue, not a test assertion failure.');
      process.exit(1);
    }

    console.error(`FAIL: real e2e failed on run ${runIndex}`);

    const fixAttempt = runIndex;
    if (fixAttempt > MAX_FIX_ATTEMPTS) {
      break;
    }

    const issueBundle = collectIssueBundle({
      attempt: fixAttempt,
      testLogPath,
      testLogText: runResult.combined
    });

    const bundlePath = path.join(LOG_DIR, `issue-bundle-attempt-${fixAttempt}.json`);
    await fsp.writeFile(bundlePath, `${JSON.stringify(issueBundle, null, 2)}\n`, 'utf8');

    let patchText = '';
    try {
      patchText = await requestPatchFromModel(issueBundle);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.error(`Autofix request failed: ${message}`);
      continue;
    }

    const patchPath = path.join(LOG_DIR, `patch-attempt-${fixAttempt}.diff`);
    await fsp.writeFile(patchPath, `${patchText}\n`, 'utf8');

    try {
      assertPatchSafety(patchText);
    } catch (error) {
      console.error(`Patch rejected by safety checks: ${error && error.message ? error.message : String(error)}`);
      continue;
    }

    try {
      const applyResult = applyPatch(patchText);
      console.log(`Patch applied via ${applyResult.method}`);
    } catch (error) {
      console.error(`Patch apply failed: ${error && error.message ? error.message : String(error)}`);
      continue;
    }

    const checks = runValidationChecks(fixAttempt);
    checks.forEach((item) => {
      const status = item.status === 0 ? 'PASS' : 'FAIL';
      console.log(`check ${item.script}: ${status} (${item.logPath})`);
    });
  }

  console.error(`FAIL: real e2e still failing after ${MAX_FIX_ATTEMPTS} attempt(s)`);
  process.exit(1);
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error(`autofix-real-e2e failed: ${message}`);
  process.exit(1);
});
