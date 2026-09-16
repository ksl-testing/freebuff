import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod/v4'

/**
 * Represents the ownership/lock status of a file in the coordination system.
 * Tracks which agent currently has exclusive write access to a file,
 * or if the file is available for concurrent modification.
 */
export type FileLockStatus = 'available' | 'locked-by-agent' | 'locked-by-system'

/** Zod schema for FileLock - used for serialization/deserialization */
const fileLockSchema = z.object({
  filePath: z.string(),
  ownerAgentId: z.string(),
  lockedAt: z.number(),
  expiresAt: z.number(),
  reason: z.string(),
})

/** Inferred TypeScript type from the Zod schema */
export type FileLock = z.infer<typeof fileLockSchema>

/**
 * Represents an active task being worked on by an agent.
 * Used for divide-and-conquer orchestration across agent platforms.
 */
export type TaskStatus = 'pending' | 'in-progress' | 'completed' | 'failed' | 'cancelled'

/** Zod schema for ActiveTask */
const activeTaskSchema = z.object({
  taskId: z.string(),
  agentId: z.string(),
  description: z.string(),
  relatedFiles: z.array(z.string()),
  status: z.enum(['pending', 'in-progress', 'completed', 'failed', 'cancelled']),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  progress: z.number().min(0).max(100),
  notes: z.string().optional(),
})

/** Inferred TypeScript type from the Zod schema */
export type ActiveTask = z.infer<typeof activeTaskSchema>

/**
 * Represents a change proposal between agent platforms.
 * One agent proposes changes, another reviews and approves/rejects.
 */
export type ChangeProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied'

/** Zod schema for ChangeProposal */
const changeProposalSchema = z.object({
  proposalId: z.string(),
  proposerAgentId: z.string(),
  description: z.string(),
  targetFiles: z.array(z.string()),
  patchContent: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'applied']),
  createdAt: z.number(),
  reviewedAt: z.number().optional(),
  reviewedBy: z.string().optional(),
  reviewNotes: z.string().optional(),
})

/** Inferred TypeScript type from the Zod schema */
export type ChangeProposal = z.infer<typeof changeProposalSchema>

/**
 * Overall coordination state shared between agent platforms (opencode desktop,
 * freebuff desktop). Stored in `.freebuff/coordination.json` at the project root.
 *
 * This enables divide-and-conquer work assignment and prevents agents from
 * stepping on each other's toes when multiple platforms analyze the same project.
 */
export const coordinationSchema = z.object({
  version: z.string().default('1.0.0'),
  lastSync: z.number().default(Date.now()),

  /** Per-file lock tracking */
  fileLocks: z.record(z.string(), fileLockSchema).default({}),

  /** Active tasks assigned across agents */
  activeTasks: z.array(activeTaskSchema).default([]),

  /** Change proposals pending review */
  changeProposals: z.array(changeProposalSchema).default([]),

  /** Which agent platforms are currently active */
  activePlatforms: z.record(z.string(), z.object({
    name: z.string(),
    version: z.string().optional(),
    lastActive: z.number(),
    currentTaskId: z.string().optional(),
  })).default({}),

  /** Project-level metadata */
  projectId: z.string().optional().default(''),
  rootPath: z.string().optional().default(''),
})

export type CoordinationState = z.infer<typeof coordinationSchema>

export const defaultCoordinationState: CoordinationState = {
  version: '1.0.0',
  lastSync: Date.now(),
  fileLocks: {},
  activeTasks: [],
  changeProposals: [],
  activePlatforms: {},
  projectId: '',
  rootPath: '',
}

/**
 * Reads the coordination file from disk.
 */
function readCoordinationState(cwd: string): CoordinationState {
  const coordinationFile = path.join(cwd, '.freebuff', 'coordination.json')
  try {
    const existing = fs.readFileSync(coordinationFile, 'utf8')
    return coordinationSchema.parse(JSON.parse(existing))
  } catch {
    return { ...defaultCoordinationState, rootPath: cwd }
  }
}

/**
 * Writes the coordination state to disk.
 */
