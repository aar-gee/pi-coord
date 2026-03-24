/**
 * pi-coord — lightweight multi-agent coordination extension
 *
 * Design:
 *  - Channels are named topics (e.g. "CH-to-PG-migration")
 *  - Agents join channels with human-readable aliases (e.g. "taql", "team007")
 *  - Messages are fire-and-forget OR blocking ask (coord_ask blocks until reply or timeout)
 *  - Delivery: auto-inject as steering prompt (triggerTurn: true)
 *  - Approval: either agent can escalate; active session gets the confirm overlay
 *  - State lives in ~/.pi/agent/coord/ — shared across all projects, no daemon
 *
 * Slash commands (for you):
 *   /coord                   — show status (channels you're in, pending messages)
 *   /coord join <channel> <alias>   — join a channel with an alias
 *   /coord leave <channel>          — leave a channel
 *   /coord channels                 — list all channels and their members
 *
 * LLM tools:
 *   coord_send   — fire-and-forget message to a channel or specific agent alias
 *   coord_ask    — send + block waiting for reply (with timeout)
 *   coord_reply  — reply to a specific message (used by receiving agent)
 *   coord_status — read own inbox / channel state
 *   coord_approve — ask the local user for approval, returns approved/denied
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentEntry {
  sessionId: string;   // pi session file path (unique per agent instance)
  alias: string;       // human name e.g. "taql"
  project: string;     // cwd at join time
  pid: number;
  joinedAt: number;
}

interface Channel {
  name: string;
  members: AgentEntry[];  // agents currently in this channel
  createdAt: number;
}

interface Message {
  id: string;
  channelName: string;
  fromAlias: string;
  fromSessionId: string;
  toAlias: string | null;   // null = broadcast to all in channel
  text: string;
  replyToId: string | null; // if this is a reply
  requiresApproval: boolean;
  sentAt: number;
  deliveredAt: number | null;
}

interface Registry {
  channels: Record<string, Channel>;
  inboxes: Record<string, Message[]>;   // keyed by sessionId
}

// ─── File helpers ─────────────────────────────────────────────────────────────

const COORD_DIR = join(homedir(), ".pi", "agent", "coord");
const REGISTRY_FILE = join(COORD_DIR, "registry.json");
const LOCK_FILE = join(COORD_DIR, ".lock");

async function ensureDir() {
  await mkdir(COORD_DIR, { recursive: true });
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  // Simple spin-lock via atomic file presence check (good enough for local use)
  const start = Date.now();
  while (existsSync(LOCK_FILE)) {
    if (Date.now() - start > 5000) break; // bail after 5s
    await new Promise(r => setTimeout(r, 50));
  }
  await writeFile(LOCK_FILE, String(process.pid));
  try {
    return await fn();
  } finally {
    try { await writeFile(LOCK_FILE, ""); } catch {}
  }
}

async function readRegistry(): Promise<Registry> {
  await ensureDir();
  if (!existsSync(REGISTRY_FILE)) {
    return { channels: {}, inboxes: {} };
  }
  const raw = await readFile(REGISTRY_FILE, "utf8");
  return JSON.parse(raw) as Registry;
}

async function writeRegistry(reg: Registry): Promise<void> {
  await ensureDir();
  await writeFile(REGISTRY_FILE, JSON.stringify(reg, null, 2));
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Remove dead agents from all channels */
function pruneDeadAgents(reg: Registry): Registry {
  for (const ch of Object.values(reg.channels)) {
    ch.members = ch.members.filter(m => isAlive(m.pid));
  }
  // Remove empty channels? No — keep them so agents can rejoin.
  return reg;
}

