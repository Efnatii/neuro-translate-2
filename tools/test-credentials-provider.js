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
  load('extension/bg/credentials-provider.js');

  const CredentialsProvider = global.NT.CredentialsProvider;
  assert(CredentialsProvider, 'CredentialsProvider must be defined');

  const store = {
    mode: 'PROXY',
    byokKey: '',
    proxy: {
      baseUrl: 'https://proxy.example.com',
      authHeaderName: 'X-NT-Token',
      authToken: 'proxy-secret-token',
      projectId: 'proj-1'
    },
    async getMode() {
      return this.mode;
    },
    async getByokKey() {
      return this.byokKey;
    },
    async getProxyConfig() {
      return { ...this.proxy };
    }
  };

  const provider = new CredentialsProvider({ credentialsStore: store });
  const proxyHeaders = await provider.buildRequestAuthHeaders({ target: 'proxy' });
  assert.strictEqual(proxyHeaders.Authorization, undefined, 'PROXY mode must not produce Authorization header');
  assert.strictEqual(proxyHeaders['X-NT-Token'], 'proxy-secret-token', 'PROXY mode should use proxy token header');
  assert.strictEqual(proxyHeaders['X-NT-Project-ID'], 'proj-1', 'PROXY mode should pass optional project header');

  const proxyCtx = await provider.buildConnectionContext({ stage: 'test_proxy' });
  assert.strictEqual(proxyCtx.mode, 'PROXY', 'Connection context should preserve PROXY mode');
  assert(proxyCtx.responsesUrl.endsWith('/v1/responses'), 'PROXY responses URL must target /v1/responses');
  assert.strictEqual(proxyCtx.endpointHost, 'proxy.example.com', 'PROXY endpoint host must be parsed');

  store.mode = 'BYOK';
  store.byokKey = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
  const byokHeaders = await provider.buildRequestAuthHeaders({ target: 'openai' });
  assert(typeof byokHeaders.Authorization === 'string', 'BYOK mode must produce Authorization header');
  assert(byokHeaders.Authorization.startsWith('Bearer '), 'BYOK Authorization header must be bearer token');

  const byokCtx = await provider.buildConnectionContext({ stage: 'test_byok' });
  assert.strictEqual(byokCtx.mode, 'BYOK', 'Connection context should preserve BYOK mode');
  assert.strictEqual(byokCtx.endpointHost, 'api.openai.com', 'BYOK endpoint host should be OpenAI');
  assert.strictEqual(byokCtx.hasAuth, true, 'BYOK context must indicate auth presence');

  console.log('PASS: credentials provider');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
