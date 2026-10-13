/**
 * Offline smoke test: load the extension with a stub Pi API and check what it
 * registers. Needs no API key and no network.
 */

import assert from 'node:assert/strict'
import extension from '../index.ts'

const flags: string[] = []
const tools = new Map<string, { defaultActive?: boolean }>()
const commands: string[] = []
const events: string[] = []

const pi = {
  registerFlag: (name: string) => flags.push(name),
  getFlag: () => undefined,
  registerTool: (tool: { name: string; defaultActive?: boolean }) => tools.set(tool.name, tool),
  registerCommand: (name: string) => commands.push(name),
  on: (event: string) => events.push(event),
}

// SAFETY: at load time the extension only calls the members stubbed above; handlers are registered, not run.
extension(pi as never)

assert.deepEqual(flags.sort(), ['e2b', 'e2b-idle', 'e2b-template'])
assert.deepEqual([...tools.keys()].sort(), ['bash', 'edit', 'preview_url', 'read', 'write'])
assert.equal(tools.get('preview_url')?.defaultActive, false, 'preview_url stays hidden until a sandbox is up')
assert.deepEqual(commands, ['e2b'])
assert.deepEqual(events.sort(), ['before_agent_start', 'session_shutdown', 'session_start', 'tool_call', 'user_bash'])

console.log('smoke ok')
