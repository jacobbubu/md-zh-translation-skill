export { formatTranslatedMarkdown } from "./format.js";
export { buildClaudeDesktopMcpConfig, installTarget, type InstallResult, type InstallTarget } from "./install.js";
export {
  extractFrontmatter,
  protectMarkdownSpans,
  restoreMarkdownSpans,
  type FrontmatterSplit,
  type ProtectedKind,
  type ProtectedMarkdown,
  type ProtectedSpan
} from "./markdown-protection.js";
export { translateMarkdownArticle, parseGateAudit, type GateAudit, type TranslateOptions, type TranslateResult } from "./translate.js";
