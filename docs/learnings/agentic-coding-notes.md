# Freebuff Suite: Learnings & Notes

*Compiled from conversation on 2026-09-15 with AI assistant. Covers bidirectional git sync, agent coordination, Cloudflare dev integration, and web vs cloud differences.*

---

## 🎯 Summary of Implementation

Added bidirectional git sync and multi-agent coordination to the freebuff suite, enabling:

- **opencode desktop** + **freebuff desktop** to work together on the same project without stepping on each other's toes
- Push/pull to/from private GitHub repos without breaking dependencies
- Temporary Cloudflare dev pages for testing changes
- Divide-and-conquer task assignment across agent platforms

---

## 📁 Files Modified/Pushed

| File | Description |
|------|-------------|
| `sdk/src/run-state.ts` | 4 new SDK functions: `gitPushChanges`, `gitPullChanges`, `gitCreateBranch`, `gitApplyPatch` |
| `cli/package.json` | Added `"cloudflare-dev"` npm script |
| `cli/scripts/cloudflare-dev.ts` | Cloudflare Pages dev server spinner for local projects |
| `common/src/types/coordination.ts` | Agent coordination: file locks, task assignment, change proposals |

All changes pushed to: `https://github.com/ksl-testing/freebuff.git` (commit `4894236d0`)

---

## 🔄 Bidirectional Git Sync

### SDK Functions (`sdk/src/run-state.ts:1212-1386`)

| Function | What It Does | When to Use |
|----------|-------------|-------------|
| `gitPushChanges()` | Stage, commit, push changed files to GitHub | After making changes in opencode/freebuff desktop; push to private repo |
| `gitPullChanges()` | Fetch + rebase/merge from remote | On another platform; sync latest changes |
| `gitCreateBranch()` | Create new branch locally | Before starting a new task/experiment |
| `gitApplyPatch()` | Apply git diff patch to working dir | When one agent proposes changes for another to review |

### Key Details

- **Authentication**: Uses `CODEBUFF_GITHUB_TOKEN` environment variable (GitHub PAT)
- **Opt-in**: Existing code unaffected - functions must be explicitly called
- **No server dependency**: Pure git + GitHub API operations
- **Max 25 files**: Changed files limited to first 25 (configurable via `MAX_CHANGED_FILES`)
- **Repository visibility**: Auto-detected as `public|private|internal|unknown` via `gh repo view`

### Typical Workflow

```bash
# In opencode desktop after making changes:
bun run codebuff gitPushChanges \
  --commitMessage "feat: add new agentic feature" \
  --changedFiles "src/file1.ts,src/file2.ts"

# In freebuff desktop to sync:
bun run codebull gitPullChanges

# Or using Cloudflare dev to test first:
bun run cloudflare-dev /path/to/project
# ... test changes ...
# Then push:
gitPushChanges()
```

---

## 🤝 Agent Coordination Layer

### Purpose

Enable **opencode desktop** + **freebuff desktop** to share a project without:

- Two agents editing the same file simultaneously
- Disparate sources of truth
- Uncoordinated task duplication

### Stored in: `.freebuff/coordination.json` (project root)

### Core Features

| Feature | Description |
|---------|-------------|
| **File locks** (`acquireFileLock`, `releaseFileLock`, `checkFileLock`) | Prevent concurrent edits to same file. Locks auto-expire after 5 min (configurable). |
| **Task assignment** (`assignTask`, `updateTaskStatus`) | Track who's working on what. Status: `pending` → `in-progress` → `completed/failed/cancelled`. |
| **Change proposals** (`createChangeProposal`, `reviewChangeProposal`) | Formal mechanism: one agent proposes changes, another reviews/approves/rejects. Status: `pending` → `approved/rejected` → `applied`. |
| **Platform tracking** | Records which agents are active, their last active timestamp, current task IDs. |
| **Expire-based cleanup** | Expired locks/tasks are detected but not auto-deleted (avoid race conditions). |

### Coordination State Structure

