/**
 * Live test against a real E2B sandbox (needs E2B_API_KEY). Drives the tools
 * the way Pi does, and moves a real git checkout up and back.
 *
 *   E2B_API_KEY=... npm run test:live
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Sandbox } from 'e2b'
import extension from '../index.ts'
import { registerTools, type Target } from '../src/tools.ts'
import { changes, pull, upload } from '../src/workspace.ts'

const apiKey = process.env.E2B_API_KEY
if (!apiKey) {
  throw new Error('Set E2B_API_KEY')
}

async function step(name: string, fn: () => Promise<void>) {
  const t = Date.now()
  await fn().catch((err) => {
    console.log(`FAIL ${name}`)
    throw err
  })
  console.log(`ok   ${name} (${Date.now() - t} ms)`)
}

// A host checkout with a committed file, an uncommitted change and an ignored secret.
const host = mkdtempSync(path.join(os.tmpdir(), 'pi-e2b-live-'))
const git = (...args: string[]) => execFileSync('git', args, { cwd: host }).toString()
git('init', '-q')
writeFileSync(path.join(host, 'app.ts'), 'export const v = 1\n')
writeFileSync(path.join(host, '.gitignore'), '.env\n')
git('add', '-A')
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
writeFileSync(path.join(host, 'app.ts'), 'export const v = 2 // uncommitted\n')
writeFileSync(path.join(host, '.env'), 'SECRET=1\n')

const sandbox = await Sandbox.create({
  apiKey,
  timeoutMs: 5 * 60_000,
  lifecycle: { onTimeout: 'pause', autoResume: true },
})
const dir = '/home/user/proj'
/** Sandboxes the lifecycle test started, killed at the end. */
const started = new Set<string>()
const run = Date.now().toString(36)
const [sessionA, sessionB] = [`live-a-${run}`, `live-b-${run}`]
const target: Target = { sandbox, cwd: dir, idleMs: 5 * 60_000 }