function writeCoordinationState(cwd: string, state: CoordinationState): void {
  const coordinationFile = path.join(cwd, '.freebuff', 'coordination.json')
  fs.writeFileSync(coordinationFile, JSON.stringify(state, null, 2))
}

/**
 * Acquires a file lock for the specified agent.
 * Returns the updated coordination state, or throws if the lock cannot be acquired
 * (e.g., file is already locked by another agent and cannot be preempted).
 *
 * @param cwd - Project root directory
 * @param agentId - ID of the agent requesting the lock
 * @param filePath - Path of the file to lock (relative to project root)
 * @param reason - Reason for the lock (e.g., 'editing', 'reviewing')
 * @param ttlMs - Time-to-live in milliseconds before the lock auto-expires (default: 5 minutes)
 * @returns Updated coordination state
 */
export async function acquireFileLock(
  cwd: string,
  agentId: string,
  filePath: string,
  reason: string,
  ttlMs = 300_000, // 5 minutes default
): Promise<CoordinationState> {
  let state = readCoordinationState(cwd)

  // Ensure fileLocks is initialized (should never be undefined due to schema default,
  // but defensive check)
  if (!state.fileLocks) {
    state.fileLocks = {}
  }

  // Check if file is already locked by another agent
  const existingLock = state.fileLocks[filePath]
  if (existingLock && existingLock.ownerAgentId !== agentId) {
    // Check if lock has expired
    if (existingLock.expiresAt > Date.now()) {
      throw new Error(
        `File ${filePath} is locked by agent ${existingLock.ownerAgentId}. ` +
          `Lock expires at ${new Date(existingLock.expiresAt).toISOString()}.`,
      )
    }
    // Lock expired, remove it
    delete state.fileLocks[filePath]
  }

  // Acquire the lock
  state.fileLocks = {
    ...state.fileLocks,
    [filePath]: {
      filePath,
      ownerAgentId: agentId,
      lockedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      reason,
    },
  }
  state.lastSync = Date.now()

  // Write updated state
  writeCoordinationState(cwd, state)

  return state
}

/**
 * Releases a file lock for the specified agent.
 *
 * @param cwd - Project root directory
 * @param agentId - ID of the agent releasing the lock
 * @param filePath - Path of the file to unlock (relative to project root)
 * @returns Updated coordination state
 */
export async function releaseFileLock(
  cwd: string,
  agentId: string,
  filePath: string,
): Promise<CoordinationState> {
  let state = readCoordinationState(cwd)

  // Remove the lock if it matches the agent
  if (state.fileLocks[filePath]?.ownerAgentId === agentId) {
    delete state.fileLocks[filePath]
    state.lastSync = Date.now()
    writeCoordinationState(cwd, state)
  }

  return state
}

/**
 * Checks if a file is currently locked and by which agent.
 *
 * @param cwd - Project root directory
 * @param filePath - Path of the file to check (relative to project root)
 * @returns { isLocked, ownerAgentId, reason } or null if not locked
 */
export function checkFileLock(cwd: string, filePath: string): {
  isLocked: boolean
  ownerAgentId?: string
  reason?: string
} | null {
  try {
    const state = readCoordinationState(cwd)

    // fileLocks is guaranteed to exist by schema default, but defensive check
    if (!state.fileLocks) return null

    const lock = state.fileLocks[filePath]
    if (!lock) return null

    // Check if lock has expired
    if (lock.expiresAt > Date.now()) {
      return {
        isLocked: true,
        ownerAgentId: lock.ownerAgentId,
        reason: lock.reason,
      }
    }

    // Lock expired, remove it (best-effort - don't write to avoid race conditions)
    return null
  } catch {
    return null
  }
}

/**
 * Assigns a task to an agent platform.
 * If the task is already assigned to another agent, updates the assignment.
 *
 * @param cwd - Project root directory
 * @param agentId - ID of the agent requesting the task
 * @param taskId - Unique task identifier
 * @param description - Human-readable task description
 * @param relatedFiles - List of file paths related to this task
 * @returns Updated coordination state
 */