```json
{
  "version": "1.0.0",
  "lastSync": 1234567890,
  "fileLocks": {
    "src/components/Button.tsx": {
      "filePath": "src/components/Button.tsx",
      "ownerAgentId": "opencode-desktop",
      "lockedAt": 1234567890,
      "expiresAt": 1234567890 + 300000,
      "reason": "editing"
    }
  },
  "activeTasks": [
    {
      "taskId": "task-1726452000000",
      "agentId": "freebuff-desktop",
      "description": "Implement login flow",
      "relatedFiles": ["src/pages/Login.tsx", "src/api/auth.ts"],
      "status": "in-progress",
      "startedAt": 1234567890,
      "progress": 75
    }
  ],
  "changeProposals": [
    {
      "proposalId": "prop-1726452000001",
      "proposerAgentId": "opencode-desktop",
      "description": "Refactor auth module",
      "targetFiles": ["src/api/auth.ts"],
      "patchContent": "@@ -1,7 +1,8 @@\n import { ... }",
      "status": "pending",
      "createdAt": 1234567890
    }
  ],
  "activePlatforms": {
    "opencode-desktop": {
      "name": "opencode-desktop",
      "lastActive": 1234567890
    },
    "freebuff-desktop": {
      "name": "freebuff-desktop",
      "lastActive": 1234567880
    }
  }
}
```

### How to Use

```typescript
// Acquire lock on file before editing
const state = await acquireFileLock(
  cwd,                                          // project root
  "opencode-desktop",                          // your agent ID
  "src/components/Button.tsx",                 // file to edit
  "editing button styles"                      // reason
)

// Release lock when done
await releaseFileLock(cwd, "opencode-desktop", "src/components/Button.tsx")

// Check if another agent has the file locked
const lockInfo = checkFileLock(cwd, "src/components/Button.tsx")
// => { isLocked: true, ownerAgentId: "freebuff-desktop", reason: "reviewing" }

// Assign a task
await assignTask(
  cwd,
  "opencode-desktop",
  "task-1726452000",
  "Implement user authentication",
  ["src/api/auth.ts", "src/pages/Login.tsx"]
)
```

---

## 🌐 Web vs Cloud: Comprehensive Differences

### Application Architecture

| Aspect | Web (Codebuff Web) | Cloud (Freebuff Cloud) |
|--------|-------------------|-----------------------|
| **Runtime** | Bun + React + OpenTUI (browser/Node) | Bun on Render.com server |
| **Entry Point** | `cli/src/entry.ts` → `app.tsx` | `freebuff/` package.json scripts |
| **Session Mgmt** | User-picked, poll loop in browser | Server-managed, auto-takeover |
| **Backend URL** | `NEXT_PUBLIC_CODEBUFF_APP_URL` (defaults: codebuff.com or localhost:3000) | Same URL, deployed to Render.com |
| **Real-time** | WebSocket to backend | WebSocket to `wss://codebuff-backend.onrender.com/ws` |

### Git Integration

| Aspect | Web | Cloud |
|--------|-----|-------|
| **Git Access** | Read-only inspection via `getGitChanges()` | Read + write (with `CODEBUFF_GITHUB_TOKEN`) |
| **Telemetry** | Git changes sent as compact snapshot to server | Same + server can initiate push/pull |
| **Private Repo** | Via `CODEBUFF_GITHUB_TOKEN` env var | Via `CODEBUFF_GITHUB_TOKEN` env var |
| **Bidirectional** | Not built-in (manual git ops) | Possible via SDK + coordination layer |

### Session Lifecycle

| Scenario | Web | Cloud |
|----------|-----|-------|
| **Start session** | User picks model in landing screen | Same, but server auto-takeover if prior instance dead |
| **Polling** | GET every ~30s while active | Same polling interval (30s default) |
| **End session** | User manually /end-session or session expires | Server grace period + instance ID tracking |
| **Multi-device** | Manual coordination needed | Server-backed state + coordination.json |
| **Takeover** | Ask before POSTing to rotate instance | Silently takeover if prior process dead |

### Cloudflare Detection

- **Both**: `common/src/constants/cf-worker-signals.ts` detects `cf-worker` + `cf-ray` headers
- **Never fires on**: Paid or BYOK (Bring Your Own Key) traffic
- **Modes**: `off | observe | block | ban`
- **Purpose**: Prevent subsidized free-mode capacity resale

### Best Practices

#### Web Best Practices
- Set `NEXT_PUBLIC_CODEBUFF_APP_URL` in `.env.local`
- Set `CODEBUFF_GITHUB_TOKEN` for private repo access
- Use `getGitChanges()` for context-aware agent operations
- Test with `bun run cloudflare-dev <project-root>`
- Coordination state in `.freebuff/coordination.json` for multi-device sync

