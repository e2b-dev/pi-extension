/**
 * Moves the user's working tree into the sandbox, and the agent's changes back.
 *
 * Up: the files git sees (tracked, plus untracked that are not ignored) go up as
 * one tarball, so ignored files such as `.env` stay on the host. In the sandbox
 * they become a fresh repository whose first commit is the baseline.
 *
 * Down: the sandbox tree is diffed against the baseline, whatever the agent did
 * with git meanwhile, and the patch is applied to the host checkout. The
 * baseline then moves forward, so the next pull brings only newer changes.
 *
 * No git credentials are involved: nothing is cloned or pushed.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Sandbox } from 'e2b'

const BASE_REF = 'refs/pi-e2b/base'
const AGENT = '-c user.name="Pi agent" -c user.email=pi-agent@localhost'

/** Run a host command; resolves with stdout, rejects with stderr. */
function run(cmd: string, args: string[], opts: { cwd: string; input?: Buffer | string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // COPYFILE_DISABLE stops macOS tar from adding `._*` metadata files.
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, COPYFILE_DISABLE: '1' } })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out))
      } else {
        reject(new Error(Buffer.concat(err).toString().trim()))
      }
    })
    child.stdin.end(opts.input)
  })
}

/** Root of the git checkout that contains `cwd`, or undefined. */
export async function gitRoot(cwd: string): Promise<string | undefined> {
  return run('git', ['rev-parse', '--show-toplevel'], { cwd }).then(
    (out) => out.toString().trim(),
    () => undefined,
  )
}

async function sh(sandbox: Sandbox, command: string, cwd?: string): Promise<string> {
  return (await sandbox.commands.run(command, { cwd, timeoutMs: 10 * 60_000 })).stdout
}

/** Upload the working tree at `root` to `dir` in the sandbox. Returns the number of files. */
export async function upload(sandbox: Sandbox, root: string, dir: string): Promise<number> {
  const listed = (await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }))
    .toString()
    .split('\0')
  // Tracked files deleted in the working tree are still listed; tar would fail on them.
  const files = listed.filter((f) => f && existsSync(path.join(root, f)))
  const tarball = await run('tar', ['-czf', '-', '--null', '-T', '-'], { cwd: root, input: files.join('\0') })

  await sandbox.files.write('/tmp/pi-e2b-upload.tgz', new Uint8Array(tarball).buffer)
  await sh(sandbox, `mkdir -p '${dir}' && tar -xzf /tmp/pi-e2b-upload.tgz -C '${dir}' && rm /tmp/pi-e2b-upload.tgz`)
  await baseline(sandbox, dir, 'Your working tree when the session started')
  return files.length
}

/** An empty repository, for sessions started outside a git checkout. */
export async function init(sandbox: Sandbox, dir: string): Promise<void> {
  await sh(sandbox, `mkdir -p '${dir}'`)
  await baseline(sandbox, dir, 'Empty workspace')
}

async function baseline(sandbox: Sandbox, dir: string, message: string): Promise<void> {
  await sh(
    sandbox,
    `git init -q -b main && git add -A && git ${AGENT} commit -q --allow-empty -m '${message}' && git update-ref ${BASE_REF} HEAD`,
    dir,
  )
}

export interface Changes {
  /** Tree of the sandbox working directory now. */
  tree: string
  /** `git diff --stat` against the baseline; empty when nothing changed. */
  stat: string
  patch: Buffer
}

/** Changes in the sandbox since the baseline. Uses a scratch index, so the agent's own index is untouched. */
export async function changes(sandbox: Sandbox, dir: string): Promise<Changes> {
  const tree = (
    await sh(sandbox, 'export GIT_INDEX_FILE=$(mktemp -u); git add -A && git write-tree; rm -f "$GIT_INDEX_FILE"', dir)
  ).trim()
  const stat = (await sh(sandbox, `git diff --stat ${BASE_REF} ${tree}`, dir)).trim()
  const patch = stat ? Buffer.from(await sh(sandbox, `git diff --binary ${BASE_REF} ${tree}`, dir)) : Buffer.alloc(0)
  return { tree, stat, patch }
}

/**
 * Apply `changes` to the host checkout at `root`, then move the sandbox baseline to them.
 *
 * With `branch`, the changes are committed on that local branch instead (created
 * if needed), so the commit holds the agent's changes only. That needs a clean
 * working tree. Pushing and opening a pull request stay with the user's own git.
 */
export async function pull(sandbox: Sandbox, dir: string, root: string, c: Changes, branch?: string): Promise<void> {
  const git = (...args: string[]) => run('git', args, { cwd: root })
  const apply = (...args: string[]) =>
    run('git', ['apply', '--whitespace=nowarn', ...args, '-'], { cwd: root, input: c.patch })
  if (branch) {
    if ((await git('status', '--porcelain')).length > 0) {
      throw new Error('commit or stash your local changes first')
    }
    await git('switch', branch).catch(() => git('switch', '-c', branch))
    await apply('--index')
    await git('commit', '-q', '-m', `Changes from Pi session in E2B\n\n${c.stat}`)
  } else {
    await apply()
  }
  await sh(
    sandbox,
    `git update-ref ${BASE_REF} $(git ${AGENT} commit-tree ${c.tree} -p ${BASE_REF} -m 'Pulled to host')`,
    dir,
  )
}
