/**
 * Tool Manifest v1 for Neuro Translate tool-calling agents.
 *
 * Provides:
 * - Stable tool contract metadata (name/version/schema/capabilities/QoS).
 * - Deterministic toolset hash.
 * - Responses API tools projection.
 */
(function initToolManifest(global) {
  const NT = global.NT || (global.NT = {});

  function cloneJson(value, fallback = null) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return fallback;
    }
  }

  function stableStringify(value) {
    const normalize = (input) => {
      if (Array.isArray(input)) {
        return input.map((item) => normalize(item));
      }
      if (input && typeof input === 'object') {
        const out = {};
        Object.keys(input).sort().forEach((key) => {
          out[key] = normalize(input[key]);
        });
        return out;
      }
      return input;
    };
    return JSON.stringify(normalize(value));
  }

  // Synchronous SHA-256 implementation (deterministic hash for manifest contract).
  function sha256Hex(text) {
    const src = String(text || '');
    function rightRotate(value, amount) {
      return (value >>> amount) | (value << (32 - amount));
    }
    const mathPow = Math.pow;
    const maxWord = mathPow(2, 32);
    const words = [];
    const asciiBitLength = src.length * 8;
    let hash = sha256Hex._hash;
    let k = sha256Hex._k;
    if (!hash || !k) {
      hash = sha256Hex._hash = [];
      k = sha256Hex._k = [];
      let primeCounter = 0;
      const isComposite = {};
      for (let candidate = 2; primeCounter < 64; candidate += 1) {
        if (!isComposite[candidate]) {
          for (let i = 0; i < 313; i += candidate) {
            isComposite[i] = candidate;
          }
          hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
          k[primeCounter] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
          primeCounter += 1;
        }
      }
    }
    src.split('').forEach((char, idx) => {
      const code = char.charCodeAt(0);
      words[idx >> 2] |= code << ((3 - (idx % 4)) * 8);
    });
    words[asciiBitLength >> 5] |= 0x80 << (24 - (asciiBitLength % 32));
    words[(((asciiBitLength + 64) >> 9) << 4) + 15] = asciiBitLength;
    let w = [];
    for (let j = 0; j < words.length;) {
      const oldHash = hash.slice(0);
      const slice = words.slice(j, j += 16);
      w = slice.slice(0);
      for (let i = 0; i < 64; i += 1) {
        const w15 = w[i - 15];
        const w2 = w[i - 2];
        const a = hash[0];
        const e = hash[4];
        const temp1 = hash[7]
          + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
          + ((e & hash[5]) ^ ((~e) & hash[6]))
          + k[i]
          + (w[i] = (i < 16)
            ? w[i]
            : (
              w[i - 16]
              + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
              + w[i - 7]
              + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
            ) | 0);
        const temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
          + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
        hash.pop();
      }
      for (let i = 0; i < 8; i += 1) {
        hash[i] = (hash[i] + oldHash[i]) | 0;
      }
    }
    let out = '';
    for (let i = 0; i < 8; i += 1) {
      for (let j = 3; j >= 0; j -= 1) {
        const b = (hash[i] >> (j * 8)) & 255;
        out += ((b < 16) ? '0' : '') + b.toString(16);
      }
    }
    return out;
  }

  function defaultToolDefinitions() {
    return [
      {
        name: 'page.get_stats',
        toolVersion: '1.0.0',
        description: 'Return category/page/reuse stats for scanned blocks.',
        parametersJsonSchema: { type: 'object', additionalProperties: false, properties: {} },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { cacheTtlMs: 250, queueDepthLimit: 200 },
        idempotency: { mode: 'by_args_hash' },
        sideEffects: { category: 'none' },
        stages: ['planning', 'execution']
      },
      {
        name: 'page.get_blocks',
        toolVersion: '1.0.0',
        description: 'Return compact page blocks subset.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            categories: { type: 'array', items: { type: 'string' } },
            limit: { type: 'integer', minimum: 1, maximum: 120 },
            offset: { type: 'integer', minimum: 0 },
            order: { type: 'string', enum: ['by_length_desc', 'by_dom'] }
          }
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { cacheTtlMs: 250, queueDepthLimit: 200 },
        idempotency: { mode: 'by_args_hash' },
        sideEffects: { category: 'none' },
        stages: ['planning', 'execution']
      },
      {
        name: 'agent.set_tool_config',
        toolVersion: '1.0.0',
        description: 'Set requested tool modes and resolve effective configuration.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            toolConfig: {
              type: 'object',
              additionalProperties: { type: 'string', enum: ['on', 'off', 'auto'] }
            },
            reason: { type: 'string' }
          },
          required: ['toolConfig']
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 120 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['planning', 'execution']
      },
      {
        name: 'agent.propose_tool_policy',
        toolVersion: '1.0.0',
        description: 'Agent proposes tool policy; effective policy is recomputed with capabilities.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            proposal: {
              type: 'object',
              additionalProperties: { type: 'string', enum: ['on', 'off', 'auto'] }
            },
            reason: { type: 'string' }
          },
          required: ['proposal']
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 120 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['planning', 'execution']
      },
      {
        name: 'agent.get_tool_context',
        toolVersion: '1.0.0',
        description: 'Returns toolset hash, effective policy, and capability summary.',
        parametersJsonSchema: { type: 'object', additionalProperties: false, properties: {} },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { cacheTtlMs: 250, queueDepthLimit: 200 },
        idempotency: { mode: 'by_args_hash' },
        sideEffects: { category: 'none' },
        stages: ['planning', 'execution']
      },
      {
        name: 'agent.get_autotune_context',
        toolVersion: '1.0.0',
        description: 'Returns job/page/runtime/settings context for AutoTune decisions.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            stage: { type: 'string', enum: ['planning', 'execution'] }
          }
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { cacheTtlMs: 250, queueDepthLimit: 200 },
        idempotency: { mode: 'by_args_hash' },
        sideEffects: { category: 'none' },
        stages: ['planning', 'execution']
      },
      {
        name: 'agent.propose_run_settings_patch',
        toolVersion: '1.1.0',
        description: 'Propose validated job-scoped run settings patch.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            stage: { type: 'string', enum: ['planning', 'execution'] },
            patch: {
              type: 'object',
              additionalProperties: false,
              properties: {
                reasoning: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    mode: { type: 'string', enum: ['auto', 'custom'] },
                    effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'max'] },
                    summary: { type: 'string', enum: ['auto', 'none', 'short', 'detailed'] }
                  }
                },
                caching: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    promptCacheRetention: { type: 'string', enum: ['auto', 'in_memory', 'extended', 'disabled'] },
                    compatCache: { type: 'boolean' }
                  }
                },
                tools: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    proposal: {
                      type: 'object',
                      additionalProperties: { type: 'string', enum: ['on', 'off', 'auto'] }
                    }
                  }
                },
                models: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    routingMode: { type: 'string', enum: ['auto', 'user_priority', 'profile_priority'] },
                    userPriority: { type: 'array', items: { type: 'string', maxLength: 120 }, maxItems: 20 },
                    preferredRoute: { type: 'string', enum: ['auto', 'fast', 'strong'] }
                  }
                },
                responses: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    parallel_tool_calls: { type: 'boolean' },
                    truncation: { type: 'string', enum: ['auto', 'disabled'] }
                  }
                },
                translation: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    style: { type: 'string', enum: ['auto', 'literal', 'readable', 'technical', 'balanced'] },
                    batchGuidance: { type: 'string', maxLength: 2000 },
                    proofreadPasses: { type: 'integer', minimum: 0, maximum: 8 }
                  }
                }
              }
            },
            reason: {
              type: 'object',
              additionalProperties: false,
              properties: {
                short: { type: 'string', maxLength: 260 },
                detailed: { type: 'string', maxLength: 2000 },
                signals: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    rateLimitLow: { type: 'boolean' },
                    pageHuge: { type: 'boolean' },
                    domUnstable: { type: 'boolean' },
                    needsLiteral: { type: 'boolean' },
                    needsGlossary: { type: 'boolean' }
                  }
                }
              },
              required: ['short']
            }
          },
          required: ['stage', 'patch', 'reason']
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 120 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['planning', 'execution']
      },
      {
        name: 'agent.apply_run_settings_proposal',
        toolVersion: '1.0.0',
        description: 'Apply pending AutoTune proposal to current job run settings.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            proposalId: { type: 'string' },
            confirmedByUser: { type: 'boolean' }
          },
          required: ['proposalId']
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 120 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['planning', 'execution']
      },
      {
        name: 'agent.reject_run_settings_proposal',
        toolVersion: '1.0.0',
        description: 'Reject pending AutoTune proposal.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            proposalId: { type: 'string' },
            reason: { type: 'string' }
          },
          required: ['proposalId']
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 120 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['planning', 'execution']
      },
      {
        name: 'agent.explain_current_run_settings',
        toolVersion: '1.0.0',
        description: 'Explain currently effective job run settings.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            stage: { type: 'string', enum: ['planning', 'execution'] }
          }
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { cacheTtlMs: 250, queueDepthLimit: 200 },
        idempotency: { mode: 'by_args_hash' },
        sideEffects: { category: 'none' },
        stages: ['planning', 'execution']
      },
      {
        name: 'agent.set_plan',
        toolVersion: '1.1.0',
        description: 'Set planning result and recommended categories.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            plan: {
              type: 'object',
              additionalProperties: false,
              properties: {
                summary: { type: 'string', maxLength: 2000 },
                style: { type: 'string', enum: ['balanced', 'literal', 'readable', 'technical', 'auto'] },
                batchSize: { type: 'integer', minimum: 1, maximum: 120 },
                proofreadingPasses: { type: 'integer', minimum: 0, maximum: 8 },
                categoryOrder: { type: 'array', items: { type: 'string', maxLength: 120 }, maxItems: 60 },
                instructions: { type: 'string', maxLength: 4000 },
                modelHints: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    strongFor: { type: 'array', items: { type: 'string', maxLength: 120 }, maxItems: 40 },
                    fastFor: { type: 'array', items: { type: 'string', maxLength: 120 }, maxItems: 40 }
                  }
                }
              }
            },
            recommendedCategories: { type: 'array', items: { type: 'string', maxLength: 120 }, maxItems: 60 },
            summary: { type: 'string', maxLength: 2000 },
            style: { type: 'string', enum: ['balanced', 'literal', 'readable', 'technical', 'auto'] },
            batchSize: { type: 'integer', minimum: 1, maximum: 120 },
            proofreadingPasses: { type: 'integer', minimum: 0, maximum: 8 },
            categoryOrder: { type: 'array', items: { type: 'string', maxLength: 120 }, maxItems: 60 },
            instructions: { type: 'string', maxLength: 4000 }
          }
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 120 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['planning']
      },
      {
        name: 'agent.set_recommended_categories',
        toolVersion: '1.0.0',
        description: 'Set categories recommendation for user confirmation.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            categories: { type: 'array', items: { type: 'string' } },
            reason: { type: 'string' }
          },
          required: ['categories']
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 120 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['planning']
      },
      {
        name: 'agent.append_report',
        toolVersion: '1.1.0',
        description: 'Append short human-readable report item.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', maxLength: 80 },
            title: { type: 'string', maxLength: 260 },
            body: { type: 'string', maxLength: 4000 },
            meta: {
              type: 'object',
              additionalProperties: {}
            }
          }
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 220 },
        idempotency: { mode: 'none' },
        sideEffects: { category: 'storage_write' },
        stages: ['planning', 'execution', 'proofreading']
      },
      {
        name: 'agent.update_checklist',
        toolVersion: '1.0.0',
        description: 'Update checklist item state (todo|running|done|failed).',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { itemId: { type: 'string' }, status: { type: 'string', enum: ['todo', 'running', 'done', 'failed'] }, note: { type: 'string' } },
          required: ['itemId', 'status']
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 220 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['planning', 'execution', 'proofreading']
      },
      {
        name: 'agent.compress_context',
        toolVersion: '1.0.0',
        description: 'Compress context into concise summary.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { reason: { type: 'string' }, mode: { type: 'string', enum: ['auto', 'force'] }, maxChars: { type: 'integer' } },
          required: ['reason', 'mode']
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 120 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['planning', 'execution', 'proofreading']
      },
      {
        name: 'memory.build_glossary',
        toolVersion: '1.0.0',
        description: 'Build/update glossary from translated blocks.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { categories: { type: 'array', items: { type: 'string' } }, maxTerms: { type: 'integer' }, mode: { type: 'string', enum: ['auto', 'force'] } }
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 120 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['execution', 'proofreading']
      },
      {
        name: 'memory.update_context_summary',
        toolVersion: '1.0.0',
        description: 'Update compact context summary from current progress.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { reason: { type: 'string' }, maxChars: { type: 'integer' } },
          required: ['reason']
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 120 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['execution', 'proofreading']
      },
      {
        name: 'job.get_next_blocks',
        toolVersion: '1.0.0',
        description: 'Return next pending blocks for execution loop.',
        parametersJsonSchema: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer' }, prefer: { type: 'string' }, categories: { type: 'array', items: { type: 'string' } } } },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { cacheTtlMs: 250, queueDepthLimit: 200 },
        idempotency: { mode: 'by_args_hash' },
        sideEffects: { category: 'none' },
        stages: ['execution']
      },
      {
        name: 'proof.plan_proofreading',
        toolVersion: '1.0.0',
        description: 'Plan proofreading candidates and initialize proofreading stage state.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scope: { type: 'string', enum: ['all_selected_categories', 'category', 'blocks'] },
            category: { type: 'string' },
            blockIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 400 },
            mode: { type: 'string', enum: ['auto', 'manual'] },
            maxBlocks: { type: 'integer', minimum: 1, maximum: 2000 },
            reason: { type: 'string', maxLength: 500 }
          },
          required: ['scope', 'mode']
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 160 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['execution', 'proofreading']
      },
      {
        name: 'proof.get_next_blocks',
        toolVersion: '1.0.0',
        description: 'Return next pending proofreading blocks.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 80 },
            prefer: { type: 'string', enum: ['risk_first', 'long_first', 'dom_order'] }
          }
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { cacheTtlMs: 250, queueDepthLimit: 200 },
        idempotency: { mode: 'by_args_hash' },
        sideEffects: { category: 'none' },
        stages: ['proofreading']
      },
      {
        name: 'proof.proofread_block_stream',
        toolVersion: '1.0.0',
        description: 'Proofread translated block with streaming delta updates.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            blockId: { type: 'string', minLength: 1, maxLength: 240 },
            style: { type: 'string', enum: ['auto', 'technical', 'readable', 'balanced'] },
            strictness: { type: 'string', enum: ['auto', 'light', 'normal', 'strong'] },
            mode: { type: 'string', enum: ['proofread', 'literal', 'style_improve'] },
            model: { type: 'string', maxLength: 120 },
            glossary: {
              type: 'array',
              maxItems: 120,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  term: { type: 'string', minLength: 1, maxLength: 240 },
                  translation: { type: 'string', maxLength: 240 },
                  note: { type: 'string', maxLength: 240 }
                },
                required: ['term']
              }
            },
            contextSummary: { type: 'string', maxLength: 1800 }
          },
          required: ['blockId', 'mode']
        },
        capabilitiesRequired: { content: ['apply_delta'], offscreen: ['stream'], permissions: [] },
        qos: { queueDepthLimit: 80 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'network' },
        stages: ['proofreading']
      },
      {
        name: 'proof.mark_block_done',
        toolVersion: '1.0.0',
        description: 'Persist proofread block result and quality tag.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            blockId: { type: 'string', minLength: 1, maxLength: 240 },
            text: { type: 'string' },
            qualityTag: { type: 'string', enum: ['proofread', 'literal', 'styled'] },
            modelUsed: { type: 'string', maxLength: 120 },
            routeUsed: { type: 'string', maxLength: 60 }
          },
          required: ['blockId', 'text', 'qualityTag']
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 200 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['proofreading']
      },
      {
        name: 'proof.mark_block_failed',
        toolVersion: '1.0.0',
        description: 'Mark proofreading block as failed.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            blockId: { type: 'string', minLength: 1, maxLength: 240 },
            code: { type: 'string', minLength: 1, maxLength: 120 },
            message: { type: 'string', minLength: 1, maxLength: 600 }
          },
          required: ['blockId', 'code', 'message']
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 200 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['proofreading']
      },
      {
        name: 'proof.finish',
        toolVersion: '1.0.0',
        description: 'Finalize proofreading stage if no pending work remains.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            reason: { type: 'string', maxLength: 300 }
          }
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 120 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['proofreading']
      },
      {
        name: 'ui.request_proofread_scope',
        toolVersion: '1.0.0',
        description: 'UI-triggered proofreading request (system tool execution).',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scope: { type: 'string', enum: ['all_selected_categories', 'category', 'blocks'] },
            category: { type: 'string' },
            blockIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 400 },
            mode: { type: 'string', enum: ['auto', 'manual'] }
          },
          required: ['scope', 'mode']
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 80 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['execution', 'proofreading']
      },
      {
        name: 'ui.request_block_action',
        toolVersion: '1.0.0',
        description: 'UI-triggered targeted proofreading action for one block.',
        parametersJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            blockId: { type: 'string', minLength: 1, maxLength: 240 },
            action: { type: 'string', enum: ['literal', 'style_improve'] }
          },
          required: ['blockId', 'action']
        },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 80 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['execution', 'proofreading']
      },
      {
        name: 'translator.translate_block_stream',
        toolVersion: '1.0.0',
        description: 'Translate one block and optionally stream deltas.',
        parametersJsonSchema: { type: 'object', additionalProperties: false, properties: { blockId: { type: 'string' }, targetLang: { type: 'string' }, model: { type: 'string' }, route: { type: 'string' }, style: { type: 'string' }, glossary: { type: 'array' }, contextSummary: { type: 'string' }, batchGuidance: { type: 'string' } }, required: ['blockId'] },
        capabilitiesRequired: { content: [], offscreen: ['stream'], permissions: [] },
        qos: { queueDepthLimit: 80 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'network' },
        stages: ['execution']
      },
      {
        name: 'page.apply_delta',
        toolVersion: '1.0.0',
        description: 'Apply partial translated text on page for one block.',
        parametersJsonSchema: { type: 'object', additionalProperties: false, properties: { blockId: { type: 'string' }, text: { type: 'string' }, isFinal: { type: 'boolean' } }, required: ['blockId', 'text'] },
        capabilitiesRequired: { content: ['apply_delta'], offscreen: [], permissions: [] },
        qos: { coalesceKey: 'blockId', debounceMs: 120, maxPayloadBytes: 50000, queueDepthLimit: 400 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'dom_write' },
        stages: ['execution', 'proofreading']
      },
      {
        name: 'job.mark_block_done',
        toolVersion: '1.0.0',
        description: 'Mark pending block as done and persist translated text.',
        parametersJsonSchema: { type: 'object', additionalProperties: false, properties: { blockId: { type: 'string' }, text: { type: 'string' }, modelUsed: { type: 'string' }, routeUsed: { type: 'string' } }, required: ['blockId', 'text'] },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 200 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['execution', 'proofreading']
      },
      {
        name: 'job.mark_block_failed',
        toolVersion: '1.0.0',
        description: 'Mark pending block as failed.',
        parametersJsonSchema: { type: 'object', additionalProperties: false, properties: { blockId: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' } }, required: ['blockId', 'code', 'message'] },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 200 },
        idempotency: { mode: 'by_call_id' },
        sideEffects: { category: 'storage_write' },
        stages: ['execution', 'proofreading']
      },
      {
        name: 'agent.audit_progress',
        toolVersion: '1.0.0',
        description: 'Run deterministic progress audit and return guard status.',
        parametersJsonSchema: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string' }, mandatory: { type: 'boolean' } }, required: ['reason'] },
        capabilitiesRequired: { content: [], offscreen: [], permissions: [] },
        qos: { queueDepthLimit: 120 },
        idempotency: { mode: 'none' },
        sideEffects: { category: 'none' },
        stages: ['planning', 'execution', 'proofreading']
      }
    ];
  }

  class ToolManifest {
    constructor({ toolsetSemver = '1.0.0', tools = null, compatStubs = null } = {}) {
      this.version = 'toolset/v1';
      this.toolsetId = 'neuro-translate';
      this.toolsetSemver = String(toolsetSemver || '1.0.0');
      this.tools = Array.isArray(tools) && tools.length ? cloneJson(tools, []) : defaultToolDefinitions();
      this.compatStubs = compatStubs && typeof compatStubs === 'object' ? { ...compatStubs } : {};
      this.toolIndex = {};
      this.tools.forEach((tool) => {
        if (tool && typeof tool.name === 'string' && tool.name) {
          this.toolIndex[tool.name] = tool;
        }
      });
      this.toolsetHash = this._buildToolsetHash();
    }

    _buildToolsetHash() {
      const payload = {
        version: this.version,
        toolsetSemver: this.toolsetSemver,
        tools: this.tools
          .map((tool) => ({
            name: tool.name,
            toolVersion: tool.toolVersion || '1.0.0',
            schemaHash: sha256Hex(stableStringify(tool.parametersJsonSchema || {}))
          }))
          .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
      };
      return sha256Hex(stableStringify(payload));
    }

    getToolDefinition(name) {
      const key = typeof name === 'string' ? name.trim() : '';
      return key && this.toolIndex[key] ? this.toolIndex[key] : null;
    }

    getResponsesTools({ scope = 'execution' } = {}) {
      const stage = scope === 'planning'
        ? 'planning'
        : (scope === 'proofreading' ? 'proofreading' : 'execution');
      return this.tools
        .filter((tool) => {
          const stages = Array.isArray(tool.stages) ? tool.stages : ['planning', 'execution'];
          return stages.includes(stage);
        })
        .map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description || '',
          parameters: cloneJson(tool.parametersJsonSchema || { type: 'object', properties: {} }, { type: 'object', properties: {} })
        }));
    }

    getPublicSummary() {
      return {
        version: this.version,
        toolsetId: this.toolsetId,
        toolsetSemver: this.toolsetSemver,
        toolsetHash: this.toolsetHash,
        tools: this.tools.map((tool) => ({
          name: tool.name,
          toolVersion: tool.toolVersion || '1.0.0',
          descriptionShort: String(tool.description || '').slice(0, 120)
        }))
      };
    }

    getCompatStub(name) {
      const key = typeof name === 'string' ? name.trim() : '';
      if (!key) {
        return null;
      }
      return this.compatStubs[key] || null;
    }
  }

  ToolManifest.sha256Hex = sha256Hex;
  ToolManifest.stableStringify = stableStringify;
  ToolManifest.defaultToolDefinitions = defaultToolDefinitions;

  NT.ToolManifest = ToolManifest;
})(globalThis);
