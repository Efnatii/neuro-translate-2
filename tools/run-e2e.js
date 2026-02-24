#!/usr/bin/env node
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const out = {
    mode: null,
    grep: null,
    realSubset: false,
    realFimfiction: false,
    passthrough: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (!arg) {
      continue;
    }
    if (arg === '--mode' && argv[i + 1]) {
      out.mode = String(argv[i + 1]).trim().toLowerCase();
      i += 1;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      out.mode = arg.split('=')[1].trim().toLowerCase();
      continue;
    }
    if (arg === '--grep' && argv[i + 1]) {
      out.grep = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--grep=')) {
      out.grep = arg.slice('--grep='.length);
      continue;
    }
    if (arg === '--real-subset') {
      out.realSubset = true;
      continue;
    }
    if (arg === '--real-fimfiction') {
      out.realFimfiction = true;
      continue;
    }
    out.passthrough.push(arg);
  }

  return out;
}

const parsed = parseArgs(process.argv.slice(2));
const mode = parsed.mode === 'real' ? 'real' : 'mock';
const grep = parsed.grep || (parsed.realSubset ? 'C1:|C3: cancel|C5:' : null);

const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = ['playwright', 'test'];
if (grep) {
  args.push('--grep', grep);
}
args.push(...parsed.passthrough);

const env = {
  ...process.env,
  TEST_MODE: mode,
  TEST_REAL_FIMFICTION: parsed.realFimfiction ? '1' : (process.env.TEST_REAL_FIMFICTION || '')
};

const result = spawnSync(cmd, args, {
  stdio: 'inherit',
  env,
  shell: false
});

if (result.error) {
  // eslint-disable-next-line no-console
  console.error(result.error && result.error.message ? result.error.message : String(result.error));
  process.exit(1);
}

process.exit(typeof result.status === 'number' ? result.status : 1);

