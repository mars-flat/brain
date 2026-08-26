/**
 * Portability is a test, not a promise (§3): core and contracts never name a
 * vendor. These rules fail CI on any violation.
 */
module.exports = {
  forbidden: [
    {
      name: "contracts-zero-deps",
      comment:
        "§8.1 — packages/contracts is schemas + types with ZERO dependencies. " +
        "It may import nothing outside its own src tree (type-only imports excepted).",
      severity: "error",
      from: { path: "^packages/contracts/src" },
      to: {
        pathNot: "^packages/contracts/src",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "core-stays-pure",
      comment:
        "§3 — packages/core is pure domain logic: no I/O, no clock, no randomness, " +
        "no vendor SDKs. It may import only contracts (Clock etc. are ports).",
      severity: "error",
      from: { path: "^packages/core/src" },
      to: {
        pathNot: "^packages/(core|contracts)/src",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "no-cloud-sdk-outside-adapters",
      comment: "§3 — cloud SDKs live in adapters/* only. The app never imports one in packages/.",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^node_modules/@(azure|aws-sdk|google-cloud)/" },
    },
    {
      name: "core-no-crypto",
      comment:
        "§3 — packages/core is pure: no node:crypto (envelope encryption lives in adapters/secrets-file).",
      severity: "error",
      from: { path: "^packages/core/src" },
      to: { path: "^node:crypto$" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "bun"],
    },
  },
};