#### Cloud Best Practices
- Set `CODEBUFF_GITHUB_TOKEN` at platform level
- Monitor `CODEBUFF_API_KEY` for rate limits
- Use custom domains via `NEXT_PUBLIC_CODEBUFF_APP_URL`
- Leverage Render.com deployment with proper env vars
- Use 30s polling interval for real-time state

---

## 🧪 Cloudflare Dev Pages Integration

### Script: `cli/scripts/cloudflare-dev.ts`

### Usage

```bash
# From your freebuff project directory:
bun run cloudflare-dev

# Or with custom options:
bun run cloudflare-dev /path/to/project --url https://custom-domain.com
```

### What It Does

1. **Auto-detects** project root (looks for `.git` directory)
2. **Checks** if Wrangler (Cloudflare CLI) is installed
3. **Spawns** `wrangler dev --port <port> --site <project-root>`
4. **Outputs** dev URL (e.g., `https://freebuff-dev<project-name>.pages.dev`)
5. **Handles** Ctrl+C/SIGTERM for graceful shutdown
6. **Configurable**: port, subdomain, custom URL

### Requirements

- Wrangler installed: `npm i -g wrangler@latest`
- Cloudflare account with Workers Pages configured
- Local git project (has `.git` directory)

### Use Cases

- Test agentic changes before committing to repo
- Share temporary URL with teammates for review
- Debug Cloudflare-related issues in agent workflows
- Prototype changes without deploying to production

---

## 📋 Quick Reference Commands

### Git Sync (from SDK)

```bash
# Push changes to GitHub
bun run codebull gitPushChanges \
  --commitMessage "your message" \
  --changedFiles "file1.ts,file2.ts"

# Pull latest from GitHub
bun run codebull gitPullChanges()

# Create branch
bun run codebull gitCreateBranch --branchName "new-feature"

# Apply patch
bun run codebull gitApplyPatch --patchContent "$(cat mypatch.diff)"
```

### Agent Coordination

```bash
# Acquire file lock
bun run codebull acquireFileLock \
  --filePath "src/components/Button.tsx" \
  --reason "editing"

# Release file lock
bun run codebull releaseFileLock \
  --filePath "src/components/Button.tsx"

# Check file lock status
bun run codebull checkFileLock \
  --filePath "src/components/Button.tsx"

# Assign task
bun run codebull assignTask \
  --taskId "task-1" \
  --description "Implement feature X" \
  --relatedFiles "src/feature-x.ts"

# Create change proposal
bun run codebull createChangeProposal \
  --description "Refactor module Y" \
  --targetFiles "src/module-y.ts" \
  --patchContent "$(cat patch.diff)"
```

### Cloudflare Dev

```bash
# Start dev server
bun run cloudflare-dev

# With custom port/subdomain
bun run cloudflare-dev --port 3000 --subdomain myproject

# With custom URL
bun run cloudflare-dev --url https://my-site.pages.dev
```

---

## 🚨 Important Notes

### What NOT to Do

- ❌ **Don't push to upstream** `CodebuffAI/freebuff` - use your fork `ksl-testing/freebuff`
- ❌ **Don't assume** git sync is automatic - functions are opt-in
- ❌ **Don't skip** `CODEBUFF_GITHUB_TOKEN` setup if you want private repo push/pull
- ❌ **Don't run** multiple agents on same files without coordination layer

### What TO Do

- ✅ **Set** `CODEBUFF_GITHUB_TOKEN` in your environment for GitHub access
- ✅ **Use** `.freebuff/coordination.json` when running opencode + freebuff desktop together
- ✅ **Test** changes with `bun run cloudflare-dev` before syncing
- ✅ **Push** your learnings/extensions to your fork, not upstream
- ✅ **Keep** git operations opt-in - existing code completely unaffected

### Ecosystem Lock-in Prevention

- All git functions use **standard git + GitHub API**
- `CODEBUFF_GITHUB_TOKEN` is just a **GitHub PAT** - replaceable
- Coordination types are **pure Zod schemas** - framework-agnostic
- Cloudflare script is **standalone** - no Codebuff dependency
- All changes in **your fork** - not upstream repo

---

*Last updated: 2026-09-15
*Conversation source: AI assistant discussion on freebuff suite bidirectional sync, agent coordination, and web vs cloud differences*