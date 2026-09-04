/** Default inject-context budget for `/_api/recall` when the caller omits
    maxTokens. Must stay in sync with src-tauri/.../search.rs's warm-sidecar
    URL (`maxTokens=1500`) — a higher budget is what makes mission/tool
    recall actually useful instead of a 500-token stub. */
export const BRAIN_RECALL_MAX_TOKENS = 1500;