// Register the tools against a stub Pi with --e2b on, and keep them by name.
const tools = new Map<string, ToolDefinition>()
let blockToolCall: (event: { toolName: string }) => { block: boolean } | undefined = () => undefined
const pi = {
  getFlag: () => true,
  registerTool: (t: ToolDefinition) => tools.set(t.name, t),
  on: (event: string, handler: typeof blockToolCall) => {
    if (event === 'tool_call') {
      blockToolCall = handler
    }
  },
}
// SAFETY: registerTools only calls the members stubbed above.
registerTools(pi as never, async () => target)
// SAFETY: the built-in tools read only `cwd` and the session id and file from the context.
const ctx = {
  cwd: process.cwd(),
  sessionManager: { getSessionId: () => 'test', getSessionFile: () => undefined },
} as never
/** Union of the tool parameters this test uses. */
interface ToolParams {
  path?: string
  content?: string
  command?: string
  timeout?: number
  pattern?: string
  edits?: { oldText: string; newText: string }[]
}
const call = async (name: string, params: ToolParams, signal?: AbortSignal) => {
  const r = await tools.get(name)?.execute('id', params, signal, undefined, ctx)
  return (r?.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n')
}
const alive = (args: string) => `ps -eo args= | grep -qx '${args}' && echo alive || echo none`

try {
  await step('upload: working tree up, ignored files stay home', async () => {
    await upload(sandbox, host, dir)
    assert.match(await call('read', { path: 'app.ts' }), /v = 2 \/\/ uncommitted/)
    assert.doesNotMatch(await call('bash', { command: 'ls -A' }), /\.env/)
  })

  await step('write, edit, read', async () => {
    await call('write', { path: 'src/new.ts', content: 'export const n = 1\n' })
    await call('edit', { path: 'app.ts', edits: [{ oldText: 'v = 2', newText: 'v = 3' }] })
    assert.match(await call('read', { path: 'app.ts' }), /v = 3/)
  })

  await step('bash: output, cwd, exit code', async () => {
    assert.match(await call('bash', { command: 'pwd; echo err >&2' }), /\/home\/user\/proj[\s\S]*err/)
    const failed = await call('bash', { command: 'exit 3' }).catch((e: Error) => e.message)
    assert.match(failed, /code 3/)
  })

  await step('bash: a background server does not hang the call', async () => {
    await call('bash', { command: 'python3 -m http.server 8000 >/dev/null 2>&1 & sleep 1' })
    assert.match(await call('bash', { command: 'curl -s -o /dev/null -w "%{http_code}" localhost:8000' }), /200/)
  })

  await step('bash: timeout and abort kill the process group', async () => {
    await assert.rejects(call('bash', { command: 'sleep 30', timeout: 2 }), /timed out/)
    const ac = new AbortController()
    setTimeout(() => {
      ac.abort()
    }, 1500)
    await assert.rejects(call('bash', { command: 'sleep 40' }, ac.signal), /abort/i)
    await new Promise((r) => setTimeout(r, 2500))
    assert.match(await call('bash', { command: `${alive('sleep 30')}; ${alive('sleep 40')}` }), /none\s+none/)
  })

  await step('grep, find and ls are blocked, other tools are not', async () => {
    for (const toolName of ['grep', 'find', 'ls']) {
      assert.equal(blockToolCall({ toolName })?.block, true)
    }
    assert.equal(blockToolCall({ toolName: 'bash' }), undefined)
  })

  await step('a paused sandbox resumes on the next call, with its processes', async () => {
    await sandbox.pause()
    assert.match(await call('bash', { command: 'curl -s -o /dev/null -w "%{http_code}" localhost:8000' }), /200/)
  })

  await step('pull: sandbox changes land in the host checkout, once', async () => {
    await call('bash', { command: 'git add -A && git -c user.name=a -c user.email=a@a commit -qm agent' })
    const c = await changes(sandbox, dir)
    assert.match(c.stat, /app\.ts[\s\S]*src\/new\.ts/)
    await pull(sandbox, dir, host, c)
    assert.match(readFileSync(path.join(host, 'app.ts'), 'utf8'), /v = 3/)
    assert.equal(readFileSync(path.join(host, 'src/new.ts'), 'utf8'), 'export const n = 1\n')
    assert.equal((await changes(sandbox, dir)).stat, '', 'nothing left to pull')
  })

  await step('pull --branch: refuses a dirty tree, then commits only the agent changes', async () => {
    await call('write', { path: 'src/new.ts', content: 'export const n = 2\n' })
    // The previous pull left the host tree dirty.
    await assert.rejects(pull(sandbox, dir, host, await changes(sandbox, dir), 'pi/test'), /commit or stash/)
    git('add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first pull')
    await pull(sandbox, dir, host, await changes(sandbox, dir), 'pi/test')
    assert.equal(git('branch', '--show-current').trim(), 'pi/test')
    assert.equal(git('show', '--name-only', '--format=', 'HEAD').trim(), 'src/new.ts')
    assert.equal(git('status', '--porcelain'), '')

    await call('write', { path: 'src/new.ts', content: 'export const n = 3\n' })
    await pull(sandbox, dir, host, await changes(sandbox, dir), 'pi/test')
    assert.equal(git('rev-list', '--count', 'HEAD~2..HEAD').trim(), '2', 'second pull is a second commit on the branch')
  })

  await step('session: lazy start, resume, and a fork gets its own copy', async () => {
    await lifecycle()
  })
} finally {
  await sandbox.kill().catch(() => undefined)
  for (const session of [sessionA, sessionB]) {
    const pages = Sandbox.list({ apiKey, query: { metadata: { 'pi-session': session } } })
    while (pages.hasNext) {
      for (const s of await pages.nextItems()) {
        started.add(s.sandboxId)
      }
    }
  }
  for (const id of started) {
    await Sandbox.kill(id, { apiKey }).catch(() => undefined)
  }
}
console.log('all live checks passed')

/** Drive the whole extension through a stub Pi: one session, a resume, then a fork of it. */
async function lifecycle() {
  interface Custom {
    type: 'custom'
    customType: string
    data: { sandboxId: string; owner: string; cwd: string }
  }
  interface SessionEvent {
    reason: string
  }
  type Handler = (event: SessionEvent, ctx: ReturnType<typeof sessionCtx>) => Promise<void> | void
  const handlers = new Map<string, Handler>()
  const extTools = new Map<string, ToolDefinition>()
  let entries: Custom[] = []
  let sessionId = sessionA
  const notes: string[] = []
  let command: ((args: string, ctx: ReturnType<typeof sessionCtx>) => Promise<void>) | undefined
  const piStub = {
    registerFlag: () => undefined,
    getFlag: (name: string) => (name === 'e2b' ? true : undefined),
    registerTool: (t: ToolDefinition) => extTools.set(t.name, t),
    registerCommand: (_name: string, opts: { handler: typeof command }) => {
      command = opts.handler
    },
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    getActiveTools: () => ['read', 'bash', 'edit', 'write'],
    setActiveTools: () => undefined,
    appendEntry: (customType: string, data: Custom['data']) => entries.push({ type: 'custom', customType, data }),
  }
  // SAFETY: the extension only calls the members stubbed above.
  extension(piStub as never)
  const ui = {
    setStatus: () => undefined,
    notify: (text: string) => notes.push(text),
    theme: { fg: (_color: string, text: string) => text },
  }
  const sessionCtx = () => ({
    cwd: host,
    hasUI: false,
    ui,
    sessionManager: {
      getSessionId: () => sessionId,
      // Outside Pi's session store, so cleanup never runs and the sandboxes are not tagged for it.
      getSessionFile: () => '/nonexistent/live.jsonl',
      getSessionDir: () => '/nonexistent',
      getCwd: () => host,
      getEntries: () => entries,
    },
  })
  const bash = async (command: string) => {
    // SAFETY: the tools read only cwd, ui and the session manager members stubbed in sessionCtx.
    const r = await extTools.get('bash')?.execute('id', { command }, undefined, undefined, sessionCtx() as never)
    return (r?.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n')
  }
  const sandboxesOf = async (session: string) => {
    const pages = Sandbox.list({ apiKey, query: { metadata: { 'pi-session': session } } })
    const ids: string[] = []
    while (pages.hasNext) {
      for (const s of await pages.nextItems()) {
        ids.push(s.sandboxId)
      }
    }
    return ids
  }
  const emit = (event: string, payload: SessionEvent) => handlers.get(event)?.(payload, sessionCtx())

  // Session A: no sandbox until the first tool call.
  await emit('session_start', { reason: 'startup' })
  assert.deepEqual(await sandboxesOf(sessionA), [], 'session_start does not create a sandbox')
  assert.match(await bash('pwd'), /\/home\/user\/pi-e2b-live-/)
  const a = entries.at(-1)?.data
  assert.ok(a && a.owner === sessionA, 'the sandbox is recorded for session A')
  started.add(a.sandboxId)
  await bash('echo from-a > note.txt; python3 -m http.server 8001 >/dev/null 2>&1 & sleep 1')
  await emit('session_shutdown', { reason: 'quit' })

  // Resume A: the same sandbox, and no new entry. /e2b resumes it before any tool call.
  await emit('session_start', { reason: 'resume' })
  await command?.('', sessionCtx())
  assert.match(notes.at(-1) ?? '', new RegExp(`E2B sandbox ${a.sandboxId}\\ncwd:`))
  assert.match(await bash('cat note.txt'), /from-a/)
  assert.equal(entries.length, 1)
  await emit('session_shutdown', { reason: 'quit' })

  // Fork A into B: B inherits A's entries and gets a copy, with files and running processes.
  sessionId = sessionB
  entries = [...entries]
  await emit('session_start', { reason: 'fork' })
  assert.match(await bash('cat note.txt; curl -s -o /dev/null -w "%{http_code}" localhost:8001'), /from-a[\s\S]*200/)
  const b = entries.at(-1)?.data
  assert.ok(b && b.owner === sessionB && b.sandboxId !== a.sandboxId, 'the fork has its own sandbox')
  started.add(b.sandboxId)
  await bash('echo from-b > note.txt')
  await emit('session_shutdown', { reason: 'quit' })

  // A is untouched by B.
  const sbA = await Sandbox.connect(a.sandboxId, { apiKey })
  assert.equal((await sbA.files.read(`${a.cwd}/note.txt`)).trim(), 'from-a')
}