function msgId(): string {
  return randomBytes(6).toString("hex");
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // My own session identity — filled on session_start
  let mySessionId = "";
  let myAlias = "";            // set when we join a channel
  let myChannels: string[] = []; // channels I'm currently in

  // Polling interval for inbox checks
  let pollHandle: ReturnType<typeof setInterval> | null = null;

  // ── Resolve own session ID ──────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    mySessionId = ctx.sessionManager.getSessionFile() ?? `ephemeral-${process.pid}`;

    // Restore my channels from last run (check registry)
    const reg = await readRegistry();
    for (const [chName, ch] of Object.entries(reg.channels)) {
      const me = ch.members.find(m => m.sessionId === mySessionId);
      if (me) {
        myChannels.push(chName);
        myAlias = myAlias || me.alias;
      }
    }

    if (myAlias) {
      ctx.ui.setStatus("coord", `coord: ${myAlias} (${myChannels.join(", ") || "no channels"})`);
    }

    // Start inbox polling — every 3 seconds
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(async () => {
      if (!mySessionId) return;
      const r = await readRegistry();
      const inbox = r.inboxes[mySessionId] ?? [];
      if (inbox.length === 0) return;

      // Mark delivered and clear inbox
      const pending = inbox.filter(m => !m.deliveredAt);
      if (pending.length === 0) return;

      await withLock(async () => {
        const r2 = await readRegistry();
        const box = r2.inboxes[mySessionId] ?? [];
        for (const m of box) {
          if (!m.deliveredAt) m.deliveredAt = Date.now();
        }
        await writeRegistry(r2);
      });

      // Deliver each message as a steering prompt
      for (const msg of pending) {
        const label = msg.requiresApproval ? " [NEEDS YOUR APPROVAL]" : "";
        const replyCtx = msg.replyToId ? ` (reply to msg ${msg.replyToId})` : "";
        const text = [
          `[coord/${msg.channelName}] Message from **${msg.fromAlias}**${replyCtx}${label}:`,
          msg.text,
          "",
          msg.requiresApproval
            ? `This action requires user approval. Use \`coord_approve\` to ask the user, then reply with \`coord_reply\`.`
            : `Use \`coord_reply\` with id="${msg.id}" to respond if needed.`,
        ].join("\n");

        pi.sendMessage(
          { customType: "coord-message", content: text, display: true },
          { triggerTurn: true, deliverAs: "steer" }
        );
      }

      // Update status bar unread count
      const total = (r.inboxes[mySessionId] ?? []).length;
      ctx.ui.setStatus("coord", `coord: ${myAlias || "?"} (${myChannels.join(", ")}) ●${pending.length}`);
      setTimeout(() => {
        ctx.ui.setStatus("coord", `coord: ${myAlias || "?"} (${myChannels.join(", ")})`);
      }, 8000);
    }, 3000);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    if (pollHandle) clearInterval(pollHandle);
    // Update registry — mark self as offline (remove from members)
    if (!mySessionId) return;
    await withLock(async () => {
      const reg = await readRegistry();
      for (const ch of Object.values(reg.channels)) {
        ch.members = ch.members.filter(m => m.sessionId !== mySessionId);
      }
      await writeRegistry(reg);
    });
  });

  // ── /coord command ──────────────────────────────────────────────────────
  pi.registerCommand("coord", {
    description: "Manage coordination channels. Usage: /coord [join <channel> <alias> | leave <channel> | channels | status]",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "status";

      if (sub === "join") {
        const channelName = parts[1];
        const alias = parts[2];
        if (!channelName || !alias) {
          ctx.ui.notify("Usage: /coord join <channel-name> <your-alias>", "error");
          return;
        }
        await withLock(async () => {
          const reg = pruneDeadAgents(await readRegistry());
          if (!reg.channels[channelName]) {
            reg.channels[channelName] = { name: channelName, members: [], createdAt: Date.now() };
          }
          const ch = reg.channels[channelName];
          // Remove stale entry for this session
          ch.members = ch.members.filter(m => m.sessionId !== mySessionId);
          ch.members.push({
            sessionId: mySessionId,
            alias,
            project: ctx.cwd,
            pid: process.pid,
            joinedAt: Date.now(),
          });
          await writeRegistry(reg);
        });

        myAlias = alias;
        if (!myChannels.includes(channelName)) myChannels.push(channelName);
        ctx.ui.setStatus("coord", `coord: ${myAlias} (${myChannels.join(", ")})`);
        ctx.ui.notify(`Joined channel "${channelName}" as "${alias}"`, "success");
        return;
      }

      if (sub === "leave") {
        const channelName = parts[1];
        if (!channelName) {
          ctx.ui.notify("Usage: /coord leave <channel-name>", "error");
          return;
        }
        await withLock(async () => {
          const reg = await readRegistry();
          if (reg.channels[channelName]) {
            reg.channels[channelName].members = reg.channels[channelName].members.filter(
              m => m.sessionId !== mySessionId
            );
          }
          await writeRegistry(reg);
        });
        myChannels = myChannels.filter(c => c !== channelName);
        ctx.ui.setStatus("coord", `coord: ${myAlias} (${myChannels.join(", ") || "no channels"})`);
        ctx.ui.notify(`Left channel "${channelName}"`, "info");
        return;
      }

      if (sub === "channels") {
        const reg = pruneDeadAgents(await readRegistry());
        if (Object.keys(reg.channels).length === 0) {
          ctx.ui.notify("No channels exist yet. Use /coord join <channel> <alias>", "info");
          return;
        }
        const lines: string[] = [];
        for (const [name, ch] of Object.entries(reg.channels)) {
          const members = ch.members.length === 0
            ? "(empty)"
            : ch.members.map(m => `${m.alias} [${m.project}]`).join(", ");
          const mine = myChannels.includes(name) ? " ◀ you" : "";
          lines.push(`  ${name}: ${members}${mine}`);
        }
        ctx.ui.notify("Channels:\n" + lines.join("\n"), "info");
        return;
      }

      // Default: status
      const reg = pruneDeadAgents(await readRegistry());
      const inbox = reg.inboxes[mySessionId] ?? [];
      const unread = inbox.filter(m => !m.deliveredAt).length;
      const chList = myChannels.length > 0 ? myChannels.join(", ") : "none";
      const aliasStr = myAlias ? `"${myAlias}"` : "not registered";
      ctx.ui.notify(
        `coord status:\n  alias: ${aliasStr}\n  channels: ${chList}\n  inbox: ${inbox.length} messages (${unread} undelivered)`,
        "info"
      );
    },
  });

  // ── LLM Tool: coord_send ─────────────────────────────────────────────────
  pi.registerTool({
    name: "coord_send",
    label: "Coord Send",
    description: [
      "Send a message to another agent via a coordination channel.",
      "Use this to share information, results, or hand off work.",
      "If the channel has multiple members, specify `toAlias` to target one agent.",
      "If `toAlias` is omitted, the message is broadcast to all channel members.",
      "This is fire-and-forget: the tool returns immediately without waiting for a reply.",
    ].join(" "),
    promptSnippet: "Send a message to another agent via a named coordination channel",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel name (e.g. CH-to-PG-migration)" }),
      message: Type.String({ description: "The message to send" }),
      toAlias: Type.Optional(Type.String({ description: "Target agent alias. Omit to broadcast." })),
      requiresApproval: Type.Optional(Type.Boolean({
        description: "Set true if the recipient needs to get user approval before acting. The receiving agent will use coord_approve.",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!mySessionId) throw new Error("Not initialized — wait for session_start");
      if (!myAlias) throw new Error("Not in any channel. Ask the user to run /coord join <channel> <alias> first.");

      const result = await withLock(async () => {
        const reg = pruneDeadAgents(await readRegistry());
        const ch = reg.channels[params.channel];
        if (!ch) throw new Error(`Channel "${params.channel}" does not exist. Available: ${Object.keys(reg.channels).join(", ") || "none"}`);

        const targets = params.toAlias
          ? ch.members.filter(m => m.alias === params.toAlias && m.sessionId !== mySessionId)
          : ch.members.filter(m => m.sessionId !== mySessionId);

        if (targets.length === 0) {
          const all = ch.members.map(m => m.alias).join(", ");
          throw new Error(`No target found. Channel members: ${all || "none (just you)"}`);
        }

        const messages: Message[] = targets.map(t => ({
          id: msgId(),
          channelName: params.channel,
          fromAlias: myAlias,
          fromSessionId: mySessionId,
          toAlias: t.alias,
          text: params.message,
          replyToId: null,
          requiresApproval: params.requiresApproval ?? false,
          sentAt: Date.now(),
          deliveredAt: null,
        }));

        for (const msg of messages) {
          reg.inboxes[msg.toAlias] = reg.inboxes[msg.toAlias] ?? [];
          // find session id for this alias in the channel
          const target = ch.members.find(m => m.alias === msg.toAlias)!;
          reg.inboxes[target.sessionId] = reg.inboxes[target.sessionId] ?? [];
          reg.inboxes[target.sessionId].push(msg);
        }

        await writeRegistry(reg);
        return messages;
      });

      const ids = result.map(m => `${m.toAlias}:${m.id}`).join(", ");
      return {
        content: [{ type: "text", text: `Message sent to ${result.map(m => m.toAlias).join(", ")} in channel "${params.channel}". Message IDs: ${ids}` }],
        details: { messageIds: result.map(m => m.id) },
      };
    },
  });

  // ── LLM Tool: coord_ask ──────────────────────────────────────────────────
  pi.registerTool({
    name: "coord_ask",
    label: "Coord Ask",
    description: [
      "Send a message to another agent and WAIT for a reply (blocking).",
      "Times out after `timeoutSeconds` (default 120).",
      "Returns the reply text or a timeout error.",
      "Use this when you need information or a result before continuing.",
    ].join(" "),
    promptSnippet: "Send a message to an agent and wait for their reply",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel name" }),
      message: Type.String({ description: "Your question or request" }),
      toAlias: Type.String({ description: "Alias of the agent to ask" }),
      timeoutSeconds: Type.Optional(Type.Number({ description: "How long to wait (default 120s)" })),
      requiresApproval: Type.Optional(Type.Boolean({
        description: "Set true if the recipient needs user approval before acting.",
      })),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx) {
      if (!mySessionId) throw new Error("Not initialized");
      if (!myAlias) throw new Error("Not in any channel. Ask the user to run /coord join <channel> <alias> first.");

      const timeout = (params.timeoutSeconds ?? 120) * 1000;
      const sentMsg = await withLock(async () => {
        const reg = pruneDeadAgents(await readRegistry());
        const ch = reg.channels[params.channel];
        if (!ch) throw new Error(`Channel "${params.channel}" does not exist.`);

        const target = ch.members.find(m => m.alias === params.toAlias);
        if (!target) throw new Error(`Agent "${params.toAlias}" not found in channel "${params.channel}". Members: ${ch.members.map(m => m.alias).join(", ")}`);

        const msg: Message = {
          id: msgId(),
          channelName: params.channel,
          fromAlias: myAlias,
          fromSessionId: mySessionId,
          toAlias: params.toAlias,
          text: params.message,
          replyToId: null,
          requiresApproval: params.requiresApproval ?? false,
          sentAt: Date.now(),
          deliveredAt: null,
        };

        reg.inboxes[target.sessionId] = reg.inboxes[target.sessionId] ?? [];
        reg.inboxes[target.sessionId].push(msg);
        await writeRegistry(reg);
        return msg;
      });

      // Poll for a reply addressed back to us with replyToId = sentMsg.id
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error("Cancelled");
        await new Promise(r => setTimeout(r, 1500));
        const reg = await readRegistry();
        const inbox = reg.inboxes[mySessionId] ?? [];
        const reply = inbox.find(m => m.replyToId === sentMsg.id);
        if (reply) {
          // Mark reply as delivered
          await withLock(async () => {
            const r2 = await readRegistry();
            const box = r2.inboxes[mySessionId] ?? [];
            const r = box.find(m => m.id === reply.id);
            if (r) r.deliveredAt = Date.now();
            await writeRegistry(r2);
          });
          return {
            content: [{ type: "text", text: `Reply from ${reply.fromAlias}: ${reply.text}` }],
            details: { replyId: reply.id, fromAlias: reply.fromAlias },
          };
        }
      }

      throw new Error(`No reply from "${params.toAlias}" within ${params.timeoutSeconds ?? 120}s.`);
    },
  });

  // ── LLM Tool: coord_reply ────────────────────────────────────────────────
  pi.registerTool({
    name: "coord_reply",
    label: "Coord Reply",
    description: "Reply to a specific incoming message. Use the message id from the coord message you received.",
    promptSnippet: "Reply to a coord message by its id",
    parameters: Type.Object({
      messageId: Type.String({ description: "The id of the message you're replying to" }),
      message: Type.String({ description: "Your reply" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!myAlias) throw new Error("Not in any channel.");

      await withLock(async () => {
        const reg = await readRegistry();

        // Find original message anywhere in inboxes
        let original: Message | null = null;
        for (const msgs of Object.values(reg.inboxes)) {
          const found = msgs.find(m => m.id === params.messageId);
          if (found) { original = found; break; }
        }
        if (!original) throw new Error(`Message id "${params.messageId}" not found.`);

        const reply: Message = {
          id: msgId(),
          channelName: original.channelName,
          fromAlias: myAlias,
          fromSessionId: mySessionId,
          toAlias: original.fromAlias,
          text: params.message,
          replyToId: params.messageId,
          requiresApproval: false,
          sentAt: Date.now(),
          deliveredAt: null,
        };

        reg.inboxes[original.fromSessionId] = reg.inboxes[original.fromSessionId] ?? [];
        reg.inboxes[original.fromSessionId].push(reply);
        await writeRegistry(reg);
      });

      return {
        content: [{ type: "text", text: `Reply sent (reply to msg ${params.messageId}).` }],
        details: {},
      };
    },
  });

  // ── LLM Tool: coord_status ───────────────────────────────────────────────
  pi.registerTool({
    name: "coord_status",
    label: "Coord Status",
    description: "Check who is in a channel, or list all channels and agents. Use this to decide who to route a message to.",
    promptSnippet: "Check coordination channel members and agent availability",
    parameters: Type.Object({
      channel: Type.Optional(Type.String({ description: "Channel name to inspect. Omit to list all channels." })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const reg = pruneDeadAgents(await readRegistry());

      if (params.channel) {
        const ch = reg.channels[params.channel];
        if (!ch) {
          const all = Object.keys(reg.channels).join(", ") || "none";
          return {
            content: [{ type: "text", text: `Channel "${params.channel}" not found. Existing channels: ${all}` }],
            details: {},
          };
        }
        const members = ch.members.map(m => `  - ${m.alias} (project: ${m.project}, pid: ${m.pid})`).join("\n");
        return {
          content: [{ type: "text", text: `Channel "${params.channel}" members:\n${members || "  (empty)"}` }],
          details: { channel: ch },
        };
      }

      // All channels
      if (Object.keys(reg.channels).length === 0) {
        return {
          content: [{ type: "text", text: "No coordination channels exist yet. Ask the user to run /coord join <channel> <alias>." }],
          details: {},
        };
      }

      const lines: string[] = [];
      for (const [name, ch] of Object.entries(reg.channels)) {
        const mine = myChannels.includes(name) ? " [you're here]" : "";
        const members = ch.members.map(m => `${m.alias}@${m.project}`).join(", ") || "(empty)";
        lines.push(`  ${name}${mine}: ${members}`);
      }

      return {
        content: [{ type: "text", text: `Coordination channels:\n${lines.join("\n")}` }],
        details: { channels: reg.channels },
      };
    },
  });

  // ── LLM Tool: coord_approve ──────────────────────────────────────────────
  pi.registerTool({
    name: "coord_approve",
    label: "Coord Approve",
    description: [
      "Ask the LOCAL USER for approval to perform an action requested by another agent.",
      "Shows a confirmation dialog. Returns approved=true or approved=false with optional user note.",
      "Use this when you receive a coord message with requiresApproval=true,",
      "OR when another agent's request would make changes to your project.",
    ].join(" "),
    promptSnippet: "Ask the user for approval on a cross-agent action",
    parameters: Type.Object({
      action: Type.String({ description: "Plain-language description of what the other agent wants to do" }),
      requestedBy: Type.String({ description: "Alias of the agent making the request" }),
      channel: Type.String({ description: "Channel this came through" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const title = `[coord] Approval Request from "${params.requestedBy}" (${params.channel})`;
      const question = `Action: ${params.action}\n\nApprove?`;
      const approved = await ctx.ui.confirm(title, question);

      return {
        content: [{
          type: "text",
          text: approved
            ? `User approved: "${params.action}". You may proceed and then use coord_reply to inform ${params.requestedBy}.`
            : `User denied: "${params.action}". Reply to ${params.requestedBy} that the action was not approved.`,
        }],
        details: { approved },
      };
    },
  });
}
