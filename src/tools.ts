/**
 * Sandbox-backed versions of Pi's default tools: bash, read, write and edit.
 *
 * Pi's tool factories take pluggable operations, so each tool keeps Pi's own
 * logic (truncation, edit matching, rendering) and only the I/O goes to E2B.
 * grep, find and ls are off by default in Pi and always search the host. In E2B
 * mode they are turned off and blocked; the agent searches with bash instead.
 */

import os from 'node:os'
import path from 'node:path'
import {
  type BashOperations,
  type ExtensionContext,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ReadOperations,
  type ToolDefinition,
  type WriteOperations,
} from '@earendil-works/pi-coding-agent'
import { CommandExitError, type Sandbox } from 'e2b'
import { type TSchema, Type } from 'typebox'

export interface Target {
  sandbox: Sandbox
  /** Working directory in the sandbox. */
  cwd: string
  /** Idle time before E2B pauses the sandbox. Every tool call restarts it. */
  idleMs: number
}

const HOST_ONLY_TOOLS = ['grep', 'find', 'ls']
const PREVIEW_TOOL = 'preview_url'

/** With --e2b, `sandbox` gives the session's sandbox, starting it on the first call. */
export function registerTools(pi: ExtensionAPI, sandbox: (ctx: ExtensionContext) => Promise<Target>): void {
  const e2b = () => pi.getFlag('e2b') === true
  const target = async (ctx: ExtensionContext): Promise<Target> => {
    const t = await sandbox(ctx).catch((err: Error) => {
      throw new Error(`The E2B sandbox is not available, so nothing ran on your machine. ${err.message}`)
    })
    keepAlive(t)
    return t
  }

  const localCwd = process.cwd()
  const route = <P extends TSchema, D>(
    local: ToolDefinition<P, D>,
    remote: (t: Target) => ToolDefinition<P, D>,
  ): ToolDefinition<P, D> => ({
    ...local,
    async execute(id, params, signal, onUpdate, ctx) {
      if (!e2b()) {
        return local.execute(id, params, signal, onUpdate, ctx)
      }
      const t = await target(ctx)
      // Pi resolves paths against ctx.cwd, which is the host cwd. Swap in the sandbox cwd.
      const sandboxCtx: typeof ctx = Object.create(ctx, { cwd: { value: t.cwd } })
      return remote(t).execute(id, params, signal, onUpdate, sandboxCtx)
    },
  })

  pi.registerTool(
    route(createBashToolDefinition(localCwd), (t) => createBashToolDefinition(t.cwd, { operations: bashOps(t) })),
  )
  pi.registerTool(
    route(createReadToolDefinition(localCwd), (t) => createReadToolDefinition(t.cwd, { operations: readOps(t) })),
  )
  pi.registerTool(
    route(createWriteToolDefinition(localCwd), (t) => createWriteToolDefinition(t.cwd, { operations: writeOps(t) })),
  )
  const edit = route(createEditToolDefinition(localCwd), (t) =>
    createEditToolDefinition(t.cwd, { operations: { ...readOps(t), ...writeOps(t) } }),
  )
  const renderEditCall = edit.renderCall
  pi.registerTool({
    ...edit,
    // Pi previews an edit by reading the file from the host disk, where sandbox files do not
    // exist. Skip that preview in E2B mode; the real diff still shows when the edit finishes.
    renderCall: renderEditCall
      ? (args, theme, context) =>
          renderEditCall(args, theme, e2b() ? Object.create(context, { argsComplete: { value: false } }) : context)
      : undefined,
  })

  // Blocked even if the user turns them back on: they would read the host, not the sandbox.
  pi.on('tool_call', (event) => {
    if (!e2b() || !HOST_ONLY_TOOLS.includes(event.toolName)) {
      return undefined
    }
    return { block: true, reason: `${event.toolName} would search the user's machine, not the sandbox. Use bash.` }
  })

  pi.registerTool({
    name: PREVIEW_TOOL,
    label: 'Preview URL',
    description:
      'Get the public URL of a port served in the E2B sandbox. Use it after you start a server, ' +
      'so the user gets a link. The server must listen on 0.0.0.0.',
    defaultActive: false,
    parameters: Type.Object({ port: Type.Integer({ minimum: 1, maximum: 65535 }) }),
    async execute(_id, { port }, _signal, _onUpdate, ctx) {
      const t = await target(ctx)
      return { content: [{ type: 'text', text: `https://${t.sandbox.getHost(port)}` }], details: undefined }
    },
  })

  // `!` commands. Pi passes the host cwd here, so pin the sandbox cwd.
  pi.on('user_bash', async (_event, ctx) => {
    if (!e2b()) {
      return undefined
    }
    try {
      const t = await target(ctx)
      return { operations: bashOps(t, t.cwd) }
    } catch (err) {
      // SAFETY: target() only rejects with the Error it builds above.
      return { result: { output: (err as Error).message, exitCode: 1, cancelled: false, truncated: false } }
    }
  })
}

