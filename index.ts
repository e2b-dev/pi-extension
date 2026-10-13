/**
 * @e2b/pi: with `--e2b`, Pi's tools run in an E2B sandbox that belongs to the
 * Pi session. Pi itself, the model calls and your files stay on your machine.
 *
 * - Start: Pi opens at once. The sandbox starts with your first prompt, and
 *   your git working tree is uploaded (ignored files stay home).
 * - Work: bash, read, write and edit run in the sandbox. Idle sandboxes pause
 *   with their memory and resume on the next call.
 * - Pull: `/e2b pull` applies the sandbox's changes to your checkout.
 * - Resume: the session gets the same sandbox back. A fork gets a copy of it.
 * - Cleanup: sandboxes of deleted sessions are killed; `--no-session` ones on exit.
 */

import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type ExtensionAPI, type ExtensionContext, getAgentDir, SessionManager } from '@earendil-works/pi-coding-agent'
import { NotFoundError, Sandbox } from 'e2b'
import { registerTools, type Target, useSandboxTools } from './src/tools.ts'
import { changes, gitRoot, init, pull, upload } from './src/workspace.ts'

const ENTRY = 'e2b-sandbox'
/** Sandboxes are tagged with the machine, so cleanup never touches another machine's sessions. */
const HOST = createHash('sha256').update(`${os.hostname()}:${os.userInfo().username}`).digest('hex').slice(0, 16)
/** Cleanup leaves younger sandboxes alone: their session may not have recorded them yet. */
const GRACE_MS = 15 * 60_000

/** Where the project lives in the sandbox. */
interface Layout {
  /** Working directory in the sandbox. */
  cwd: string
  /** Repository root in the sandbox. */
  dir: string
  /** Host checkout that `/e2b pull` writes to; unset outside a git checkout. */
  hostRoot?: string
}

/** Recorded in the session so a resumed session finds its sandbox again. */
interface Entry extends Layout {
  sandboxId: string
  /** Session that owns the sandbox. A fork inherits the parent's entry, so a different owner means "copy it". */
  owner: string
}

interface Active extends Target, Entry {}

/** What session_start learns; the sandbox itself starts later, on first use. */
interface Pending {
  apiKey: string
  idleMs: number
  layout: Layout
  /** The sandbox this session (or the session it was forked from) used last. */
  prev?: Entry
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag('e2b', { description: 'Run tools in an E2B sandbox', type: 'boolean' })
  pi.registerFlag('e2b-template', { description: 'E2B template (default: base)', type: 'string' })
  pi.registerFlag('e2b-idle', { description: 'Idle minutes before the sandbox pauses (default: 15)', type: 'string' })

  let pending: Pending | undefined
  let active: Active | undefined
  let starting: Promise<Active> | undefined
  let apiKey: string | undefined

  /** The session's sandbox. The first call starts it; calls meanwhile wait for the same start. */
  function sandbox(ctx: ExtensionContext): Promise<Active> {
    if (active) {
      return Promise.resolve(active)
    }
    if (!pending) {
      return Promise.reject(new Error('E2B is not set up. Restart Pi with --e2b and E2B_API_KEY.'))
    }
    starting ??= start(ctx, pending).finally(() => {
      starting = undefined
    })
    return starting
  }

  registerTools(pi, sandbox)

  pi.registerCommand('e2b', {
    description: 'E2B sandbox: status | pull [--branch] | kill',
    getArgumentCompletions: (prefix) =>
      ['status', 'pull', 'pull --branch', 'kill'].flatMap((s) =>
        s.startsWith(prefix.trim()) ? [{ value: s, label: s }] : [],
      ),
    handler: async (args, ctx) => {
      const sub = args.trim() || 'status'
      if (!pending) {
        ctx.ui.notify('No E2B sandbox. Start Pi with --e2b.', 'warning')
        return
      }
      // A resumed session's sandbox has not been touched yet: resume it. A new session has none to show.
      if (!active && !pending.prev) {
        ctx.ui.notify('No E2B sandbox yet. It starts with your first prompt.', 'info')
        return
      }
      const a = await sandbox(ctx).catch(() => undefined)
      if (!a) {
        return
      }
      if (sub === 'pull') {
        return pullChanges(ctx, a)
      }
      if (sub === 'pull --branch') {
        return pullChanges(ctx, a, `pi/${ctx.sessionManager.getSessionId().slice(0, 8)}`)
      }
      if (sub === 'kill') {
        if (!(await ctx.ui.confirm('Kill sandbox', `Kill ${a.sandboxId}? Changes you did not pull are lost.`))) {
          return
        }
        active = undefined
        if (pending) {
          pending = { ...pending, prev: undefined }
        }
        await a.sandbox.kill()
        status(ctx, a.cwd)
        ctx.ui.notify(`Killed ${a.sandboxId}. The next tool call starts a new one.`, 'info')
        return
      }
      const { stat } = await changes(a.sandbox, a.dir)
      ctx.ui.notify(`E2B sandbox ${a.sandboxId}\ncwd: ${a.cwd}\n${stat || 'No changes to pull.'}`, 'info')
    },
  })

