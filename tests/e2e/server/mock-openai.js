const http = require('http');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(value, fallback = null) {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function collectUserText(input) {
  const rows = Array.isArray(input) ? input : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row || row.role !== 'user' || !Array.isArray(row.content)) {
      continue;
    }
    for (let j = 0; j < row.content.length; j += 1) {
      const part = row.content[j];
      if (part && part.type === 'input_text' && typeof part.text === 'string') {
        return part.text;
      }
    }
  }
  return '';
}

function extractFunctionCallOutputs(input, callIndex) {
  const rows = Array.isArray(input) ? input : [];
  const out = [];
  rows.forEach((row) => {
    if (!row || row.type !== 'function_call_output' || typeof row.call_id !== 'string') {
      return;
    }
    const toolRef = callIndex.get(row.call_id) || null;
    out.push({
      callId: row.call_id,
      toolName: toolRef ? toolRef.toolName : null,
      output: safeJsonParse(typeof row.output === 'string' ? row.output : JSON.stringify(row.output || {}), null),
      rawOutput: row.output
    });
  });
  return out;
}

function createMockOpenAiServer({ host = '127.0.0.1', port = 0 } = {}) {
  let server = null;
  let listeningPort = null;

  const stats = {
    totalRequests: 0,
    responsesRequests: 0,
    streamRequests: 0,
    nonStreamRequests: 0,
    toolRequests: 0,
    status429: 0
  };
  const recentRequests = [];
  const MAX_RECENT_REQUESTS = 200;
  const callIndex = new Map();
  let responseSeq = 0;
  let callSeq = 0;
  let fail429Remaining = 0;
  let fail429RetryAfterMs = 1200;

  const nextResponseId = () => {
    responseSeq += 1;
    return `resp_mock_${responseSeq}`;
  };
  const nextCallId = () => {
    callSeq += 1;
    return `call_mock_${callSeq}`;
  };
  const pushRecent = (row) => {
    recentRequests.push({
      ts: Date.now(),
      ...(row && typeof row === 'object' ? row : {})
    });
    if (recentRequests.length > MAX_RECENT_REQUESTS) {
      recentRequests.splice(0, recentRequests.length - MAX_RECENT_REQUESTS);
    }
  };

  const rateHeaders = () => {
    const remainingRequests = Math.max(0, 500 - stats.responsesRequests);
    const remainingTokens = Math.max(0, 500000 - (stats.responsesRequests * 200));
    return {
      'x-request-id': `mock-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      'x-ratelimit-limit-requests': '500',
      'x-ratelimit-remaining-requests': String(remainingRequests),
      'x-ratelimit-limit-tokens': '500000',
      'x-ratelimit-remaining-tokens': String(remainingTokens),
      'x-ratelimit-reset-requests': '1s',
      'x-ratelimit-reset-tokens': '1s'
    };
  };

  const baseHeaders = () => ({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST,GET,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-nt-token,x-nt-project-id'
  });

  const json = (res, status, payload, headers = {}) => {
    const body = JSON.stringify(payload || {});
    res.writeHead(status, {
      ...baseHeaders(),
      ...rateHeaders(),
      ...headers,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0'
    });
    res.end(body);
  };

  const registerCall = (toolName) => {
    const callId = nextCallId();
    callIndex.set(callId, {
      toolName: String(toolName || ''),
      ts: Date.now()
    });
    return callId;
  };

  const assistantOutput = ({ outputText = 'ok', responseId = null } = {}) => ({
    id: responseId || nextResponseId(),
    output_text: outputText,
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: outputText }]
    }]
  });

  const functionCallOutput = ({ calls, responseId = null } = {}) => ({
    id: responseId || nextResponseId(),
    output_text: '',
    output: (Array.isArray(calls) ? calls : [])
      .map((row) => ({
        type: 'function_call',
        id: `fc_${Math.random().toString(16).slice(2, 10)}`,
        call_id: registerCall(row.name),
        name: row.name,
        arguments: JSON.stringify(row.arguments || {})
      }))
  });

  const planningResponse = (outputs) => {
    const donePlan = outputs.some((row) => row.toolName === 'agent.set_plan');
    const doneCats = outputs.some((row) => row.toolName === 'agent.set_recommended_categories');
    if (!donePlan || !doneCats) {
      return functionCallOutput({
        calls: [
          {
            name: 'agent.set_plan',
            arguments: {
              plan: {
                summary: 'Mock planning completed',
                style: 'balanced',
                batchSize: 4,
                proofreadingPasses: 1,
                instructions: 'Translate accurately and preserve intent.'
              }
            }
          },
          {
            name: 'agent.set_recommended_categories',
            arguments: {
              categories: ['heading', 'paragraph', 'button', 'label'],
              reason: 'mock_default_categories'
            }
          }
        ]
      });
    }
    return assistantOutput({ outputText: 'planning_done' });
  };

  const executionResponse = (outputs) => {
    if (!outputs.length) {
      return functionCallOutput({
        calls: [{ name: 'job.get_next_blocks', arguments: { limit: 1, prefer: 'dom_order' } }]
      });
    }
    const last = outputs[outputs.length - 1];
    if (last.toolName === 'job.get_next_blocks') {
      const rows = last.output && Array.isArray(last.output.blocks) ? last.output.blocks : [];
      const first = rows.length ? rows[0] : null;
      if (!first || !first.blockId) {
        return assistantOutput({ outputText: 'execution_idle' });
      }
      return functionCallOutput({
        calls: [{
          name: 'translator.translate_block_stream',
          arguments: { blockId: first.blockId, style: 'balanced' }
        }]
      });
    }
    if (last.toolName === 'translator.translate_block_stream') {
      const blockId = last.output && typeof last.output.blockId === 'string' ? last.output.blockId : null;
      const text = last.output && typeof last.output.text === 'string' ? last.output.text : '';
      if (!blockId) {
        return functionCallOutput({
          calls: [{ name: 'job.get_next_blocks', arguments: { limit: 1, prefer: 'dom_order' } }]
        });
      }
      return functionCallOutput({
        calls: [{ name: 'job.mark_block_done', arguments: { blockId, text: text || `[RU] ${blockId}` } }]
      });
    }
    return functionCallOutput({
      calls: [{ name: 'job.get_next_blocks', arguments: { limit: 1, prefer: 'dom_order' } }]
    });
  };

  const proofreadingResponse = (outputs) => {
    if (!outputs.length) {
      return functionCallOutput({
        calls: [{ name: 'proof.get_next_blocks', arguments: { limit: 1, prefer: 'dom_order' } }]
      });
    }
    const last = outputs[outputs.length - 1];
    if (last.toolName === 'proof.get_next_blocks') {
      const rows = last.output && Array.isArray(last.output.blocks) ? last.output.blocks : [];
      const first = rows.length ? rows[0] : null;
      if (!first || !first.blockId) {
        return functionCallOutput({
          calls: [{ name: 'proof.finish', arguments: { reason: 'mock_empty_pending' } }]
        });
      }
      return functionCallOutput({
        calls: [{
          name: 'proof.proofread_block_stream',
          arguments: {
            blockId: first.blockId,
            mode: 'proofread',
            style: 'balanced',
            strictness: 'normal'
          }
        }]
      });
    }
    if (last.toolName === 'proof.proofread_block_stream') {
      const blockId = last.output && typeof last.output.blockId === 'string' ? last.output.blockId : null;
      const text = last.output && typeof last.output.text === 'string' ? last.output.text : '';
      if (!blockId) {
        return functionCallOutput({
          calls: [{ name: 'proof.get_next_blocks', arguments: { limit: 1, prefer: 'dom_order' } }]
        });
      }
      return functionCallOutput({
        calls: [{
          name: 'proof.mark_block_done',
          arguments: {
            blockId,
            text: text || `[RU-proofread] ${blockId}`,
            qualityTag: 'proofread'
          }
        }]
      });
    }
    if (last.toolName === 'proof.mark_block_done' || last.toolName === 'proof.mark_block_failed') {
      return functionCallOutput({
        calls: [{ name: 'proof.get_next_blocks', arguments: { limit: 1, prefer: 'dom_order' } }]
      });
    }
    if (last.toolName === 'proof.finish') {
      return assistantOutput({ outputText: 'proofreading_done' });
    }
    return functionCallOutput({
      calls: [{ name: 'proof.get_next_blocks', arguments: { limit: 1, prefer: 'dom_order' } }]
    });
  };

  const pickToolModeResponse = (body, outputs) => {
    const toolNames = new Set((Array.isArray(body.tools) ? body.tools : [])
      .map((row) => (row && typeof row.name === 'string' ? row.name : '')));
    if (toolNames.has('agent.set_plan') && toolNames.has('agent.set_recommended_categories')) {
      return planningResponse(outputs);
    }
    if (toolNames.has('job.get_next_blocks') && toolNames.has('translator.translate_block_stream')) {
      return executionResponse(outputs);
    }
    if (toolNames.has('proof.get_next_blocks') && toolNames.has('proof.proofread_block_stream')) {
      return proofreadingResponse(outputs);
    }
    return assistantOutput({ outputText: 'mock_tool_ack' });
  };

  const streamTranslation = async (res, body) => {
    const sourceText = collectUserText(body.input) || '';
    const compact = sourceText.replace(/\s+/g, ' ').trim();
    const translated = `RU: ${compact || 'ok'}`;
    const chunkSize = Math.max(8, Math.ceil(translated.length / 3));
    const chunks = [];
    for (let i = 0; i < translated.length; i += chunkSize) {
      chunks.push(translated.slice(i, i + chunkSize));
    }
    const responseId = nextResponseId();
    res.writeHead(200, {
      ...baseHeaders(),
      ...rateHeaders(),
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'cache-control': 'no-cache, no-transform'
    });
    for (let i = 0; i < chunks.length; i += 1) {
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: chunks[i] })}\n\n`);
      await delay(220);
    }
    res.write(`data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: responseId,
        output_text: translated,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: translated }] }]
      }
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  };

  const handle = async (req, res) => {
    stats.totalRequests += 1;
    const url = req.url ? req.url.split('?')[0] : '/';
    if (req.method === 'OPTIONS') {
      pushRecent({ method: req.method, url, status: 204 });
      res.writeHead(204, baseHeaders());
      res.end();
      return;
    }
    if (req.method === 'GET' && url === '/v1/models') {
      pushRecent({ method: req.method, url, status: 200, kind: 'models' });
      json(res, 200, { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4.1-mini' }] });
      return;
    }
    if (req.method !== 'POST' || url !== '/v1/responses') {
      pushRecent({ method: req.method, url, status: 404, kind: 'not_found' });
      json(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      return;
    }
    stats.responsesRequests += 1;
    const bodyText = await new Promise((resolve) => {
      let buffer = '';
      req.on('data', (chunk) => { buffer += String(chunk || ''); });
      req.on('end', () => resolve(buffer));
      req.on('error', () => resolve(''));
    });
    const body = safeJsonParse(bodyText, {});
    if (fail429Remaining > 0) {
      fail429Remaining -= 1;
      stats.status429 += 1;
      pushRecent({
        method: req.method,
        url,
        status: 429,
        kind: 'forced_429',
        stream: body.stream === true,
        hasTools
      });
      json(res, 429, { error: { code: 'rate_limit_exceeded', message: 'mock_429' } }, {
        'retry-after-ms': String(Math.max(200, Math.round(fail429RetryAfterMs))),
        'retry-after': String(Math.max(1, Math.ceil(fail429RetryAfterMs / 1000)))
      });
      return;
    }
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (hasTools) {
      stats.toolRequests += 1;
    }
    if (body.stream === true) {
      stats.streamRequests += 1;
      pushRecent({
        method: req.method,
        url,
        status: 200,
        kind: 'responses_stream',
        stream: true,
        hasTools,
        previousResponseId: typeof body.previous_response_id === 'string' ? body.previous_response_id : null,
        inputItems: Array.isArray(body.input) ? body.input.length : 0
      });
      await streamTranslation(res, body);
      return;
    }
    stats.nonStreamRequests += 1;
    const outputs = extractFunctionCallOutputs(body.input, callIndex);
    pushRecent({
      method: req.method,
      url,
      status: 200,
      kind: 'responses',
      stream: false,
      hasTools,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      outputItems: outputs.length,
      previousResponseId: typeof body.previous_response_id === 'string' ? body.previous_response_id : null,
      inputItems: Array.isArray(body.input) ? body.input.length : 0
    });
    const response = hasTools
      ? pickToolModeResponse(body, outputs)
      : assistantOutput({ outputText: body && body.input ? '.' : 'ok' });
    json(res, 200, response);
  };

  return {
    async start() {
      if (server) {
        return this;
      }
      server = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
          json(res, 500, { error: { code: 'MOCK_SERVER_ERROR', message: error && error.message ? error.message : 'mock failure' } });
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const addr = server.address();
      listeningPort = addr && typeof addr.port === 'number' ? addr.port : null;
      return this;
    },

    async stop() {
      if (!server) {
        return;
      }
      const current = server;
      server = null;
      listeningPort = null;
      await new Promise((resolve) => current.close(() => resolve()));
    },

    resetStats() {
      Object.keys(stats).forEach((key) => { stats[key] = 0; });
      recentRequests.splice(0, recentRequests.length);
      callIndex.clear();
      responseSeq = 0;
      callSeq = 0;
      fail429Remaining = 0;
      fail429RetryAfterMs = 1200;
    },

    getStats() {
      return { ...stats };
    },

    getRecentRequests(limit = 60) {
      const max = Math.max(1, Math.min(200, Math.round(Number(limit) || 60)));
      return recentRequests.slice(-max).map((row) => ({ ...row }));
    },

    set429Sequence({ count = 1, retryAfterMs = 1200 } = {}) {
      fail429Remaining = Math.max(0, Math.round(Number(count) || 0));
      fail429RetryAfterMs = Math.max(200, Math.round(Number(retryAfterMs) || 1200));
    },

    get origin() {
      return listeningPort ? `http://${host}:${listeningPort}` : null;
    }
  };
}

module.exports = {
  createMockOpenAiServer
};
