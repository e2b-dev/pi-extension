# E2B extension for Pi

Keep [Pi](https://pi.dev) on your machine and run its tools in an [E2B](https://e2b.dev) sandbox.

With `pi --e2b`, the agent works on a copy of your project in a sandbox that belongs to the Pi session. It cannot touch your files, processes or credentials. You bring its changes back with `/e2b pull`.

## Install

```bash
npm install -g @earendil-works/pi-coding-agent
pi install npm:@e2b/pi
export E2B_API_KEY=e2b_***   # https://e2b.dev/dashboard?tab=keys
```

## Use

```bash
cd my-project
pi --e2b
```

1. **Start.** Pi opens at once. The sandbox starts with your first prompt, and your git working tree goes to it: tracked files and new files, with your uncommitted changes. Files that git ignores, such as `.env`, stay on your machine.
2. **Work.** `bash`, `read`, `write`, `edit` and your `!` commands run in the sandbox. When the agent starts a server, `preview_url` gives you a public link.
3. **Pull.** `/e2b pull` shows what changed and applies it to your checkout. Or use `/e2b pull --branch` to get a commit on the local branch `pi/<session>`. Push and open the pull request with your own git.
4. **Resume.** Quit when you want. `pi --e2b -c` gets the same sandbox back, with its files and running processes. A forked session (`/fork`, `--fork`) gets its own copy of the sandbox, so the two sessions do not share files.

Outside a git checkout you get an empty workspace.

| Command | |
| --- | --- |
| `/e2b` | Sandbox ID, working directory, changes not pulled yet |
| `/e2b pull` | Apply the sandbox's changes to your checkout |
| `/e2b pull --branch` | Commit them on the local branch `pi/<session>` instead, ready for `git push` (needs a clean working tree) |
| `/e2b kill` | Kill the sandbox |

| Flag | |
| --- | --- |
| `--e2b` | Run tools in an E2B sandbox |
| `--e2b-template <name>` | E2B template (default `base`) |
| `--e2b-idle <minutes>` | Idle time before the sandbox pauses (default `15`) |

## How it works

- **Tools.** Pi's tools take pluggable operations. The extension gives `bash`, `read`, `write` and `edit` operations that run in the sandbox, so Pi's own tool logic stays the same. `grep`, `find` and `ls` (off by default in Pi) would search your machine, so in E2B mode they are off and the agent searches with `bash`. When there is no sandbox, tools fail; they never run on your machine.
- **Background processes.** `npm run dev &` returns at once. Abort and timeout kill the whole process group.
- **Pause and resume.** The sandbox pauses with its memory after the idle time and resumes on the next tool call or on traffic to a preview URL. On quit it pauses after one minute.
- **Pull.** The sandbox keeps a baseline commit of what you uploaded. `/e2b pull` diffs the sandbox files against it, whatever the agent did with git, and runs `git apply` in your checkout. If your files changed in a conflicting way, nothing is applied. The baseline then moves forward, so the next pull brings only newer changes.
- **No credentials in the sandbox.** Nothing is cloned or pushed from the sandbox, and your environment variables are not sent.
- **Fork.** A forked session copies the parent's sandbox with E2B's sandbox fork (files and memory, in about a second). The parent keeps its sandbox.
- **Cleanup.** A sandbox is killed when no Pi session refers to it any more, for example after you delete the session. This is checked on the next start, for sandboxes from the same machine and sessions in Pi's own session folder. With `--no-session`, Pi offers to pull, then kills the sandbox on exit.

## Development

```bash
npm install
E2B_API_KEY=e2b_*** pi -e ./index.ts --e2b   # run from source, no build step

npm run check       # typecheck, oxlint (with the vendored anti-slop rules), oxfmt, offline smoke test
npm run test:live   # real sandbox: tools, background processes, abort, pause and resume, upload and pull
```

```
index.ts          flags, session lifecycle, /e2b command, cleanup
src/tools.ts      sandbox-backed bash, read, write and edit; preview_url
src/workspace.ts  upload the working tree, diff and pull changes back
```

## License

MIT