/** Switch the active tools to E2B mode: add preview_url, drop the tools that would search the host. */
export function useSandboxTools(pi: ExtensionAPI): void {
  const active = pi.getActiveTools().filter((name) => !HOST_ONLY_TOOLS.includes(name))
  pi.setActiveTools([...active, PREVIEW_TOOL])
}

/** Restart the idle timer. A paused sandbox rejects this, but the tool call itself resumes it. */
function keepAlive(t: Target): void {
  t.sandbox.setTimeout(t.idleMs).catch(() => undefined)
}

/**
 * E2B returns from a command when its output pipes close, and `npm run dev &`
 * keeps them open. So the command runs in its own process group (setsid) with
 * output in a file, and `tail --pid` streams that file until the foreground
 * process exits. The process group id goes to a file named after the wrapper's
 * pid, so abort and timeout can kill the whole group.
 */
const WRAPPER = [
  'cmd=$PI_E2B_COMMAND; unset PI_E2B_COMMAND',
  'out=$(mktemp)',
  'setsid bash -c "$cmd" >"$out" 2>&1 </dev/null &',
  'pid=$!',
  'echo "$pid" > /tmp/pi-e2b-$$.pgid',
  'tail -s 0.1 -n +1 --pid="$pid" -f "$out"',
  'wait "$pid"; rc=$?',
  'rm -f "$out" /tmp/pi-e2b-$$.pgid',
  'exit "$rc"',
].join('\n')

/** The host env is not forwarded: it would leak host secrets into the sandbox. */
function bashOps(t: Target, cwdOverride?: string): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (signal?.aborted) {
        throw new Error('aborted')
      }
      const handle = await t.sandbox.commands.run(WRAPPER, {
        background: true,
        cwd: toSandboxPath(cwdOverride ?? cwd),
        envs: { PI_E2B_COMMAND: command },
        timeoutMs: 0,
        onStdout: (data) => {
          onData(Buffer.from(data))
        },
        onStderr: (data) => {
          onData(Buffer.from(data))
        },
      })

      let stopped: Error | undefined
      const stop = (reason: Error) => {
        stopped ??= reason
        const pgid = `$(cat /tmp/pi-e2b-${handle.pid}.pgid)`
        t.sandbox.commands
          .run(`kill -TERM -- -${pgid}; sleep 1; kill -KILL -- -${pgid}`, { timeoutMs: 10_000 })
          .catch(() => undefined)
          .finally(() => handle.kill().catch(() => undefined))
      }
      const onAbort = () => {
        stop(new Error('aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer = timeout
        ? setTimeout(() => {
            stop(new Error(`timeout:${timeout}`))
          }, timeout * 1000)
        : undefined
      // Long commands must not hit the idle timeout.
      const heartbeat = setInterval(() => {
        keepAlive(t)
      }, 60_000)

      try {
        const { exitCode } = await handle.wait()
        if (stopped) {
          throw stopped
        }
        return { exitCode }
      } catch (err) {
        if (stopped) {
          throw stopped
        }
        if (err instanceof CommandExitError) {
          return { exitCode: err.exitCode }
        }
        throw err
      } finally {
        clearTimeout(timer)
        clearInterval(heartbeat)
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}

const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
])

function readOps(t: Target): ReadOperations {
  return {
    readFile: async (p) => Buffer.from(await t.sandbox.files.read(toSandboxPath(p), { format: 'bytes' })),
    access: async (p) => {
      if (!(await t.sandbox.files.exists(toSandboxPath(p)))) {
        throw new Error(`ENOENT: no such file '${p}'`)
      }
    },
    detectImageMimeType: async (p) => IMAGE_TYPES.get(path.posix.extname(p).toLowerCase()) ?? null,
  }
}

function writeOps(t: Target): WriteOperations {
  return {
    // files.write creates missing parent directories.
    writeFile: async (p, content) => {
      await t.sandbox.files.write(toSandboxPath(p), content)
    },
    mkdir: async (dir) => {
      await t.sandbox.files.makeDir(toSandboxPath(dir))
    },
  }
}

/** Pi expands `~` to the HOST home directory. Point such paths at the sandbox home. */
function toSandboxPath(p: string): string {
  const hostHome = os.homedir()
  return p === hostHome || p.startsWith(`${hostHome}/`) ? `/home/user${p.slice(hostHome.length)}` : p
}
