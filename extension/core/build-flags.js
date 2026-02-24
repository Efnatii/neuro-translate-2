/**
 * Build-time flags consumed by background runtime.
 *
 * `allowTestCommandsInBuild` is true for local/dev unpacked extension and
 * rewritten to false during zip packaging in `tools/build-zip.js`.
 */
(function initBuildFlags(global) {
  const NT = global.NT || (global.NT = {});
  NT.BuildFlags = Object.freeze({
    allowTestCommandsInBuild: true
  });
})(globalThis);