  /** Apply the sandbox's changes to the host checkout; with `branch`, commit them on that local branch. */
  async function pullChanges(ctx: ExtensionContext, a: Active, branch?: string): Promise<void> {
    if (!a.hostRoot) {
      ctx.ui.notify('Pi was not started in a git checkout, so there is nowhere to pull to.', 'warning')
      return
    }
    const c = await changes(a.sandbox, a.dir)
    if (!c.stat) {
      ctx.ui.notify('No changes to pull.', 'info')
      return
    }
    const where = branch ? `a commit on branch ${branch} in ${a.hostRoot}` : a.hostRoot
    if (!(await ctx.ui.confirm('Pull changes', `Apply to ${where}?\n\n${c.stat}`))) {
      return
    }
    try {
      await pull(a.sandbox, a.dir, a.hostRoot, c, branch)
      ctx.ui.notify(branch ? `Committed on ${branch}. Push it with git push.` : 'Pulled. Review with git diff.', 'info')
    } catch (err) {
      ctx.ui.notify(`Pull failed: ${message(err)}`, 'error')
    }
  }

  /** Reconnect to the session's sandbox, fork the parent session's one, or create one and upload the project. */
  async function start(ctx: ExtensionContext, p: Pending): Promise<Active> {
    const sessionId = ctx.sessionManager.getSessionId()
    const saved = ctx.sessionManager.getSessionFile() !== undefined
    const started = Date.now()
    ctx.ui.setStatus('e2b', 'e2b: starting...')
    let created: Sandbox | undefined
    try {
      let sb: Sandbox | undefined
      let how = 'ready'
      if (p.prev) {
        sb = await reconnect(p, p.prev, ctx)
        if (sb && p.prev.owner !== sessionId) {
          sb = created = await fork(sb, p.idleMs)
          how = `forked from ${p.prev.sandboxId}`
        }
      }
      if (!sb) {
        const template = pi.getFlag('e2b-template')
        const opts = {
          apiKey: p.apiKey,
          timeoutMs: p.idleMs,
          // A --no-session sandbox can never be resumed, so a crashed Pi leaves nothing behind.
          lifecycle: saved ? { onTimeout: 'pause' as const, autoResume: true } : { onTimeout: 'kill' as const },
          // Only sandboxes tagged with this machine are ever cleaned up.
          metadata: { 'created-by': 'pi-e2b', 'pi-session': sessionId, ...(inPiStore(ctx) ? { 'pi-host': HOST } : {}) },
        }
        sb = created = template ? await Sandbox.create(String(template), opts) : await Sandbox.create(opts)
        if (p.layout.hostRoot) {
          ctx.ui.setStatus('e2b', 'e2b: uploading...')
          await upload(sb, p.layout.hostRoot, p.layout.dir)
        } else {
          await init(sb, p.layout.dir)
        }
      }
      const entry: Entry = { ...p.layout, sandboxId: sb.sandboxId, owner: sessionId }
      if (created && saved) {
        pi.appendEntry(ENTRY, entry)
      }
      active = { ...entry, sandbox: sb, idleMs: p.idleMs }
      const secs = ((Date.now() - started) / 1000).toFixed(1)
      ctx.ui.notify(`E2B sandbox ${sb.sandboxId} ${how} in ${secs}s.`, 'info')
      status(ctx, active.cwd, sb.sandboxId)
      return active
    } catch (err) {
      await created?.kill().catch(() => undefined)
      status(ctx, p.layout.cwd, p.prev?.sandboxId)
      ctx.ui.notify(`E2B: could not start the sandbox: ${message(err)}`, 'error')
      throw err
    }
  }

