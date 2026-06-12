#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  Tool,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

// Define scrum board file path using environment variable with fallback
const defaultBoardPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "scrum-board.json",
);

// If SCRUM_BOARD_PATH is just a filename, put it in the same directory as the script
const SCRUM_BOARD_PATH = process.env.SCRUM_BOARD_PATH
  ? path.isAbsolute(process.env.SCRUM_BOARD_PATH)
    ? process.env.SCRUM_BOARD_PATH
    : path.join(path.dirname(fileURLToPath(import.meta.url)), process.env.SCRUM_BOARD_PATH)
  : defaultBoardPath;

// A task in "doing" is considered stale once its owner has posted this many
// standups without the task changing.
const STALE_STANDUP_COUNT = 3;

/* State shape */

const SIGNALS = [
  "blocked",
  "confused",
  "frustrated",
  "praise",
  "handoff",
  "help_wanted",
  "fyi",
  "done",
] as const;
type Signal = (typeof SIGNALS)[number];

const SIGNALS_REQUIRING_NEEDS: readonly Signal[] = ["blocked", "confused", "help_wanted", "handoff"];

const TASK_STATUSES = ["todo", "doing", "review", "done"] as const;
type TaskStatus = (typeof TASK_STATUSES)[number];

interface AgentRecord {
  name: string;
  lastSeen: string;
}

interface Task {
  id: string;
  title: string;
  detail?: string;
  status: TaskStatus;
  owner?: string;
  blockers: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface Message {
  id: string;
  from: string;
  signal: Signal;
  taskId?: string;
  body: string;
  needs?: string;
  mentions: string[];
  at: string;
  readBy: string[];
}

interface StandupEntry {
  agent: string;
  did: string;
  doing: string;
  blockers: string[];
  at: string;
}

interface Sprint {
  goal: string | null;
  goalSetAt: string | null;
}

interface BoardState {
  agents: AgentRecord[];
  tasks: Task[];
  messages: Message[];
  standups: StandupEntry[];
  sprint: Sprint;
}

const EMPTY_STATE: BoardState = {
  agents: [],
  tasks: [],
  messages: [],
  standups: [],
  sprint: { goal: null, goalSetAt: null },
};

/* Tool input schemas */

const AgentField = z
  .string()
  .min(1)
  .describe("Your agent name. Use the same name on every call so messages and tasks stay attributed to you.");

const PostMessageSchema = z.object({
  agent: AgentField,
  signal: z
    .enum(SIGNALS)
    .describe(
      "What kind of message this is: 'blocked' (you cannot proceed), 'confused' (requirements or context unclear), " +
        "'frustrated' (something is repeatedly painful — flag it for the retrospective), 'praise' (call out good work), " +
        "'handoff' (you are passing work to another agent), 'help_wanted' (you could use assistance but are not blocked), " +
        "'fyi' (broadcast information), 'done' (announce completed work).",
    ),
  task_id: z.string().optional().describe("The task this message relates to, if any (e.g. 'T3')."),
  body: z
    .string()
    .min(1)
    .describe(
      "The message, written to be fully self-contained: the reader gets NO other context and cannot ask follow-up questions. " +
        "Include what you were doing, what happened, exact error text, and relevant file paths, commands, or IDs. " +
        "A reader should be able to act on this message alone.",
    ),
  needs: z
    .string()
    .optional()
    .describe(
      "The specific, concrete action or information that would resolve this message. " +
        "REQUIRED when signal is 'blocked', 'confused', 'help_wanted', or 'handoff'. " +
        "Phrase it so the reader can act immediately without asking anything back " +
        "(e.g. 'confirm whether export format should be WAV or FLAC' rather than 'need input').",
    ),
  mentions: z
    .array(z.string())
    .optional()
    .describe(
      "Agent names this message is addressed to. Leave empty to broadcast to every agent. " +
        "Mentioned agents see the message in their inbox digest on their next tool call.",
    ),
});

const CheckInboxSchema = z.object({
  agent: AgentField,
});

const StandupSchema = z.object({
  agent: AgentField,
  did: z.string().min(1).describe("What you completed since your last standup. Be specific: task IDs, files, outcomes."),
  doing: z.string().min(1).describe("What you are working on next, with task IDs where applicable."),
  blockers: z
    .array(z.string())
    .default([])
    .describe(
      "Anything blocking you, each entry self-contained (what is blocked, why, and what would unblock it). Use [] if nothing.",
    ),
});

const ManageTaskSchema = z.object({
  agent: AgentField,
  action: z
    .enum(["create", "claim", "update", "block", "unblock", "complete"])
    .describe(
      "'create' a task, 'claim' an unowned task for yourself, 'update' its status, " +
        "'block' it (provide the blocker in 'detail'), 'unblock' it (clears blockers), or 'complete' it.",
    ),
  task_id: z.string().optional().describe("The task to act on (e.g. 'T3'). Required for every action except 'create'."),
  title: z.string().optional().describe("Task title. Required for 'create'. Keep it a single, concrete deliverable."),
  detail: z
    .string()
    .optional()
    .describe(
      "For 'create'/'update': self-contained task context (acceptance criteria, relevant files). " +
        "For 'block': the blocker description and what would resolve it. REQUIRED for 'block'.",
    ),
  status: z
    .enum(TASK_STATUSES)
    .optional()
    .describe("New status. Required for 'update'; ignored for other actions."),
});

const GetBoardSchema = z.object({
  agent: AgentField,
});

/* The ScrumBoardManager contains all operations to interact with the shared board */

class ScrumBoardManager {
  // Serialize all read-modify-write cycles so concurrent tool calls cannot lose updates.
  private lock: Promise<unknown> = Promise.resolve();
  private tempCounter = 0;

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.lock.then(fn, fn);
    this.lock = result.catch(() => undefined);
    return result;
  }

