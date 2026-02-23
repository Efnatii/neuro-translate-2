/**
 * Security audit for manifest/runtime/tooling/credentials hardening checks.
 */
(function initSecurityAudit(global) {
  const NT = global.NT || (global.NT = {});

  function toArray(value) {
    return Array.isArray(value) ? value.slice() : [];
  }

  class SecurityAudit {
    constructor({ chromeApi, credentialsStore, toolManifest } = {}) {
      this.chromeApi = chromeApi || global.chrome || null;
      this.credentialsStore = credentialsStore || null;
      this.toolManifest = toolManifest || null;
    }

    _isBroadMatch(match) {
      const text = String(match || '').trim();
      return text === '<all_urls>' || text === '*://*/*' || text === 'http://*/*' || text === 'https://*/*';
    }

    _hasSecretLeakingTool(tools) {
      const list = Array.isArray(tools) ? tools : [];
      return list.some((tool) => {
        const name = String(tool && tool.name ? tool.name : '').toLowerCase();
        const desc = String(tool && tool.descriptionShort ? tool.descriptionShort : '').toLowerCase();
        return (
          name.includes('credential')
          || name.includes('secret')
          || name.includes('api_key')
          || name.includes('token')
          || name.includes('header')
          || desc.includes('raw header')
          || desc.includes('authorization')
        );
      });
    }

    async run() {
      const manifest = this.chromeApi && this.chromeApi.runtime && typeof this.chromeApi.runtime.getManifest === 'function'
        ? this.chromeApi.runtime.getManifest()
        : {};
      const permissions = toArray(manifest.permissions);
      const hostPermissions = toArray(manifest.host_permissions);
      const optionalHostPermissions = toArray(manifest.optional_host_permissions);
      const csp = manifest && manifest.content_security_policy && manifest.content_security_policy.extension_pages
        ? String(manifest.content_security_policy.extension_pages)
        : '';

      const webResources = toArray(manifest.web_accessible_resources)
        .map((row) => ({
          resources: toArray(row && row.resources),
          matches: toArray(row && row.matches)
        }));

      const broadHostPermissions = hostPermissions.filter((item) => this._isBroadMatch(item));
      const broadOptionalHostPermissions = optionalHostPermissions.filter((item) => this._isBroadMatch(item));
      const broadWebMatches = webResources
        .flatMap((row) => row.matches)
        .filter((item) => this._isBroadMatch(item));

      const credentials = this.credentialsStore && typeof this.credentialsStore.getPublicSnapshot === 'function'
        ? await this.credentialsStore.getPublicSnapshot().catch(() => null)
        : null;

      const toolset = this.toolManifest && typeof this.toolManifest.getPublicSummary === 'function'
        ? this.toolManifest.getPublicSummary()
        : { tools: [] };
      const toolsLeakSecrets = this._hasSecretLeakingTool(toolset && toolset.tools ? toolset.tools : []);

      const dangerousFlags = {
        broadHostPermissions: broadHostPermissions.length > 0,
        broadOptionalHostPermissions: broadOptionalHostPermissions.length > 0,
        downloadsPermissionEnabled: permissions.includes('downloads'),
        broadWebAccessibleMatches: broadWebMatches.length > 0,
        cspUnsafeEval: /unsafe-eval/i.test(csp),
        cspUnsafeInline: /unsafe-inline/i.test(csp),
        byokPersisted: Boolean(credentials && credentials.byokPersisted),
        toolsLeakSecrets
      };

      const recommendations = [];
      if (credentials && credentials.mode !== 'PROXY') {
        recommendations.push('Рекомендуется Proxy mode для хранения ключа на сервере.');
      }
      if (dangerousFlags.byokPersisted) {
        recommendations.push('Ключ BYOK сохранён постоянно: это повышает риск локального извлечения.');
      }
      if (dangerousFlags.broadHostPermissions) {
        recommendations.push('Слишком широкие host_permissions: сузьте доступные домены.');
      }
      if (dangerousFlags.broadWebAccessibleMatches) {
        recommendations.push('web_accessible_resources имеет слишком широкие matches.');
      }
      if (dangerousFlags.downloadsPermissionEnabled) {
        recommendations.push('Разрешение downloads включено: проверьте, что оно действительно нужно.');
      }
      if (!dangerousFlags.cspUnsafeEval && !dangerousFlags.cspUnsafeInline) {
        recommendations.push('CSP OK: unsafe-eval/unsafe-inline не обнаружены.');
      }
      if (!dangerousFlags.toolsLeakSecrets) {
        recommendations.push('Toolset не содержит явных инструментов для утечки секретов.');
      }

      return {
        ts: Date.now(),
        manifest: {
          name: manifest && manifest.name ? manifest.name : null,
          version: manifest && manifest.version ? manifest.version : null,
          manifestVersion: manifest && manifest.manifest_version ? manifest.manifest_version : null,
          permissions,
          host_permissions: hostPermissions,
          optional_host_permissions: optionalHostPermissions,
          content_security_policy: csp,
          web_accessible_resources: webResources
        },
        dangerousFlags,
        credentials: credentials || null,
        logging: {
          redactionEnabled: Boolean(NT.Redaction && typeof NT.Redaction.redactDeep === 'function'),
          safeLoggerAvailable: Boolean(NT.SafeLogger)
        },
        toolset: {
          toolsetHash: toolset && toolset.toolsetHash ? toolset.toolsetHash : null,
          toolsCount: Array.isArray(toolset && toolset.tools) ? toolset.tools.length : 0,
          toolsLeakSecrets
        },
        recommendations
      };
    }
  }

  NT.SecurityAudit = SecurityAudit;
})(globalThis);
