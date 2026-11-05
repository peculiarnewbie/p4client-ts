// Vendored from pingdotgg/t3code (oxlint-plugin-t3code), MIT, Copyright (c) 2026 T3 Tools Inc. See LICENSE.
// Only the rules p4client-ts uses; see UPSTREAM.md.

import { definePlugin } from "vite-plus/lint/plugins";

import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noLowValueComments from "./rules/no-low-value-comments.ts";
import preferEffectFn from "./rules/prefer-effect-fn.ts";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";

export default definePlugin({
  meta: {
    name: "t3code",
  },
  rules: {
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-low-value-comments": noLowValueComments,
    "prefer-effect-fn": preferEffectFn,
    "require-suppression-reason": requireSuppressionReason,
  },
});
