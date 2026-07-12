// src/core/plugin-api.mjs
// Host plugin API version (plugin spec §10). An INTEGER, bumped on breaking
// change ONLY. Checked against manifests' engines.maestro-api at install AND at
// load (plugin-manifest.mjs apiSatisfies). Kept in its own dependency-free
// module so the shim child (Task 11) can import it without the core graph.
export const MAESTRO_PLUGIN_API = 1;
