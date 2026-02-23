/**
 * Tool policy layering resolver.
 *
 * Priority:
 * 1) user overrides (explicit on/off)
 * 2) agent proposal (for auto/unspecified user modes)
 * 3) profile defaults
 * 4) fallback auto
 *
 * Then capability constraints are applied (technical downgrades only).
 */
(function initToolPolicyResolver(global) {
  const NT = global.NT || (global.NT = {});

  const TOOL_MODE_VALUES = ['on', 'off', 'auto'];

  function cloneJson(value, fallback = null) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return fallback;
    }
  }

  function normalizeMode(mode, fallback = null) {
    const raw = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
    return TOOL_MODE_VALUES.includes(raw) ? raw : fallback;
  }

  class ToolPolicyResolver {
    constructor({ toolManifest } = {}) {
      this.toolManifest = toolManifest || null;
    }

    resolve({
      profileDefaults,
      userOverrides,
      agentProposal,
      capabilities,
      stage = null
    } = {}) {
      const defaults = profileDefaults && typeof profileDefaults === 'object' ? profileDefaults : {};
      const user = userOverrides && typeof userOverrides === 'object' ? userOverrides : {};
      const proposal = agentProposal && typeof agentProposal === 'object' ? agentProposal : {};
      const defs = this.toolManifest && typeof this.toolManifest.getPublicSummary === 'function'
        ? this.toolManifest.getPublicSummary().tools
        : [];
      const toolNames = defs.length
        ? defs.map((row) => row.name).filter(Boolean)
        : this._collectToolNames([defaults, user, proposal]);
      const effective = {};
      const reasons = {};
      const runtimeHints = {};

      toolNames.forEach((toolName) => {
        const userMode = normalizeMode(user[toolName], null);
        const proposalMode = normalizeMode(proposal[toolName], null);
        const defaultMode = normalizeMode(defaults[toolName], 'auto');
        let resolvedMode = 'auto';
        let reason = 'fallback_auto';

        if (userMode === 'on' || userMode === 'off') {
          resolvedMode = userMode;
          reason = 'user_override';
        } else if (proposalMode) {
          resolvedMode = proposalMode;
          reason = 'agent_proposal';
        } else if (defaultMode) {
          resolvedMode = defaultMode;
          reason = 'profile_default';
        }

        const constrained = this._applyCapabilities({
          toolName,
          mode: resolvedMode,
          reason,
          capabilities,
          stage
        });
        effective[toolName] = constrained.mode;
        reasons[toolName] = constrained.reason;
        if (constrained.hint) {
          runtimeHints[toolName] = constrained.hint;
        }
      });

      return {
        effective,
        reasons,
        runtimeHints,
        capabilitiesSummary: this.summarizeCapabilities(capabilities)
      };
    }

    summarizeCapabilities(capabilities) {
      const source = capabilities && typeof capabilities === 'object' ? capabilities : {};
      const content = source.content && typeof source.content === 'object' ? source.content : {};
      const offscreen = source.offscreen && typeof source.offscreen === 'object' ? source.offscreen : {};
      const ui = source.ui && typeof source.ui === 'object' ? source.ui : {};
      return {
        content: {
          supportsApplyDelta: content.supportsApplyDelta !== false,
          supportsRestoreOriginal: content.supportsRestoreOriginal !== false,
          selectorStability: content.selectorStability || 'unknown'
        },
        offscreen: {
          supportsStream: offscreen.supportsStream !== false,
          supportsAbort: offscreen.supportsAbort !== false,
          sseParserVersion: offscreen.sseParserVersion || null
        },
        ui: cloneJson(ui, {})
      };
    }

    _collectToolNames(sources) {
      const out = [];
      (Array.isArray(sources) ? sources : []).forEach((source) => {
        const obj = source && typeof source === 'object' ? source : {};
        Object.keys(obj).forEach((key) => {
          const name = typeof key === 'string' ? key.trim() : '';
          if (!name || out.includes(name)) {
            return;
          }
          out.push(name);
        });
      });
      return out;
    }

    _applyCapabilities({ toolName, mode, reason, capabilities, stage }) {
      const source = capabilities && typeof capabilities === 'object' ? capabilities : {};
      const content = source.content && typeof source.content === 'object' ? source.content : {};
      const offscreen = source.offscreen && typeof source.offscreen === 'object' ? source.offscreen : {};
      const safeStage = typeof stage === 'string' ? stage : null;
      const toolDef = this.toolManifest && typeof this.toolManifest.getToolDefinition === 'function'
        ? this.toolManifest.getToolDefinition(toolName)
        : null;
      const stages = toolDef && Array.isArray(toolDef.stages) ? toolDef.stages.filter(Boolean) : [];

      if (safeStage && stages.length && !stages.includes(safeStage)) {
        return {
          mode: 'off',
          reason: `${reason}:stage_not_allowed`,
          hint: { code: 'STAGE_NOT_ALLOWED', stage: safeStage }
        };
      }

      if (toolName === 'translator.translate_block_stream' && offscreen.supportsStream === false) {
        return {
          mode,
          reason: `${reason}:no_stream_support`,
          hint: { code: 'NO_STREAM_SUPPORT', streamMode: 'fallback_non_stream' }
        };
      }

      const required = toolDef && toolDef.capabilitiesRequired && typeof toolDef.capabilitiesRequired === 'object'
        ? toolDef.capabilitiesRequired
        : {};
      const missing = this._collectMissingCapabilities({
        required,
        content,
        offscreen,
        toolName
      });
      if (missing.length) {
        return {
          mode: 'off',
          reason: `${reason}:missing_capability:${missing[0]}`,
          hint: { code: 'MISSING_CAPABILITY', capability: missing[0], all: missing.slice(0, 6) }
        };
      }

      return { mode, reason };
    }

    _collectMissingCapabilities({ required, content, offscreen, toolName } = {}) {
      const srcRequired = required && typeof required === 'object' ? required : {};
      const contentList = Array.isArray(srcRequired.content) ? srcRequired.content : [];
      const offscreenList = Array.isArray(srcRequired.offscreen) ? srcRequired.offscreen : [];
      const missing = [];

      contentList.forEach((capability) => {
        const key = typeof capability === 'string' ? capability.trim() : '';
        if (!key) {
          return;
        }
        if (!this._hasContentCapability(content, key)) {
          missing.push(`content.${key}`);
        }
      });

      offscreenList.forEach((capability) => {
        const key = typeof capability === 'string' ? capability.trim() : '';
        if (!key) {
          return;
        }
        if (toolName === 'translator.translate_block_stream' && key === 'stream') {
          return;
        }
        if (!this._hasOffscreenCapability(offscreen, key)) {
          missing.push(`offscreen.${key}`);
        }
      });

      return missing;
    }

    _hasContentCapability(content, key) {
      const caps = content && typeof content === 'object' ? content : {};
      if (key === 'apply_delta') {
        return caps.supportsApplyDelta !== false;
      }
      if (key === 'restore_original' || key === 'restore_originals') {
        return caps.supportsRestoreOriginal !== false;
      }
      if (Object.prototype.hasOwnProperty.call(caps, key)) {
        return Boolean(caps[key]);
      }
      return false;
    }

    _hasOffscreenCapability(offscreen, key) {
      const caps = offscreen && typeof offscreen === 'object' ? offscreen : {};
      if (key === 'stream') {
        return caps.supportsStream !== false;
      }
      if (key === 'abort') {
        return caps.supportsAbort !== false;
      }
      if (Object.prototype.hasOwnProperty.call(caps, key)) {
        return Boolean(caps[key]);
      }
      return false;
    }
  }

  NT.ToolPolicyResolver = ToolPolicyResolver;
})(globalThis);