  private async loadState(): Promise<BoardState> {
    try {
      const data = await fs.readFile(SCRUM_BOARD_PATH, "utf-8");
      return { ...EMPTY_STATE, ...(JSON.parse(data) as BoardState) };
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return structuredClone(EMPTY_STATE);
      }
      throw error;
    }
  }

  private async saveState(state: BoardState): Promise<void> {
    // Atomic write: write to a temp file in the same directory, then rename over the target.
    const tempPath = `${SCRUM_BOARD_PATH}.${process.pid}.${++this.tempCounter}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2));
    await fs.rename(tempPath, SCRUM_BOARD_PATH);
  }

  private touchAgent(state: BoardState, name: string): void {
    const existing = state.agents.find((a) => a.name === name);
    const now = new Date().toISOString();
    if (existing) {
      existing.lastSeen = now;
    } else {
      state.agents.push({ name, lastSeen: now });
    }
  }

  private nextId(items: { id: string }[], prefix: string): string {
    const max = items.reduce((acc, item) => {
      const n = Number(item.id.slice(prefix.length));
      return Number.isFinite(n) && n > acc ? n : acc;
    }, 0);
    return `${prefix}${max + 1}`;
  }

  private findTask(state: BoardState, taskId: string): Task {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) {
      const known = state.tasks.map((t) => t.id).join(", ") || "none";
      throw new Error(`Task ${taskId} not found. Known tasks: ${known}`);
    }
    return task;
  }

  /* Rendering helpers — every line is dense and self-contained */

  private renderTaskLine(task: Task): string {
    const owner = task.owner ? ` @${task.owner}` : " (unowned)";
    const blockers = task.blockers.length > 0 ? ` | BLOCKED: ${task.blockers.join("; ")}` : "";
    const detail = task.detail ? ` — ${task.detail}` : "";
    return `${task.id} [${task.status}]${owner} ${task.title}${detail}${blockers}`;
  }

  private renderMessageLine(state: BoardState, message: Message): string {
    const task = message.taskId ? state.tasks.find((t) => t.id === message.taskId) : undefined;
    const re = task ? ` re ${task.id} "${task.title}"` : message.taskId ? ` re ${message.taskId}` : "";
    const needs = message.needs ? ` | needs: ${message.needs}` : "";
    return `[${message.signal}] from ${message.from}${re}: ${message.body}${needs}`;
  }

  private unreadFor(state: BoardState, agent: string): Message[] {
    return state.messages.filter(
      (m) =>
        m.from !== agent &&
        !m.readBy.includes(agent) &&
        (m.mentions.length === 0 || m.mentions.includes(agent)),
    );
  }

  private boardSummaryLine(state: BoardState): string {
    const counts = TASK_STATUSES.map(
      (status) => `${state.tasks.filter((t) => t.status === status).length} ${status}`,
    ).join(" / ");
    const blocked = state.tasks.filter((t) => t.status !== "done" && t.blockers.length > 0);
    const blockedNote =
      blocked.length > 0 ? ` | open blockers: ${blocked.map((t) => t.id).join(", ")}` : " | open blockers: none";
    const goal = state.sprint.goal ? ` | sprint goal: ${state.sprint.goal}` : "";
    return `Board: ${counts}${blockedNote}${goal}`;
  }

  // Render (and mark read) the caller's unread inbox. Delivery counts as read:
  // the digest contains the full content of every message, so no second look is needed.
  private inboxDigest(state: BoardState, agent: string): string {
    const unread = this.unreadFor(state, agent);
    if (unread.length === 0) {
      return "Inbox: no unread messages.";
    }
    const sections: string[] = [];
    for (const signal of SIGNALS) {
      const group = unread.filter((m) => m.signal === signal);
      if (group.length > 0) {
        sections.push(group.map((m) => this.renderMessageLine(state, m)).join("\n"));
      }
    }
    for (const message of unread) {
      message.readBy.push(agent);
    }
    return `Inbox (${unread.length} unread, now marked read):\n${sections.join("\n")}`;
  }

  private staleTasks(state: BoardState): Task[] {
    return state.tasks.filter((task) => {
      if (task.status !== "doing" || !task.owner) return false;
      const standupsSinceUpdate = state.standups.filter(
        (s) => s.agent === task.owner && s.at > task.updatedAt,
      ).length;
      return standupsSinceUpdate >= STALE_STANDUP_COUNT;
    });
  }

  private standupDigest(state: BoardState): string {
    const lines: string[] = ["Team standup digest:"];
    const latestByAgent = new Map<string, StandupEntry>();
    for (const entry of state.standups) {
      latestByAgent.set(entry.agent, entry); // entries are appended chronologically
    }
    if (latestByAgent.size === 0) {
      lines.push("- no standups posted yet");
    }
    for (const entry of latestByAgent.values()) {
      const blockers = entry.blockers.length > 0 ? ` | blockers: ${entry.blockers.join("; ")}` : "";
      lines.push(`- ${entry.agent} (${entry.at}): did: ${entry.did} | doing: ${entry.doing}${blockers}`);
    }

    const openBlockers: string[] = [];
    for (const task of state.tasks.filter((t) => t.status !== "done" && t.blockers.length > 0)) {
      openBlockers.push(this.renderTaskLine(task));
    }
    for (const entry of latestByAgent.values()) {
      for (const blocker of entry.blockers) {
        openBlockers.push(`${entry.agent}: ${blocker}`);
      }
    }
    lines.push(
      openBlockers.length > 0 ? `Open blockers:\n${openBlockers.join("\n")}` : "Open blockers: none",
    );

    const stale = this.staleTasks(state);
    if (stale.length > 0) {
      lines.push(
        `Stale tasks (in 'doing' for ${STALE_STANDUP_COUNT}+ standups without change — consider unblock/handoff):\n` +
          stale.map((t) => this.renderTaskLine(t)).join("\n"),
      );
    }
    return lines.join("\n");
  }

  /* Tool operations */

  postMessage(input: z.infer<typeof PostMessageSchema>): Promise<string> {
    if (SIGNALS_REQUIRING_NEEDS.includes(input.signal) && !input.needs?.trim()) {
      throw new Error(
        `Signal '${input.signal}' requires 'needs': state the specific action or information that would resolve this, ` +
          "so the reader can act without asking anything back.",
      );
    }
    return this.withLock(() => this.postMessageLocked(input));
  }

  private async postMessageLocked(input: z.infer<typeof PostMessageSchema>): Promise<string> {
    const state = await this.loadState();
    this.touchAgent(state, input.agent);
    if (input.task_id) {
      this.findTask(state, input.task_id); // validate the reference
    }
    const message: Message = {
      id: this.nextId(state.messages, "M"),
      from: input.agent,
      signal: input.signal,
      taskId: input.task_id,
      body: input.body,
      needs: input.needs,
      mentions: input.mentions ?? [],
      at: new Date().toISOString(),
      readBy: [],
    };
    state.messages.push(message);

    // A 'blocked' signal tied to a task also records the blocker on the task itself,
    // so the board and the unblock prompt see it without a second report.
    if (input.signal === "blocked" && input.task_id) {
      const task = this.findTask(state, input.task_id);
      task.blockers.push(`${message.id}: ${input.body} | needs: ${input.needs}`);
      task.updatedAt = message.at;
    }

    const digest = this.inboxDigest(state, input.agent);
    await this.saveState(state);
    const audience = message.mentions.length > 0 ? message.mentions.map((m) => `@${m}`).join(", ") : "all agents";
    return [
      `Posted ${message.id} [${message.signal}] to ${audience}. They will see it on their next tool call — no follow-up needed.`,
      digest,
      this.boardSummaryLine(state),
    ].join("\n\n");
  }

  checkInbox(input: z.infer<typeof CheckInboxSchema>): Promise<string> {
    return this.withLock(() => this.checkInboxLocked(input));
  }

  private async checkInboxLocked(input: z.infer<typeof CheckInboxSchema>): Promise<string> {
    const state = await this.loadState();
    this.touchAgent(state, input.agent);
    const digest = this.inboxDigest(state, input.agent);
    await this.saveState(state);
    return [digest, this.boardSummaryLine(state)].join("\n\n");
  }

  standup(input: z.infer<typeof StandupSchema>): Promise<string> {
    return this.withLock(() => this.standupLocked(input));
  }

  private async standupLocked(input: z.infer<typeof StandupSchema>): Promise<string> {
    const state = await this.loadState();
    this.touchAgent(state, input.agent);
    state.standups.push({
      agent: input.agent,
      did: input.did,
      doing: input.doing,
      blockers: input.blockers,
      at: new Date().toISOString(),
    });
    const digest = this.standupDigest(state);
    const inbox = this.inboxDigest(state, input.agent);
    await this.saveState(state);
    return [`Standup recorded for ${input.agent}.`, digest, inbox, this.boardSummaryLine(state)].join("\n\n");
  }

  manageTask(input: z.infer<typeof ManageTaskSchema>): Promise<string> {
    return this.withLock(() => this.manageTaskLocked(input));
  }

  private async manageTaskLocked(input: z.infer<typeof ManageTaskSchema>): Promise<string> {
    const state = await this.loadState();
    this.touchAgent(state, input.agent);
    const now = new Date().toISOString();
    let task: Task;

    if (input.action === "create") {
      if (!input.title?.trim()) {
        throw new Error("Action 'create' requires 'title'.");
      }
      task = {
        id: this.nextId(state.tasks, "T"),
        title: input.title,
        detail: input.detail,
        status: "todo",
        blockers: [],
        createdBy: input.agent,
        createdAt: now,
        updatedAt: now,
      };
      state.tasks.push(task);
    } else {
      if (!input.task_id) {
        throw new Error(`Action '${input.action}' requires 'task_id'.`);
      }
      task = this.findTask(state, input.task_id);
      switch (input.action) {
        case "claim":
          if (task.owner && task.owner !== input.agent) {
            throw new Error(
              `Task ${task.id} is owned by ${task.owner}. Ask for a handoff via post_message (signal 'handoff') instead.`,
            );
          }
          task.owner = input.agent;
          if (task.status === "todo") {
            task.status = "doing";
          }
          break;
        case "update":
          if (!input.status) {
            throw new Error("Action 'update' requires 'status'.");
          }
          task.status = input.status;
          if (input.detail) {
            task.detail = input.detail;
          }
          break;
        case "block":
          if (!input.detail?.trim()) {
            throw new Error(
              "Action 'block' requires 'detail': describe the blocker and what would resolve it, self-contained.",
            );
          }
          task.blockers.push(`${input.detail} (reported by ${input.agent})`);
          break;
        case "unblock":
          task.blockers = [];
          break;
        case "complete":
          task.status = "done";
          task.blockers = [];
          break;
      }
      task.updatedAt = now;
    }

    const inbox = this.inboxDigest(state, input.agent);
    await this.saveState(state);
    return [
      `${input.action} OK: ${this.renderTaskLine(task)}`,
      this.boardSummaryLine(state),
      inbox,
    ].join("\n\n");
  }

  getBoard(input: z.infer<typeof GetBoardSchema>): Promise<string> {
    return this.withLock(async () => {
      const state = await this.loadState();
      this.touchAgent(state, input.agent);
      await this.saveState(state);
      return this.renderBoard(state);
    });
  }

  renderBoard(state: BoardState): string {
    const lines: string[] = [];
    lines.push(`Sprint goal: ${state.sprint.goal ?? "(not set — use the sprint-planning prompt)"}`);
    for (const status of TASK_STATUSES) {
      const tasks = state.tasks.filter((t) => t.status === status);
      lines.push(`\n${status.toUpperCase()} (${tasks.length}):`);
      lines.push(tasks.length > 0 ? tasks.map((t) => this.renderTaskLine(t)).join("\n") : "(empty)");
    }
    const unreadCounts = state.agents
      .map((a) => `${a.name}: ${this.unreadFor(state, a.name).length}`)
      .join(", ");
    lines.push(`\nUnread messages per agent: ${unreadCounts || "no agents registered yet"}`);
    return lines.join("\n");
  }

  /* Prompt renderers — every ceremony is a data transform over live state */

  renderSprintPlanning(goal: string): Promise<string> {
    return this.withLock(() => this.renderSprintPlanningLocked(goal));
  }

  private async renderSprintPlanningLocked(goal: string): Promise<string> {
    const state = await this.loadState();
    state.sprint = { goal, goalSetAt: new Date().toISOString() };
    await this.saveState(state);
    const backlog = state.tasks.filter((t) => t.status !== "done");
    const agents = state.agents.map((a) => a.name).join(", ") || "none registered yet";
    return [
      `You are running sprint planning. The sprint goal has been recorded on the board: "${goal}"`,
      `Known agents: ${agents}`,
      `Current backlog (non-done tasks):\n${
        backlog.length > 0 ? backlog.map((t) => this.renderTaskLine(t)).join("\n") : "(empty)"
      }`,
      "Plan the sprint now:",
      "1. Slice the goal into small, independent tasks — each a single concrete deliverable an agent can finish without waiting on another task. Create each with manage_task (action 'create'), putting acceptance criteria and relevant file paths in 'detail' so the task is self-contained.",
      "2. For each task, notify its intended owner with post_message (signal 'fyi', mentions: [owner], task_id set) explaining why they are the right owner. Owners pull work by calling manage_task (action 'claim').",
      "3. Drop backlog items that do not serve the goal: mark them with manage_task (action 'update', status 'todo') and a 'detail' note saying they are out of this sprint.",
      "Do all of this through tool calls — no other coordination is needed; every agent sees the result on their next call.",
    ].join("\n\n");
  }

  async renderDailyStandup(): Promise<string> {
    const state = await this.withLock(() => this.loadState());
    return [
      "You are participating in the daily standup. Here is the live team status:",
      this.standupDigest(state),
      this.boardSummaryLine(state),
      "Now post your own standup with the standup tool (did / doing / blockers). " +
        "Write each field self-contained with task IDs. The response will contain the refreshed team digest, " +
        "so this single call both gives and receives the whole ceremony.",
    ].join("\n\n");
  }

  async renderRetrospective(): Promise<string> {
    const state = await this.withLock(() => this.loadState());
    const completed = state.tasks.filter((t) => t.status === "done");
    const blockedHistory = state.tasks.filter((t) => t.blockers.length > 0 || t.status !== "done");
    const moodSignals = state.messages.filter((m) => m.signal === "frustrated" || m.signal === "praise");
    return [
      "You are running the retrospective. Here is the sprint history:",
      `Sprint goal: ${state.sprint.goal ?? "(none set)"}`,
      `Completed tasks (${completed.length}):\n${
        completed.length > 0 ? completed.map((t) => this.renderTaskLine(t)).join("\n") : "(none)"
      }`,
      `Incomplete or blocked tasks (${blockedHistory.length}):\n${
        blockedHistory.length > 0 ? blockedHistory.map((t) => this.renderTaskLine(t)).join("\n") : "(none)"
      }`,
      `Frustration and praise signals (${moodSignals.length}):\n${
        moodSignals.length > 0 ? moodSignals.map((m) => this.renderMessageLine(state, m)).join("\n") : "(none)"
      }`,
      "Produce a structured retrospective with three sections: what went well (cite praise signals and completed tasks), " +
        "what didn't (cite frustration signals and blocked/stale tasks), and action items. " +
        "Record each action item as a task via manage_task (action 'create') so it cannot be forgotten, " +
        "and post the summary with post_message (signal 'fyi', no mentions) so every agent receives it.",
    ].join("\n\n");
  }

  async renderUnblock(taskId: string): Promise<string> {
    const state = await this.withLock(() => this.loadState());
    const task = this.findTask(state, taskId);
    const related = state.messages.filter((m) => m.taskId === taskId);
    return [
      `You are triaging a blocked task. Everything known about it is below — do not ask anyone for more context.`,
      `Task: ${this.renderTaskLine(task)}`,
      `Blocker chain:\n${task.blockers.length > 0 ? task.blockers.map((b) => `- ${b}`).join("\n") : "(no blockers recorded)"}`,
      `Every related message:\n${
        related.length > 0 ? related.map((m) => this.renderMessageLine(state, m)).join("\n") : "(none)"
      }`,
      "Make a triage decision now:",
      "- Resolve: if you can satisfy the 'needs' yourself, do it, then call manage_task (action 'unblock') and post_message (signal 'fyi', mentions: [owner]) stating exactly what you changed.",
      "- Reassign: if another agent is better placed, post_message (signal 'handoff', mentions: [that agent], task_id set, needs: what they must do).",
      "- Escalate to human: if resolution requires a decision or access no agent has, post_message (signal 'help_wanted', no mentions) stating precisely what decision or access is needed, then leave the task blocked.",
    ].join("\n\n");
  }

  async renderHandoff(taskId: string, toAgent: string): Promise<string> {
    const state = await this.withLock(() => this.loadState());
    const task = this.findTask(state, taskId);
    const related = state.messages.filter((m) => m.taskId === taskId);
    return [
      `Complete handoff brief for ${toAgent}. This contains everything needed — the previous owner will not be asked anything.`,
      `Task: ${this.renderTaskLine(task)}`,
      `Created by ${task.createdBy} at ${task.createdAt}; last updated ${task.updatedAt}.`,
      `Full message history for this task:\n${
        related.length > 0 ? related.map((m) => this.renderMessageLine(state, m)).join("\n") : "(none)"
      }`,
      this.boardSummaryLine(state),
      `${toAgent}: take over now by calling manage_task (action 'claim', task_id '${task.id}', agent '${toAgent}'). ` +
        "If anything in this brief is missing or contradictory, post_message (signal 'confused', needs: the exact missing fact) " +
        "rather than guessing — but prefer acting on the brief above.",
    ].join("\n\n");
  }

  async readState(): Promise<BoardState> {
    return this.withLock(() => this.loadState());
  }

  async renderLatestStandupDigest(): Promise<string> {
    const state = await this.withLock(() => this.loadState());
    return this.standupDigest(state);
  }
}

const boardManager = new ScrumBoardManager();

/* The server instance and tools/prompts/resources exposed to agents */

const server = new Server(
  {
    name: "scrum-master-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {},
    },
  },
);

const TOOLS: Tool[] = [
  {
    name: "post_message",
    description:
      "Send a self-contained message to other agents. Write the body so the reader needs no other context and " +
      "never has to ask a follow-up question. The response includes your own unread inbox digest, so you also " +
      "catch up on team messages with this same call.",
    inputSchema: zodToJsonSchema(PostMessageSchema) as ToolInput,
  },
  {
    name: "check_inbox",
    description:
      "Read all unread messages addressed to you, mentioning you, or broadcast to everyone — grouped by signal, " +
      "one dense line each, marked read on delivery. Also returns a one-line board summary. " +
      "Rarely needed: every other tool already piggybacks this digest.",
    inputSchema: zodToJsonSchema(CheckInboxSchema) as ToolInput,
  },
  {
    name: "standup",
    description:
      "Post your standup (did / doing / blockers) and receive the entire team's standup digest, all open blockers, " +
      "and stale tasks in the same response. One call performs the whole ceremony — never wait for or ask other " +
      "agents about their status.",
    inputSchema: zodToJsonSchema(StandupSchema) as ToolInput,
  },
  {
    name: "manage_task",
    description:
      "Create, claim, update, block, unblock, or complete a task on the sprint board. The response includes the " +
      "updated task, a board summary, and your unread inbox digest.",
    inputSchema: zodToJsonSchema(ManageTaskSchema) as ToolInput,
  },
  {
    name: "get_board",
    description:
      "Get the full sprint board: tasks by column with owners and blockers, the sprint goal, and unread message " +
      "counts per agent.",
    inputSchema: zodToJsonSchema(GetBoardSchema) as ToolInput,
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let text: string;
    switch (name) {
      case "post_message":
        text = await boardManager.postMessage(PostMessageSchema.parse(args));
        break;
      case "check_inbox":
        text = await boardManager.checkInbox(CheckInboxSchema.parse(args));
        break;
      case "standup":
        text = await boardManager.standup(StandupSchema.parse(args));
        break;
      case "manage_task":
        text = await boardManager.manageTask(ManageTaskSchema.parse(args));
        break;
      case "get_board":
        text = await boardManager.getBoard(GetBoardSchema.parse(args));
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text }] };
  } catch (error) {
    const message = error instanceof z.ZodError
      ? error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")
      : error instanceof Error
        ? error.message
        : String(error);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

/* Prompts — the prompt-based scrum master: rendered text embeds live board state */

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: "sprint-planning",
      description:
        "Run sprint planning: records the goal on the board and renders the current backlog with instructions to slice tasks and notify owners via manage_task.",
      arguments: [{ name: "goal", description: "The sprint goal to record on the board", required: true }],
    },
    {
      name: "daily-standup",
      description:
        "Run the daily standup: renders the live team standup digest and open blockers, then instructs you to post your own via the standup tool.",
    },
    {
      name: "retrospective",
      description:
        "Run the retrospective: renders completed/blocked task history and frustration/praise signals, prompting a structured what-went-well / what-didn't / action-items review.",
    },
    {
      name: "unblock",
      description:
        "Triage a blocked task: renders the task, its blocker chain, and every related message, then prompts a decision — resolve, reassign, or escalate to a human.",
      arguments: [{ name: "task_id", description: "The blocked task to triage (e.g. 'T3')", required: true }],
    },
    {
      name: "handoff",
      description:
        "Hand a task to another agent: renders a complete brief (task detail, full message history, board state) so the receiver can start immediately.",
      arguments: [
        { name: "task_id", description: "The task being handed off (e.g. 'T3')", required: true },
        { name: "to_agent", description: "The agent receiving the task", required: true },
      ],
    },
  ],
}));

function requirePromptArg(args: Record<string, string> | undefined, name: string, prompt: string): string {
  const value = args?.[name];
  if (!value) {
    throw new Error(`Prompt '${prompt}' requires argument '${name}'.`);
  }
  return value;
}

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  let text: string;
  switch (name) {
    case "sprint-planning":
      text = await boardManager.renderSprintPlanning(requirePromptArg(args, "goal", name));
      break;
    case "daily-standup":
      text = await boardManager.renderDailyStandup();
      break;
    case "retrospective":
      text = await boardManager.renderRetrospective();
      break;
    case "unblock":
      text = await boardManager.renderUnblock(requirePromptArg(args, "task_id", name));
      break;
    case "handoff":
      text = await boardManager.renderHandoff(
        requirePromptArg(args, "task_id", name),
        requirePromptArg(args, "to_agent", name),
      );
      break;
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
  return {
    messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
  };
});

/* Resources — read-only views of the same state */

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "scrum://board",
      name: "Sprint board",
      description: "The full board state as JSON: agents, tasks, messages, standups, sprint",
      mimeType: "application/json",
    },
    {
      uri: "scrum://standup/latest",
      name: "Latest standup digest",
      description: "Each agent's most recent standup entry, open blockers, and stale tasks",
      mimeType: "text/plain",
    },
    {
      uri: "scrum://messages",
      name: "Message log",
      description: "Every message posted between agents, as JSON",
      mimeType: "application/json",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const state = await boardManager.readState();
  switch (uri) {
    case "scrum://board":
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(state, null, 2) }],
      };
    case "scrum://standup/latest": {
      const digest = await boardManager.renderLatestStandupDigest();
      return { contents: [{ uri, mimeType: "text/plain", text: digest }] };
    }
    case "scrum://messages":
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(state.messages, null, 2) }],
      };
    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Scrum Master MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