export async function assignTask(
  cwd: string,
  agentId: string,
  taskId: string,
  description: string,
  relatedFiles: string[],
): Promise<CoordinationState> {
  let state = readCoordinationState(cwd)

  // activeTasks is guaranteed to exist by schema default
  if (!state.activeTasks) {
    state.activeTasks = []
  }

  // Check if task is already assigned to another agent
  const existingTask = state.activeTasks.find((t) => t.taskId === taskId)
  if (existingTask && existingTask.agentId !== agentId) {
    // Task is already assigned to another agent - update the assignment
    state.activeTasks = state.activeTasks.filter((t) => t.taskId !== taskId)
  }

  // Add/update the task
  state.activeTasks = [
    ...state.activeTasks.filter((t) => t.taskId !== taskId),
    {
      taskId,
      agentId,
      description,
      relatedFiles,
      status: 'pending',
      startedAt: Date.now(),
      progress: 0,
    },
  ]
  state.lastSync = Date.now()

  // Update active platforms tracking
  state.activePlatforms = {
    ...state.activePlatforms,
    [agentId]: {
      name: agentId,
      lastActive: Date.now(),
    },
  }

  writeCoordinationState(cwd, state)

  return state
}

/**
 * Updates the status of a task.
 *
 * @param cwd - Project root directory
 * @param taskId - Task identifier
 * @param status - New status ('pending', 'in-progress', 'completed', 'failed', 'cancelled')
 * @param notes - Optional notes about the status change
 * @returns Updated coordination state
 */
export async function updateTaskStatus(
  cwd: string,
  taskId: string,
  status: TaskStatus,
  notes?: string,
): Promise<CoordinationState> {
  let state = readCoordinationState(cwd)

  if (!state.activeTasks) {
    state.activeTasks = []
  }

  const task = state.activeTasks.find((t) => t.taskId === taskId)
  if (!task) return state

  task.status = status
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    task.completedAt = Date.now()
  }
  if (notes) task.notes = notes

  state.lastSync = Date.now()
  writeCoordinationState(cwd, state)

  return state
}

/**
 * Creates a change proposal from one agent to another.
 * The receiving agent can review and approve/reject the proposal.
 *
 * @param cwd - Project root directory
 * @param proposerAgentId - ID of the agent proposing the changes
 * @param description - Description of the changes
 * @param targetFiles - List of files the patch affects
 * @param patchContent - The git diff/patch content
 * @returns Created change proposal
 */
export async function createChangeProposal(
  cwd: string,
  proposerAgentId: string,
  description: string,
  targetFiles: string[],
  patchContent: string,
): Promise<ChangeProposal> {
  let state = readCoordinationState(cwd)

  // changeProposals is guaranteed to exist by schema default
  if (!state.changeProposals) {
    state.changeProposals = []
  }

  const proposalId = `prop-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

  const proposal: ChangeProposal = {
    proposalId,
    proposerAgentId,
    description,
    targetFiles,
    patchContent,
    status: 'pending',
    createdAt: Date.now(),
  }

  state.changeProposals = [
    ...state.changeProposals,
    proposal,
  ]
  state.lastSync = Date.now()

  writeCoordinationState(cwd, state)

  return proposal
}

/**
 * Reviews a change proposal (approve or reject).
 *
 * @param cwd - Project root directory
 * @param proposalId - Proposal to review
 * @param reviewerAgentId - ID of the agent reviewing
 * @param approved - Whether to approve or reject
 * @param notes - Review notes
 * @returns Updated coordination state
 */
export async function reviewChangeProposal(
  cwd: string,
  proposalId: string,
  reviewerAgentId: string,
  approved: boolean,
  notes?: string,
): Promise<CoordinationState> {
  let state = readCoordinationState(cwd)

  if (!state.changeProposals) {
    state.changeProposals = []
  }

  const proposal = state.changeProposals.find((p) => p.proposalId === proposalId)
  if (!proposal) return state

  proposal.status = approved ? 'approved' : 'rejected'
  proposal.reviewedAt = Date.now()
  proposal.reviewedBy = reviewerAgentId
  if (notes) proposal.reviewNotes = notes

  if (approved) {
    proposal.status = 'applied'
    // TODO: Apply the patch to the repository
  }

  state.lastSync = Date.now()
  writeCoordinationState(cwd, state)

  return state
}