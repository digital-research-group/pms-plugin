// Client adapters: one hook script serves Claude Code, OpenAI Codex CLI and xAI Grok
// Build, which differ in how they spell the payload and in what output they honour.
//
//   claude-code  snake_case payload; additionalContext, permissionDecision deny, decision block
//   codex        snake_case like Claude; file edits arrive as tool_name "apply_patch" with the
//                patch text in tool_input; no PostToolUseFailure, so a failed MCP call shows up
//                as an error-shaped PostToolUse result
//   grok         camelCase payload; stdout is ignored on passive events and only PreToolUse
//                can block, with { decision: "deny", reason }
//
// Everything is normalised here, so pm-sync.mjs reads one shape and asks one place what to print.
export const CLIENTS = ['claude-code', 'codex', 'grok']

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/
// Grok maps Claude tool names in matchers, but its payload names are not documented, so
// the plausible native spellings count too. A miss costs a gate, never a false block.
const GROK_EDIT_TOOLS = /^(edit|write|multi_?edit|notebook_?edit|edit_file|write_file|create_file|search_replace|str_replace\w*)$/i
const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/

const isMap = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** --client wins when it names a known client; otherwise the payload shape decides. */
export function detectClient(argv, raw) {
  const at = Array.isArray(argv) ? argv.indexOf('--client') : -1
  if (at !== -1 && CLIENTS.includes(argv[at + 1])) return argv[at + 1]
  if (!isMap(raw)) return 'claude-code'
  if ('hookEventName' in raw || 'toolName' in raw || 'toolInput' in raw) return 'grok'
  // turn_id is Codex-only; apply_patch is Codex's edit tool.
  if (raw.tool_name === 'apply_patch' || 'turn_id' in raw) return 'codex'
  return 'claude-code'
}

/** Every path an apply_patch names: added, updated, deleted, and the Move-to destination. */
export function patchPaths(text) {
  if (typeof text !== 'string') return []
  const paths = []
  for (const line of text.split('\n')) {
    const match = PATCH_HEADER.exec(line.replace(/\r$/, ''))
    const path = match?.[1].trim()
    if (path && !paths.includes(path)) paths.push(path)
  }
  return paths
}

function editPathsOf(client, toolName, toolInput, rawInput) {
  if (toolName === 'apply_patch') {
    const text = typeof rawInput === 'string' ? rawInput : toolInput.command ?? toolInput.patch ?? toolInput.input
    return patchPaths(text)
  }
  const isEdit = EDIT_TOOLS.test(toolName) || (client === 'grok' && GROK_EDIT_TOOLS.test(toolName))
  if (!isEdit) return null
  const path = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.filePath ?? toolInput.path
  return typeof path === 'string' && path ? [path] : []
}

/** The payload in one shape, whichever client sent it. Missing fields become safe defaults. */
export function normalizeInput(raw, client) {
  const value = isMap(raw) ? raw : {}
  const pick = (snake, camel) => (value[snake] !== undefined ? value[snake] : value[camel])
  const toolName = String(pick('tool_name', 'toolName') ?? '')
  const rawInput = pick('tool_input', 'toolInput')
  const toolInput = isMap(rawInput) ? rawInput : {}
  const paths = editPathsOf(client, toolName, toolInput, rawInput)
  return {
    client,
    event: String(pick('hook_event_name', 'hookEventName') ?? ''),
    toolName,
    toolInput,
    toolResponse: pick('tool_response', 'toolResponse'),
    stopHookActive: pick('stop_hook_active', 'stopHookActive') === true,
    cwd: String(value.cwd || value.workspaceRoot || ''),
    source: String(value.source ?? ''),
    isEdit: paths !== null,
    editPaths: paths ?? [],
  }
}

/** An MCP result that reports an error rather than data (how Codex surfaces a failed call). */
export function looksFailed(response) {
  let value = response
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return false } }
  if (!isMap(value)) return false
  if (value.isError === true || value.is_error === true) return true
  return (value.error !== undefined && value.error !== null && value.error !== false) || value.Err !== undefined
}

/** Context for the model. Grok ignores stdout on every passive event, so it gets nothing. */
export function contextOutput(client, hookEventName, additionalContext) {
  if (client === 'grok') return null
  return { hookSpecificOutput: { hookEventName, additionalContext } }
}

export function denyOutput(client, reason) {
  if (client === 'grok') return { decision: 'deny', reason }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
}

/**
 * Stop the model and make it act. A Codex PostToolUse block REPLACES the tool result with
 * the reason, which would hide a test run's output, so Codex gets the reason as context there.
 */
export function blockOutput(client, hookEventName, reason) {
  if (client === 'grok') return null
  if (client === 'codex' && hookEventName === 'PostToolUse') return contextOutput(client, hookEventName, reason)
  return { decision: 'block', reason }
}