  /** The recorded sandbox, resumed; undefined when it is gone. Any other error must not create a second one. */
  async function reconnect(p: Pending, prev: Entry, ctx: ExtensionContext): Promise<Sandbox | undefined> {
    try {
      return await Sandbox.connect(prev.sandboxId, { apiKey: p.apiKey, timeoutMs: p.idleMs })
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        throw err
      }
      ctx.ui.notify(`E2B: sandbox ${prev.sandboxId} is gone, creating a new one.`, 'warning')
      return undefined
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    if (pi.getFlag('e2b') !== true || active || starting) {
      return
    }
    apiKey ??= process.env.E2B_API_KEY || (ctx.hasUI ? await ctx.ui.input('E2B API key', 'e2b_...') : undefined)
    if (!apiKey) {
      ctx.ui.notify('E2B: set E2B_API_KEY. Tools stay off until then.', 'error')
      return
    }

    if (inPiStore(ctx)) {
      void reap(apiKey).catch(() => undefined)
    }
    const prev = lastEntry(ctx)
    pending = {
      apiKey,
      idleMs: (Number(pi.getFlag('e2b-idle')) || 15) * 60_000,
      layout: prev ?? (await layoutFor(ctx.sessionManager.getCwd())),
      prev,
    }
    useSandboxTools(pi)
    status(ctx, pending.layout.cwd, prev?.sandboxId)
  })

  pi.on('before_agent_start', (event, ctx) => {
    if (!pending) {
      return
    }
    // Start (or resume) the sandbox while the model works on its first reply.
    if (!active) {
      void sandbox(ctx).catch(() => undefined)
    }
    if (!event.systemPromptOptions) {
      return
    }
    event.systemPromptOptions.cwd = `${pending.layout.cwd} (in an E2B sandbox, not on the user's machine)`
    event.systemPromptOptions.promptGuidelines = [
      ...(event.systemPromptOptions.promptGuidelines ?? []),
      'You work in a copy of the project in an E2B sandbox. The user brings your file changes back with /e2b pull. ' +
        'Use bash (grep, rg, find, ls) to search. Servers must listen on 0.0.0.0; use preview_url to share them.',
    ]
  })

  pi.on('session_shutdown', async (event, ctx) => {
    const a = active ?? (await starting?.catch(() => undefined))
    active = undefined
    pending = undefined
    ctx.ui.setStatus('e2b', undefined)
    if (!a) {
      return
    }
    if (ctx.sessionManager.getSessionFile() !== undefined) {
      // Kept for resume. On quit, pause in a minute instead of after the full idle time.
      if (event.reason !== 'reload') {
        await a.sandbox.setTimeout(60_000).catch(() => undefined)
      }
      return
    }
    // --no-session: this sandbox can never be resumed. Offer the changes, then kill it.
    if (ctx.hasUI && a.hostRoot) {
      await pullChanges(ctx, a).catch(() => undefined)
    }
    await a.sandbox.kill().catch(() => undefined)
  })
}

/** A copy of `parent` with its files and running processes. The parent keeps running. */
async function fork(parent: Sandbox, idleMs: number): Promise<Sandbox> {
  const [copy] = await Sandbox.fork(parent.sandboxId, { timeoutMs: idleMs })
  // The parent was resumed only to be copied; let it pause again soon.
  await parent.setTimeout(60_000).catch(() => undefined)
  if (!copy) {
    throw new Error('E2B returned no fork')
  }
  if (copy instanceof Error) {
    throw copy
  }
  return copy
}

/** The sandbox mirrors the host checkout, so the agent sees the same subdirectory you started Pi in. */
async function layoutFor(startDir: string): Promise<Layout> {
  // git prints the resolved path (/private/var/... on macOS), so resolve symlinks here too.
  const hostCwd = await realpath(startDir)
  const hostRoot = await gitRoot(hostCwd)
  const dir = `/home/user/${path.basename(hostRoot ?? 'workspace').replace(/[^\w.-]/g, '_')}`
  const cwd = hostRoot ? path.posix.join(dir, path.relative(hostRoot, hostCwd)) : dir
  return { cwd, dir, hostRoot }
}

function status(ctx: ExtensionContext, cwd: string, sandboxId?: string): void {
  const id = sandboxId ? sandboxId.slice(0, 8) : 'new'
  ctx.ui.setStatus('e2b', ctx.ui.theme.fg('accent', `e2b: ${id} ${cwd}`))
}

function lastEntry(ctx: ExtensionContext): Entry | undefined {
  const e = ctx.sessionManager.getEntries().findLast((e) => e.type === 'custom' && e.customType === ENTRY)
  // SAFETY: entries of this custom type are written only by this extension, always as Entry.
  return e?.type === 'custom' ? (e.data as Entry) : undefined
}

// `catch` gives `unknown`; this turns it into text for the user.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * A saved session in Pi's own session store, the one SessionManager.listAll()
 * reads. Cleanup trusts only that store, so sandboxes of sessions kept
 * elsewhere (--session-dir, --no-session) are never cleaned up by it.
 */
function inPiStore(ctx: ExtensionContext): boolean {
  if (ctx.sessionManager.getSessionFile() === undefined) {
    return false
  }
  return path.dirname(ctx.sessionManager.getSessionDir()) === path.join(getAgentDir(), 'sessions')
}

/**
 * Kill this machine's sandboxes that no Pi session refers to any more. Pi has
 * no "session deleted" event, so read the sessions that still exist. Forks
 * copy the parent's E2B metadata, so the session files are the only reliable
 * owner record.
 */
async function reap(apiKey: string): Promise<void> {
  const kept = new Set<string>()
  for (const s of await SessionManager.listAll()) {
    // A session that cannot be read may still own a sandbox: then kill nothing.
    const text = await readFile(s.path, 'utf8')
    for (const m of text.matchAll(/"sandboxId":"([^"]+)"/g)) {
      if (m[1]) {
        kept.add(m[1])
      }
    }
  }
  const pages = Sandbox.list({ apiKey, query: { metadata: { 'created-by': 'pi-e2b', 'pi-host': HOST } } })
  while (pages.hasNext) {
    for (const s of await pages.nextItems()) {
      if (kept.has(s.sandboxId) || Date.now() - s.startedAt.getTime() < GRACE_MS) {
        continue
      }
      await Sandbox.kill(s.sandboxId, { apiKey }).catch(() => undefined)
    }
  }
}
