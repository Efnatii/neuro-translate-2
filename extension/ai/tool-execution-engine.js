/**
 * Tool execution QoS/idempotency engine for agent tool calls.
 *
 * Technical safeguards only:
 * - idempotency replay by call_id / args hash
 * - coalescing/debounce for high-frequency tools (e.g. page.apply_delta)
 * - bounded queue + backpressure reporting
 * - standardized ToolTraceRecord v1
 */
(function initToolExecutionEngine(global) {
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

  function hashText(value) {
    if (NT.ToolManifest && typeof NT.ToolManifest.sha256Hex === 'function') {
      return NT.ToolManifest.sha256Hex(String(value || ''));
    }
    const src = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < src.length; i += 1) {
      hash ^= src.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return `h${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  class ToolExecutionEngine {
    constructor({
      toolManifest,
      persistJobState,
      schemaValidator,
      defaultQueueDepthLimit = 200,
      defaultLeaseMs = 15000,
      maxTrace = 420
    } = {}) {
      this.toolManifest = toolManifest || null;
      this.persistJobState = typeof persistJobState === 'function' ? persistJobState : null;
      this.defaultQueueDepthLimit = Number.isFinite(Number(defaultQueueDepthLimit))
        ? Math.max(10, Number(defaultQueueDepthLimit))
        : 200;
      this.defaultLeaseMs = Number.isFinite(Number(defaultLeaseMs))
        ? Math.max(3000, Number(defaultLeaseMs))
        : 15000;
      this.maxTrace = Number.isFinite(Number(maxTrace)) ? Math.max(80, Number(maxTrace)) : 420;
      this.schemaValidator = schemaValidator || (NT.JsonSchemaValidator ? new NT.JsonSchemaValidator() : null);
      this.coalesceTimers = new Map();
    }

    async executeToolCall({
      job,
      stage = null,
      responseId = null,
      callId = null,
      toolName,
      toolArgs,
      executeNow
    } = {}) {
      const safeJob = job && typeof job === 'object' ? job : {};
      const state = this._ensureState(safeJob);
      const toolDef = this.toolManifest && typeof this.toolManifest.getToolDefinition === 'function'
        ? this.toolManifest.getToolDefinition(toolName)
        : null;
      const toolVersion = toolDef && toolDef.toolVersion ? toolDef.toolVersion : '1.0.0';
      const qos = toolDef && toolDef.qos && typeof toolDef.qos === 'object' ? toolDef.qos : {};
      const queueLimit = Number.isFinite(Number(qos.queueDepthLimit))
        ? Math.max(10, Number(qos.queueDepthLimit))
        : this.defaultQueueDepthLimit;
      const args = toolArgs && typeof toolArgs === 'object' ? toolArgs : {};
      const argsHash = hashText(`${toolName || 'unknown'}|${stableStringify(args)}`);
      const idempotencyMode = toolDef && toolDef.idempotency && typeof toolDef.idempotency.mode === 'string'
        ? toolDef.idempotency.mode
        : 'none';
      const coalesceKeyPath = typeof qos.coalesceKey === 'string' ? qos.coalesceKey.trim() : '';
      const debounceMs = Number.isFinite(Number(qos.debounceMs)) ? Math.max(0, Number(qos.debounceMs)) : 0;
      const isFinal = args && args.isFinal === true;
      const coalesceKey = (coalesceKeyPath && debounceMs > 0)
        ? this._extractCoalesceKey(args, coalesceKeyPath)
        : '';
      const coalesceEntryKey = coalesceKey ? `${toolName}:${coalesceKey}` : '';
      const canCoalesceNow = Boolean(coalesceEntryKey && !isFinal);

      const schema = toolDef && toolDef.parametersJsonSchema && typeof toolDef.parametersJsonSchema === 'object'
        ? toolDef.parametersJsonSchema
        : null;
      if (schema && this.schemaValidator && typeof this.schemaValidator.validate === 'function') {
        const validation = this.schemaValidator.validate(schema, args);
        if (!validation || validation.ok !== true) {
          const details = validation && Array.isArray(validation.errors)
            ? validation.errors.slice(0, 8).map((item) => ({
              path: item && item.path ? item.path : '$',
              code: item && item.code ? item.code : 'INVALID'
            }))
            : [];
          const out = {
            ok: false,
            error: {
              code: 'TOOL_ARGS_INVALID',
              message: `Tool arguments failed schema validation: ${String(toolName || 'unknown')}`,
              details
            }
          };
          const outputString = JSON.stringify(out);
          if (callId) {
            state.toolOutputsByCallId[callId] = {
              outputString,
              ts: Date.now(),
              argsHash,
              toolName,
              toolVersion,
              executionState: 'completed',
              leaseUntilTs: null
            };
          }
          this._appendTrace(state, {
            tsStart: Date.now(),
            tsEnd: Date.now(),
            responseId,
            callId,
            stage,
            toolName,
            toolVersion,
            argsHash,
            status: 'failed',
            errorCode: 'TOOL_ARGS_INVALID',
            resultPreview: this._preview(out.error.message),
            qos: { queueDepth: this._queueDepth(state, toolName), debounceMs }
          });
          await this._persist(safeJob, `tool:${toolName}:args_invalid`);
          return {
            outputString,
            status: 'failed',
            argsHash
          };
        }
      }

      // Replay by call_id (after SW restart or duplicate tool delivery).
      if (idempotencyMode === 'by_call_id' && callId && state.toolOutputsByCallId[callId]) {
        const cached = state.toolOutputsByCallId[callId];
        const executionState = typeof cached.executionState === 'string' ? cached.executionState : 'completed';
        if (executionState === 'accepted_pending' && this._isLeaseExpired(cached.leaseUntilTs)) {
          delete state.toolOutputsByCallId[callId];
        } else {
          const outputString = typeof cached.outputString === 'string'
            ? cached.outputString
            : JSON.stringify({ ok: true, replayed: true });
          this._appendTrace(state, {
            tsStart: Date.now(),
            tsEnd: Date.now(),
            responseId,
            callId,
            stage,
            toolName,
            toolVersion,
            argsHash,
            status: 'skipped',
            resultPreview: 'replay_by_call_id',
            qos: { queueDepth: this._queueDepth(state, toolName) }
          });
          return {
            outputString,
            status: 'skipped',
            replayed: true,
            argsHash
          };
        }
      }

      // Fast idempotency by args hash for read-heavy tools.
      if (idempotencyMode === 'by_args_hash') {
        const key = `${toolName || 'unknown'}:${argsHash}`;
        const cache = state.toolOutputsByArgsHash[key];
        const cacheTtl = Number.isFinite(Number(qos.cacheTtlMs)) ? Math.max(10, Number(qos.cacheTtlMs)) : 0;
        if (cache && typeof cache.outputString === 'string') {
          const fresh = cacheTtl > 0 ? (Date.now() - Number(cache.ts || 0)) <= cacheTtl : true;
          if (fresh) {
            this._appendTrace(state, {
              tsStart: Date.now(),
              tsEnd: Date.now(),
              responseId,
              callId,
              stage,
              toolName,
              toolVersion,
              argsHash,
              status: 'skipped',
              resultPreview: 'replay_by_args_hash',
              qos: { queueDepth: this._queueDepth(state, toolName) }
            });
            if (callId) {
              state.toolOutputsByCallId[callId] = {
                outputString: cache.outputString,
                ts: Date.now(),
                argsHash,
                toolName,
                toolVersion,
                executionState: 'completed',
                leaseUntilTs: null
              };
            }
            return {
              outputString: cache.outputString,
              status: 'skipped',
              replayed: true,
              argsHash
            };
          }
        }
      }

      if (toolName && coalesceKeyPath && debounceMs > 0) {
        await this._flushDueCoalescedForTool({
          job: safeJob,
          state,
          toolName,
          toolVersion,
          responseId,
          stage,
          executeNow
        });
      }

      this._incQueueDepth(state, toolName);
      const queueDepth = this._queueDepth(state, toolName);
      if (queueDepth > queueLimit) {
        if (canCoalesceNow) {
          const coalesced = await this._acceptCoalescedCall({
            job: safeJob,
            state,
            toolName,
            toolVersion,
            args,
            argsHash,
            responseId,
            callId,
            stage,
            executeNow,
            queueDepth,
            queueLimit,
            debounceMs,
            coalesceKey,
            entryKey: coalesceEntryKey,
            backpressure: true
          });
          this._decQueueDepth(state, toolName);
          await this._persist(safeJob, `tool:${toolName}:coalesced_backpressure`);
          return {
            outputString: coalesced.outputString,
            status: coalesced.status,
            argsHash
          };
        }
        const out = {
          ok: false,
          error: {
            code: 'TOOL_QUEUE_BACKPRESSURE',
            message: `queue depth limit reached for ${toolName || 'tool'}`
          },
          suggestedActions: ['agent.compress_context', 'agent.audit_progress']
        };
        const outputString = JSON.stringify(out);
        this._appendBackpressureWarning(state.agentState, {
          toolName,
          queueDepth,
          queueLimit
        });
        this._appendTrace(state, {
          tsStart: Date.now(),
          tsEnd: Date.now(),
          responseId,
          callId,
          stage,
          toolName,
          toolVersion,
          argsHash,
          status: 'failed',
          errorCode: 'TOOL_QUEUE_BACKPRESSURE',
          resultPreview: out.error.message,
          qos: { queueDepth, debounceMs: Number(qos.debounceMs || 0) }
        });
        if (callId) {
          state.toolOutputsByCallId[callId] = {
            outputString,
            ts: Date.now(),
            argsHash,
            toolName,
            toolVersion,
            executionState: 'completed',
            leaseUntilTs: null
          };
        }
        this._decQueueDepth(state, toolName);
        await this._persist(safeJob, `tool:${toolName}:backpressure`);
        return {
          outputString,
          status: 'failed',
          argsHash
        };
      }

      if (canCoalesceNow) {
      const coalesced = await this._acceptCoalescedCall({
          job: safeJob,
          state,
          toolName,
          toolVersion,
          args,
          argsHash,
          responseId,
          callId,
          stage,
          executeNow,
          queueDepth,
          queueLimit,
          debounceMs,
          coalesceKey,
          entryKey: coalesceEntryKey,
          backpressure: false
        });
        this._decQueueDepth(state, toolName);
        await this._persist(safeJob, `tool:${toolName}:coalesced`);
        return {
          outputString: coalesced.outputString,
          status: coalesced.status,
          argsHash
        };
      }

      // Final call should flush queued coalesced values for the same key before execution.
      if (coalesceEntryKey && isFinal) {
        await this._flushCoalesced({
          job: safeJob,
          state,
          entryKey: coalesceEntryKey,
          toolName,
          toolVersion,
          argsHash,
          responseId,
          stage,
          executeNow
        }).catch(() => {});
      }

      const tsStart = Date.now();
      try {
        const maxPayloadBytes = Number.isFinite(Number(qos.maxPayloadBytes))
          ? Math.max(1024, Number(qos.maxPayloadBytes))
          : null;
        if (maxPayloadBytes) {
          const payloadSize = stableStringify(args).length;
          if (payloadSize > maxPayloadBytes) {
            const err = new Error(`payload bytes exceeded: ${payloadSize}/${maxPayloadBytes}`);
            err.code = 'TOOL_PAYLOAD_TOO_LARGE';
            throw err;
          }
        }

        const outputObj = await executeNow(args);
        const outputString = typeof outputObj === 'string'
          ? outputObj
          : JSON.stringify(outputObj && typeof outputObj === 'object' ? outputObj : { ok: true, value: outputObj });
        const leaseUntilTs = this._buildLeaseUntil(toolDef);
        this._storeOutput({
          state,
          idempotencyMode,
          callId,
          toolName,
          toolVersion,
          argsHash,
          outputString,
          executionState: 'completed',
          leaseUntilTs
        });
        this._appendTrace(state, {
          tsStart,
          tsEnd: Date.now(),
          responseId,
          callId,
          stage,
          toolName,
          toolVersion,
          argsHash,
          status: 'ok',
          resultPreview: this._preview(outputString),
          qos: {
            queueDepth,
            debounceMs
          },
          leaseUntilTs
        });
        this._decQueueDepth(state, toolName);
        await this._persist(safeJob, `tool:${toolName}:ok`);
        return {
          outputString,
          status: 'ok',
          argsHash
        };
      } catch (error) {
        const errCode = error && error.code ? error.code : 'TOOL_EXEC_FAILED';
        const out = {
          ok: false,
          error: {
            code: errCode,
            message: error && error.message ? error.message : 'tool execution failed'
          }
        };
        const outputString = JSON.stringify(out);
        this._storeOutput({
          state,
          idempotencyMode: 'by_call_id',
          callId,
          toolName,
          toolVersion,
          argsHash,
          outputString,
          executionState: 'completed',
          leaseUntilTs: null
        });
        this._appendTrace(state, {
          tsStart,
          tsEnd: Date.now(),
          responseId,
          callId,
          stage,
          toolName,
          toolVersion,
          argsHash,
          status: 'failed',
          errorCode: errCode,
          resultPreview: this._preview(out.error.message),
          qos: { queueDepth, debounceMs }
        });
        this._decQueueDepth(state, toolName);
        await this._persist(safeJob, `tool:${toolName}:failed`);
        return {
          outputString,
          status: 'failed',
          argsHash
        };
      }
    }

    async _flushDueCoalescedForTool({
      job,
      state,
      toolName,
      toolVersion,
      responseId,
      stage,
      executeNow
    } = {}) {
      if (!state || !state.coalescedPending || !toolName) {
        return;
      }
      const prefix = `${toolName}:`;
      const keys = Object.keys(state.coalescedPending).filter((entryKey) => typeof entryKey === 'string' && entryKey.indexOf(prefix) === 0);
      if (!keys.length) {
        return;
      }
      const now = Date.now();
      for (let i = 0; i < keys.length; i += 1) {
        const entryKey = keys[i];
        const entry = state.coalescedPending[entryKey] && typeof state.coalescedPending[entryKey] === 'object'
          ? state.coalescedPending[entryKey]
          : null;
        if (!entry) {
          continue;
        }
        const waitMs = Number.isFinite(Number(entry.debounceMs)) ? Math.max(0, Number(entry.debounceMs)) : 0;
        const ageMs = now - Number(entry.lastUpdateAt || entry.startedAt || now);
        if (waitMs <= 0 || ageMs >= waitMs) {
          await this._flushCoalesced({
            job,
            state,
            entryKey,
            toolName,
            toolVersion,
            argsHash: hashText(`${toolName || 'unknown'}|${stableStringify(entry.latestArgs || {})}`),
            responseId,
            stage,
            executeNow
          }).catch(() => {});
          continue;
        }
        this._scheduleCoalesceTimer({
          job,
          state,
          entryKey,
          toolName,
          toolVersion,
          responseId,
          stage,
          executeNow,
          delayMs: Math.max(8, waitMs - ageMs)
        });
      }
    }

    async _acceptCoalescedCall({
      job,
      state,
      toolName,
      toolVersion,
      args,
      argsHash,
      responseId,
      callId,
      stage,
      executeNow,
      queueDepth,
      queueLimit,
      debounceMs,
      coalesceKey,
      entryKey,
      backpressure = false
    } = {}) {
      const existing = state.coalescedPending[entryKey] && typeof state.coalescedPending[entryKey] === 'object'
        ? state.coalescedPending[entryKey]
        : null;
      const now = Date.now();
      const next = existing
        ? {
          ...existing,
          latestArgs: cloneJson(existing.latestArgs, {}),
          callIds: Array.isArray(existing.callIds) ? existing.callIds.slice(0, 400) : []
        }
        : {
          startedAt: now,
          lastUpdateAt: now,
          coalescedCount: 0,
          latestArgs: {},
          latestCallId: null,
          debounceMs,
          callIds: []
        };
      next.coalescedCount = Number(next.coalescedCount || 0) + (existing ? 1 : 0);
      next.latestArgs = cloneJson(args, {});
      next.latestCallId = callId || next.latestCallId || null;
      next.lastUpdateAt = now;
      next.debounceMs = debounceMs;
      if (callId && !next.callIds.includes(callId)) {
        next.callIds.push(callId);
      }
      state.coalescedPending[entryKey] = next;
      this._clearCoalesceTimer(job, entryKey);
      this._scheduleCoalesceTimer({
        job,
        state,
        entryKey,
        toolName,
        toolVersion,
        responseId,
        stage,
        executeNow,
        delayMs: debounceMs
      });

      const out = {
        ok: true,
        accepted: true,
        coalesced: true,
        coalesceKey,
        debounceMs,
        backpressure
      };
      const outputString = JSON.stringify(out);
      const pendingLease = Date.now() + Math.max(this.defaultLeaseMs, debounceMs + 1500);
      if (callId) {
        state.toolOutputsByCallId[callId] = {
          outputString,
          ts: now,
          argsHash,
          toolName,
          toolVersion,
          executionState: 'accepted_pending',
          leaseUntilTs: pendingLease
        };
      }
      if (backpressure) {
        this._appendBackpressureWarning(state.agentState, {
          toolName,
          queueDepth,
          queueLimit
        });
      }
      this._appendTrace(state, {
        tsStart: now,
        tsEnd: now,
        responseId,
        callId,
        stage,
        toolName,
        toolVersion,
        argsHash,
        status: 'coalesced',
        resultPreview: backpressure ? `queued_backpressure:${coalesceKey}` : `queued:${coalesceKey}`,
        qos: {
          coalescedCount: next.coalescedCount,
          queueDepth,
          debounceMs
        },
        leaseUntilTs: pendingLease
      });
      return {
        outputString,
        status: 'coalesced'
      };
    }

    _coalesceTimerToken(job, entryKey) {
      const jobId = job && job.id ? String(job.id) : 'job';
      const key = typeof entryKey === 'string' ? entryKey : 'unknown';
      return `${jobId}|${key}`;
    }

    _scheduleCoalesceTimer({
      job,
      state,
      entryKey,
      toolName,
      toolVersion,
      responseId,
      stage,
      executeNow,
      delayMs = 0
    } = {}) {
      if (!state || !entryKey || typeof executeNow !== 'function') {
        return;
      }
      const token = this._coalesceTimerToken(job, entryKey);
      if (this.coalesceTimers.has(token)) {
        return;
      }
      const timeout = global.setTimeout(() => {
        this.coalesceTimers.delete(token);
        this._flushCoalesced({
          job,
          state,
          entryKey,
          toolName,
          toolVersion,
          argsHash: hashText(`${toolName || 'unknown'}|${stableStringify((state.coalescedPending[entryKey] || {}).latestArgs || {})}`),
          responseId,
          stage,
          executeNow
        }).catch(() => {});
      }, Math.max(8, Number(delayMs) || 8));
      this.coalesceTimers.set(token, timeout);
    }

    _clearCoalesceTimer(job, entryKey) {
      const token = this._coalesceTimerToken(job, entryKey);
      if (!this.coalesceTimers.has(token)) {
        return;
      }
      try {
        global.clearTimeout(this.coalesceTimers.get(token));
      } catch (_) {
        // best-effort
      }
      this.coalesceTimers.delete(token);
    }

    _appendBackpressureWarning(agentState, { toolName, queueDepth, queueLimit } = {}) {
      if (!agentState || typeof agentState !== 'object') {
        return;
      }
      const reports = Array.isArray(agentState.reports) ? agentState.reports : [];
      const ts = Date.now();
      reports.push({
        ts,
        type: 'warning',
        title: 'TOOL_QUEUE_BACKPRESSURE',
        body: `${toolName || 'tool'} queue is overloaded (${queueDepth}/${queueLimit})`,
        meta: {
          code: 'TOOL_QUEUE_BACKPRESSURE',
          toolName: toolName || 'unknown',
          queueDepth: Number(queueDepth || 0),
          queueLimit: Number(queueLimit || 0),
          suggestedActions: ['agent.compress_context', 'agent.audit_progress']
        }
      });
      agentState.reports = reports.slice(-140);
      agentState.updatedAt = ts;
    }

    _isLeaseExpired(leaseUntilTs) {
      if (!Number.isFinite(Number(leaseUntilTs))) {
        return false;
      }
      return Number(leaseUntilTs) <= Date.now();
    }

    async _flushCoalesced({
      job,
      state,
      entryKey,
      toolName,
      toolVersion,
      argsHash,
      responseId,
      stage,
      executeNow
    } = {}) {
      if (!state || !entryKey) {
        return;
      }
      const entry = state.coalescedPending[entryKey] && typeof state.coalescedPending[entryKey] === 'object'
        ? state.coalescedPending[entryKey]
        : null;
      if (!entry) {
        this._clearCoalesceTimer(job, entryKey);
        return;
      }
      this._clearCoalesceTimer(job, entryKey);
      delete state.coalescedPending[entryKey];
      const tsStart = Date.now();
      let status = 'ok';
      let resultPreview = '';
      let errorCode = null;
      const flushArgs = entry.latestArgs && typeof entry.latestArgs === 'object'
        ? entry.latestArgs
        : {};
      const computedArgsHash = hashText(`${toolName || 'unknown'}|${stableStringify(flushArgs)}`);
      const callIds = Array.isArray(entry.callIds) && entry.callIds.length
        ? entry.callIds.filter(Boolean)
        : (entry.latestCallId ? [entry.latestCallId] : []);
      let outputString = '';
      try {
        const out = await executeNow(flushArgs);
        outputString = typeof out === 'string' ? out : JSON.stringify(out && typeof out === 'object' ? out : { ok: true, value: out });
        resultPreview = this._preview(outputString);
      } catch (error) {
        status = 'failed';
        errorCode = error && error.code ? error.code : 'TOOL_EXEC_FAILED';
        resultPreview = this._preview(error && error.message ? error.message : 'coalesced execution failed');
        outputString = JSON.stringify({
          ok: false,
          error: {
            code: errorCode,
            message: error && error.message ? error.message : 'coalesced execution failed'
          }
        });
      }
      const leaseUntilTs = this._buildLeaseUntil(this.toolManifest && this.toolManifest.getToolDefinition
        ? this.toolManifest.getToolDefinition(toolName)
        : null);
      for (let i = 0; i < callIds.length; i += 1) {
        const callId = callIds[i];
        if (!callId) {
          continue;
        }
        state.toolOutputsByCallId[callId] = {
          outputString,
          ts: Date.now(),
          argsHash: computedArgsHash,
          toolName,
          toolVersion,
          executionState: 'completed',
          leaseUntilTs
        };
      }
      this._appendTrace(state, {
        tsStart,
        tsEnd: Date.now(),
        responseId,
        callId: entry.latestCallId || (callIds.length ? callIds[callIds.length - 1] : null),
        stage,
        toolName,
        toolVersion,
        argsHash: computedArgsHash,
        status,
        errorCode,
        resultPreview,
        qos: {
          coalescedCount: Number(entry.coalescedCount || 0),
          debounceMs: Number(entry.debounceMs || 0),
          queueDepth: this._queueDepth(state, toolName),
          latencyMs: Math.max(0, Date.now() - Number(entry.startedAt || tsStart))
        },
        leaseUntilTs
      });
      await this._persist(job, `tool:${toolName}:coalesced_flush`);
    }

    _buildLeaseUntil(toolDef) {
      const sideEffects = toolDef && toolDef.sideEffects && toolDef.sideEffects.category
        ? toolDef.sideEffects.category
        : 'none';
      if (sideEffects !== 'dom_write' && sideEffects !== 'storage_write' && sideEffects !== 'network') {
        return null;
      }
      return Date.now() + this.defaultLeaseMs;
    }

    _ensureState(job) {
      const agentState = job && job.agentState && typeof job.agentState === 'object'
        ? job.agentState
        : (job.agentState = {});
      if (!Array.isArray(agentState.toolExecutionTrace)) {
        agentState.toolExecutionTrace = [];
      }
      if (!agentState.toolOutputsByCallId || typeof agentState.toolOutputsByCallId !== 'object') {
        agentState.toolOutputsByCallId = {};
      }
      if (!agentState.toolOutputsByArgsHash || typeof agentState.toolOutputsByArgsHash !== 'object') {
        agentState.toolOutputsByArgsHash = {};
      }
      if (!agentState.pendingToolCalls || typeof agentState.pendingToolCalls !== 'object') {
        agentState.pendingToolCalls = {};
      }
      if (!agentState.toolRuntime || typeof agentState.toolRuntime !== 'object') {
        agentState.toolRuntime = {};
      }
      const runtime = agentState.toolRuntime;
      if (!runtime.queueDepthByTool || typeof runtime.queueDepthByTool !== 'object') {
        runtime.queueDepthByTool = {};
      }
      if (!runtime.coalescedPending || typeof runtime.coalescedPending !== 'object') {
        runtime.coalescedPending = {};
      }
      Object.keys(runtime.coalescedPending).forEach((entryKey) => {
        const raw = runtime.coalescedPending[entryKey];
        if (!raw || typeof raw !== 'object') {
          delete runtime.coalescedPending[entryKey];
          return;
        }
        runtime.coalescedPending[entryKey] = {
          startedAt: Number.isFinite(Number(raw.startedAt)) ? Number(raw.startedAt) : Date.now(),
          lastUpdateAt: Number.isFinite(Number(raw.lastUpdateAt)) ? Number(raw.lastUpdateAt) : Date.now(),
          coalescedCount: Number.isFinite(Number(raw.coalescedCount)) ? Number(raw.coalescedCount) : 0,
          latestArgs: raw.latestArgs && typeof raw.latestArgs === 'object' ? cloneJson(raw.latestArgs, {}) : {},
          latestCallId: typeof raw.latestCallId === 'string' ? raw.latestCallId : null,
          debounceMs: Number.isFinite(Number(raw.debounceMs)) ? Math.max(0, Number(raw.debounceMs)) : 0,
          callIds: (() => {
            const out = Array.isArray(raw.callIds) ? raw.callIds.filter(Boolean).slice(-400) : [];
            if (!out.length && typeof raw.latestCallId === 'string' && raw.latestCallId) {
              out.push(raw.latestCallId);
            }
            return out;
          })()
        };
      });
      if (!Number.isFinite(Number(agentState.toolTraceSeq))) {
        agentState.toolTraceSeq = 0;
      }
      return {
        agentState,
        trace: agentState.toolExecutionTrace,
        toolOutputsByCallId: agentState.toolOutputsByCallId,
        toolOutputsByArgsHash: agentState.toolOutputsByArgsHash,
        pendingToolCalls: agentState.pendingToolCalls,
        queueDepthByTool: runtime.queueDepthByTool,
        coalescedPending: runtime.coalescedPending
      };
    }

    _extractCoalesceKey(args, keyPath) {
      const src = args && typeof args === 'object' ? args : {};
      const key = typeof keyPath === 'string' ? keyPath.trim() : '';
      if (!key) {
        return '';
      }
      if (Object.prototype.hasOwnProperty.call(src, key)) {
        const value = src[key];
        return value === null || value === undefined ? '' : String(value);
      }
      return '';
    }

    _storeOutput({
      state,
      idempotencyMode,
      callId,
      toolName,
      toolVersion,
      argsHash,
      outputString,
      executionState = 'completed',
      leaseUntilTs = null
    }) {
      const now = Date.now();
      if (callId) {
        state.toolOutputsByCallId[callId] = {
          outputString,
          ts: now,
          argsHash,
          toolName,
          toolVersion,
          executionState: typeof executionState === 'string' ? executionState : 'completed',
          leaseUntilTs: Number.isFinite(Number(leaseUntilTs)) ? Number(leaseUntilTs) : null
        };
      }
      if (idempotencyMode === 'by_args_hash') {
        state.toolOutputsByArgsHash[`${toolName || 'unknown'}:${argsHash}`] = {
          outputString,
          ts: now,
          argsHash,
          toolName,
          toolVersion
        };
      }
    }

    _appendTrace(state, {
      tsStart,
      tsEnd,
      responseId,
      callId,
      stage,
      toolName,
      toolVersion,
      argsHash,
      status,
      errorCode = null,
      resultPreview = '',
      qos = null,
      leaseUntilTs = null
    } = {}) {
      const nextSeq = Number(state.agentState.toolTraceSeq || 0) + 1;
      state.agentState.toolTraceSeq = nextSeq;
      const record = {
        seq: nextSeq,
        tsStart: Number(tsStart || Date.now()),
        tsEnd: Number(tsEnd || Date.now()),
        responseId: responseId || null,
        callId: callId || null,
        stage: stage || null,
        toolName: toolName || 'unknown',
        toolVersion: toolVersion || '1.0.0',
        argsHash: argsHash || '',
        status: status || 'ok',
        errorCode: errorCode || null,
        resultPreview: this._preview(resultPreview),
        qos: qos && typeof qos === 'object' ? cloneJson(qos, {}) : {},
        leaseUntilTs: leaseUntilTs || null,
        // backward-compatible fields used by existing debug renderers:
        ts: Number(tsEnd || Date.now()),
        tool: toolName || 'unknown',
        message: this._preview(resultPreview),
        meta: {
          callId: callId || null,
          requestId: responseId || null,
          argsHash: argsHash || '',
          stage: stage || null,
          toolVersion: toolVersion || '1.0.0',
          qos: qos && typeof qos === 'object' ? cloneJson(qos, {}) : {}
        }
      };
      state.trace.push(record);
      if (state.trace.length > this.maxTrace) {
        state.trace.splice(0, state.trace.length - this.maxTrace);
      }
    }

    _preview(value) {
      if (value === null || value === undefined) {
        return '';
      }
      const text = typeof value === 'string' ? value : stableStringify(value);
      return String(text || '').slice(0, 280);
    }

    _queueDepth(state, toolName) {
      const key = toolName || 'unknown';
      return Number(state.queueDepthByTool[key] || 0);
    }

    _incQueueDepth(state, toolName) {
      const key = toolName || 'unknown';
      state.queueDepthByTool[key] = Number(state.queueDepthByTool[key] || 0) + 1;
    }

    _decQueueDepth(state, toolName) {
      const key = toolName || 'unknown';
      state.queueDepthByTool[key] = Math.max(0, Number(state.queueDepthByTool[key] || 0) - 1);
    }

    async _persist(job, reason) {
      if (!this.persistJobState || !job || !job.id) {
        return;
      }
      await this.persistJobState(job, { reason: reason || 'tool_execution_engine' });
    }
  }

  NT.ToolExecutionEngine = ToolExecutionEngine;
})(globalThis);
