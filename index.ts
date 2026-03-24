/**
 * pi-coord — lightweight multi-agent coordination extension
 *
 * Design:
 *  - Channels are named topics (e.g. "CH-to-PG-migration")
 *  - Agents join channels with human-readable aliases (e.g. "taql", "team007")
 *  - Messages are fire-and-forget (coord_send) or blocking ask (coord_ask)
 *  - Delivery: auto-inject as steering prompt (triggerTurn: true)
 *  - Approval flow is handled ENTIRELY by the extension, never the LLM:
 *      1. Sender sets requiresApproval=true on coord_ask — blocks waiting for a token
 *      2. Receiver's poller sees the flag, calls ctx.ui.confirm() directly
 *      3. Extension writes a signed ApprovalToken to the registry
 *      4. Sender's coord_ask unblocks on the token — LLM only sees the outcome
 *      5. coord_reply is gated: requiresApproval messages need a valid token
 *  - State lives in ~/.pi/agent/coord/ — shared across all projects, no daemon
 *
 * Slash commands:
 *   /coord                          — show status
 *   /coord join <channel> <alias>   — join (creates channel if new)
 *   /coord leave <channel>          — leave
 *   /coord channels                 — list all channels and members
 *
 * LLM tools:
 *   coord_send    — fire-and-forget (approval flag supported)
 *   coord_ask     — blocking send+wait (approval flag enforced end-to-end)
 *   coord_reply   — reply to a message (gated by approval token if needed)
 *   coord_status  — inspect channels / membership
 *   coord_approve — STUB: explains that approval is handled by the extension
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { homedir } from "node:os";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentEntry {
  sessionId: string;
  alias: string;
  project: string;
  pid: number;
  joinedAt: number;
}

interface Channel {
  name: string;
  members: AgentEntry[];
  createdAt: number;
}

interface Message {
  id: string;
  channelName: string;
  fromAlias: string;
  fromSessionId: string;
  toAlias: string | null;
  text: string;
  replyToId: string | null;
  requiresApproval: boolean;
  sentAt: number;
  deliveredAt: number | null;
}

/**
 * Written by the RECEIVING agent's extension (never the LLM) after
 * ctx.ui.confirm() returns. The sender's coord_ask polls for this token.
 * token = HMAC-SHA256(secret, msgId + ":" + approved)  — tamper-evident.
 */
interface ApprovalToken {
  messageId: string;
  approved: boolean;
  decidedAt: number;
  decidedByAlias: string;    // which agent's human approved/denied
  token: string;             // HMAC for verification
}

interface Registry {
  channels: Record<string, Channel>;
  inboxes: Record<string, Message[]>;       // keyed by sessionId
  approvals: Record<string, ApprovalToken>; // keyed by messageId
}

// ─── File helpers ─────────────────────────────────────────────────────────────

const COORD_DIR = join(homedir(), ".pi", "agent", "coord");
const REGISTRY_FILE = join(COORD_DIR, "registry.json");
const SECRET_FILE = join(COORD_DIR, ".secret");
const LOCK_FILE = join(COORD_DIR, ".lock");

async function ensureDir() {
  await mkdir(COORD_DIR, { recursive: true });
}

async function getSecret(): Promise<string> {
  await ensureDir();
  if (existsSync(SECRET_FILE)) {
    return (await readFile(SECRET_FILE, "utf8")).trim();
  }
  const secret = randomBytes(32).toString("hex");
  await writeFile(SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}

function signApproval(secret: string, messageId: string, approved: boolean): string {
  return createHmac("sha256", secret)
    .update(`${messageId}:${approved}`)
    .digest("hex");
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  while (existsSync(LOCK_FILE)) {
    if (Date.now() - start > 5000) break;
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
    return { channels: {}, inboxes: {}, approvals: {} };
  }
  const raw = await readFile(REGISTRY_FILE, "utf8");
  const reg = JSON.parse(raw) as Registry;
  reg.approvals = reg.approvals ?? {};
  return reg;
}

async function writeRegistry(reg: Registry): Promise<void> {
  await ensureDir();
  await writeFile(REGISTRY_FILE, JSON.stringify(reg, null, 2));
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function pruneDeadAgents(reg: Registry): Registry {
  for (const ch of Object.values(reg.channels)) {
    ch.members = ch.members.filter(m => isAlive(m.pid));
  }
  return reg;
}

function msgId(): string {
  return randomBytes(6).toString("hex");
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let mySessionId = "";
  let myAlias = "";
  let myChannels: string[] = [];
  let pollHandle: ReturnType<typeof setInterval> | null = null;

  // Track messageIds currently being approval-confirmed (prevent double-prompts)
  const pendingApprovals = new Set<string>();

  // ── session_start ────────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    mySessionId = ctx.sessionManager.getSessionFile() ?? `ephemeral-${process.pid}`;

    // Restore channel membership from registry
    const reg = await readRegistry();
    for (const [chName, ch] of Object.entries(reg.channels)) {
      const me = ch.members.find(m => m.sessionId === mySessionId);
      if (me) {
        if (!myChannels.includes(chName)) myChannels.push(chName);
        myAlias = myAlias || me.alias;
      }
    }

    if (myAlias) {
      ctx.ui.setStatus("coord", `coord: ${myAlias} (${myChannels.join(", ") || "no channels"})`);
    }

    // ── Inbox poller ──────────────────────────────────────────────────────
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(async () => {
      if (!mySessionId) return;
      const r = await readRegistry();
      const inbox = r.inboxes[mySessionId] ?? [];
      const pending = inbox.filter(m => !m.deliveredAt);
      if (pending.length === 0) return;

      for (const msg of pending) {
        if (msg.requiresApproval && !msg.replyToId) {
          // ── APPROVAL PATH: handled entirely by the extension ─────────────
          // Guard against double-prompting if poller fires again before confirm resolves
          if (pendingApprovals.has(msg.id)) continue;
          pendingApprovals.add(msg.id);

          // Mark delivered now so we don't re-prompt on next poll tick
          await withLock(async () => {
            const r2 = await readRegistry();
            const box = r2.inboxes[mySessionId] ?? [];
            const m = box.find(x => x.id === msg.id);
            if (m && !m.deliveredAt) m.deliveredAt = Date.now();
            await writeRegistry(r2);
          });

          // Show confirmation dialog directly — LLM is not involved
          const approved = await ctx.ui.confirm(
            `[coord] Approval request from "${msg.fromAlias}" (${msg.channelName})`,
            `"${msg.text}"\n\nApprove this action?`,
          );

          // Write signed token to registry
          const secret = await getSecret();
          const token: ApprovalToken = {
            messageId: msg.id,
            approved,
            decidedAt: Date.now(),
            decidedByAlias: myAlias,
            token: signApproval(secret, msg.id, approved),
          };
          await withLock(async () => {
            const r2 = await readRegistry();
            r2.approvals[msg.id] = token;
            await writeRegistry(r2);
          });

          pendingApprovals.delete(msg.id);

          // Inform the LLM of the outcome as context only (cannot change it)
          const outcome = approved ? "✅ APPROVED" : "❌ DENIED";
          pi.sendMessage(
            {
              customType: "coord-approval-outcome",
              content: `[coord] Approval from "${msg.fromAlias}" for "${msg.text}" — ${outcome} by user.\n\nThe approval token has been written to the registry. ${msg.fromAlias}'s coord_ask will unblock automatically.`,
              display: true,
            },
            { deliverAs: "steer", triggerTurn: false },
          );

          ctx.ui.setStatus("coord", `coord: ${myAlias} (${myChannels.join(", ")})`);

        } else {
          // ── NORMAL MESSAGE PATH ───────────────────────────────────────────
          // Mark delivered
          await withLock(async () => {
            const r2 = await readRegistry();
            const box = r2.inboxes[mySessionId] ?? [];
            const m = box.find(x => x.id === msg.id);
            if (m && !m.deliveredAt) m.deliveredAt = Date.now();
            await writeRegistry(r2);
          });

          const replyCtx = msg.replyToId ? ` (reply to msg ${msg.replyToId})` : "";
          const text = [
            `[coord/${msg.channelName}] Message from **${msg.fromAlias}**${replyCtx}:`,
            msg.text,
            "",
            `Use \`coord_reply\` with messageId="${msg.id}" to respond if needed.`,
          ].join("\n");

          pi.sendMessage(
            { customType: "coord-message", content: text, display: true },
            { triggerTurn: true, deliverAs: "steer" },
          );

          ctx.ui.setStatus("coord", `coord: ${myAlias} (${myChannels.join(", ")}) ●`);
          setTimeout(() => {
            ctx.ui.setStatus("coord", `coord: ${myAlias} (${myChannels.join(", ")})`);
          }, 8000);
        }
      }
    }, 3000);
  });

  // ── session_shutdown ─────────────────────────────────────────────────────
  pi.on("session_shutdown", async (_event, _ctx) => {
    if (pollHandle) clearInterval(pollHandle);
    if (!mySessionId) return;
    await withLock(async () => {
      const reg = await readRegistry();
      for (const ch of Object.values(reg.channels)) {
        ch.members = ch.members.filter(m => m.sessionId !== mySessionId);
      }
      await writeRegistry(reg);
    });
  });

  // ── /coord command ────────────────────────────────────────────────────────
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
              m => m.sessionId !== mySessionId,
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
      ctx.ui.notify(
        `coord status:\n  alias: ${myAlias ? `"${myAlias}"` : "not registered"}\n  channels: ${myChannels.join(", ") || "none"}\n  inbox: ${inbox.length} messages (${unread} undelivered)`,
        "info",
      );
    },
  });

  // ── coord_send ────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "coord_send",
    label: "Coord Send",
    description:
      "Send a message to another agent via a coordination channel. " +
      "Fire-and-forget: returns immediately without waiting for a reply. " +
      "Omit toAlias to broadcast to all channel members. " +
      "Set requiresApproval=true to request user approval on the receiving side — " +
      "the receiver's extension will show a confirmation dialog; you will NOT receive a reply (use coord_ask for that).",
    promptSnippet: "Send a message to another agent via a named coordination channel",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel name (e.g. CH-to-PG-migration)" }),
      message: Type.String({ description: "The message to send" }),
      toAlias: Type.Optional(Type.String({ description: "Target agent alias. Omit to broadcast." })),
      requiresApproval: Type.Optional(Type.Boolean({
        description: "If true, the receiver's extension shows a user confirmation dialog before the message is delivered to their LLM.",
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
          throw new Error(`No target found in channel "${params.channel}". Members: ${ch.members.map(m => m.alias).join(", ") || "none (just you)"}`);
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
          const target = ch.members.find(m => m.alias === msg.toAlias)!;
          reg.inboxes[target.sessionId] = reg.inboxes[target.sessionId] ?? [];
          reg.inboxes[target.sessionId].push(msg);
        }

        await writeRegistry(reg);
        return messages;
      });

      return {
        content: [{ type: "text", text: `Message sent to ${result.map(m => m.toAlias).join(", ")} in "${params.channel}". IDs: ${result.map(m => m.id).join(", ")}` }],
        details: { messageIds: result.map(m => m.id) },
      };
    },
  });

  // ── coord_ask ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "coord_ask",
    label: "Coord Ask",
    description:
      "Send a message to another agent and WAIT for a reply (blocking, default 120s timeout). " +
      "If requiresApproval=true, the message is held until the receiving user approves or denies it " +
      "via a confirmation dialog shown by their extension — the LLM on their side is not involved in the approval decision. " +
      "coord_ask returns the reply text (or approval outcome) when done.",
    promptSnippet: "Send a message to an agent and wait for their reply",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel name" }),
      message: Type.String({ description: "Your question or request" }),
      toAlias: Type.String({ description: "Alias of the agent to ask" }),
      timeoutSeconds: Type.Optional(Type.Number({ description: "How long to wait (default 120s)" })),
      requiresApproval: Type.Optional(Type.Boolean({
        description: "If true, the receiving user must approve before their agent acts. The extension handles this — not the LLM.",
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
        if (!target) throw new Error(`Agent "${params.toAlias}" not found in "${params.channel}". Members: ${ch.members.map(m => m.alias).join(", ")}`);

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

      const deadline = Date.now() + timeout;
      const secret = await getSecret();

      if (params.requiresApproval) {
        // ── Wait for an ApprovalToken written by the receiver's extension ──
        while (Date.now() < deadline) {
          if (signal?.aborted) throw new Error("Cancelled");
          await new Promise(r => setTimeout(r, 1500));

          const reg = await readRegistry();
          const tok = reg.approvals[sentMsg.id];
          if (!tok) continue;

          // Verify the HMAC — reject if tampered
          const expected = signApproval(secret, tok.messageId, tok.approved);
          if (tok.token !== expected) {
            throw new Error(`Approval token for message ${sentMsg.id} failed verification. Possible tampering.`);
          }

          return {
            content: [{
              type: "text",
              text: tok.approved
                ? `User on "${tok.decidedByAlias}" side APPROVED: "${params.message}". You may proceed.`
                : `User on "${tok.decidedByAlias}" side DENIED: "${params.message}". Do not proceed.`,
            }],
            details: { approved: tok.approved, decidedByAlias: tok.decidedByAlias },
          };
        }
        throw new Error(`Approval for message ${sentMsg.id} not received within ${params.timeoutSeconds ?? 120}s.`);

      } else {
        // ── Wait for a normal coord_reply ────────────────────────────────
        while (Date.now() < deadline) {
          if (signal?.aborted) throw new Error("Cancelled");
          await new Promise(r => setTimeout(r, 1500));

          const reg = await readRegistry();
          const inbox = reg.inboxes[mySessionId] ?? [];
          const reply = inbox.find(m => m.replyToId === sentMsg.id);
          if (!reply) continue;

          // Mark delivered
          await withLock(async () => {
            const r2 = await readRegistry();
            const box = r2.inboxes[mySessionId] ?? [];
            const m = box.find(x => x.id === reply.id);
            if (m) m.deliveredAt = Date.now();
            await writeRegistry(r2);
          });

          return {
            content: [{ type: "text", text: `Reply from ${reply.fromAlias}: ${reply.text}` }],
            details: { replyId: reply.id, fromAlias: reply.fromAlias },
          };
        }
        throw new Error(`No reply from "${params.toAlias}" within ${params.timeoutSeconds ?? 120}s.`);
      }
    },
  });

  // ── coord_reply ───────────────────────────────────────────────────────────
  pi.registerTool({
    name: "coord_reply",
    label: "Coord Reply",
    description:
      "Reply to a specific incoming message by its id. " +
      "For messages that required approval, the reply is sent automatically by the extension after the user decides — " +
      "you only need coord_reply for normal (non-approval) messages.",
    promptSnippet: "Reply to a coord message by its id",
    parameters: Type.Object({
      messageId: Type.String({ description: "The id of the message you're replying to" }),
      message: Type.String({ description: "Your reply" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!myAlias) throw new Error("Not in any channel.");

      await withLock(async () => {
        const reg = await readRegistry();

        // Find original message
        let original: Message | null = null;
        for (const msgs of Object.values(reg.inboxes)) {
          const found = msgs.find(m => m.id === params.messageId);
          if (found) { original = found; break; }
        }
        if (!original) throw new Error(`Message id "${params.messageId}" not found.`);

        // Gate: if the original required approval, a valid token must exist
        if (original.requiresApproval) {
          const tok = reg.approvals[params.messageId];
          if (!tok) {
            throw new Error(
              `Message "${params.messageId}" required user approval but no approval token exists yet. ` +
              `The receiving user has not decided yet — wait for coord_ask to return the outcome.`,
            );
          }
          if (!tok.approved) {
            throw new Error(
              `Message "${params.messageId}" was DENIED by the user. You may not reply as if it was approved.`,
            );
          }
        }

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

  // ── coord_status ──────────────────────────────────────────────────────────
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
          return {
            content: [{ type: "text", text: `Channel "${params.channel}" not found. Existing: ${Object.keys(reg.channels).join(", ") || "none"}` }],
            details: {},
          };
        }
        const members = ch.members.length === 0
          ? "  (empty)"
          : ch.members.map(m => `  - ${m.alias} (project: ${m.project}, pid: ${m.pid})`).join("\n");
        return {
          content: [{ type: "text", text: `Channel "${params.channel}":\n${members}` }],
          details: { channel: ch },
        };
      }

      if (Object.keys(reg.channels).length === 0) {
        return {
          content: [{ type: "text", text: "No coordination channels exist yet. Ask the user to run /coord join <channel> <alias>." }],
          details: {},
        };
      }

      const lines = Object.entries(reg.channels).map(([name, ch]) => {
        const mine = myChannels.includes(name) ? " [you're here]" : "";
        const members = ch.members.map(m => `${m.alias}@${m.project}`).join(", ") || "(empty)";
        return `  ${name}${mine}: ${members}`;
      });

      return {
        content: [{ type: "text", text: `Coordination channels:\n${lines.join("\n")}` }],
        details: { channels: reg.channels },
      };
    },
  });

  // ── coord_approve (stub) ──────────────────────────────────────────────────
  pi.registerTool({
    name: "coord_approve",
    label: "Coord Approve",
    description:
      "NOTE: Approval is handled automatically by the pi-coord extension — you do not need to call this tool. " +
      "When a message arrives with requiresApproval=true, the extension intercepts it and shows the user a " +
      "confirmation dialog directly. The LLM is informed of the outcome via a steering message. " +
      "This tool exists only for documentation purposes and always returns an explanation.",
    promptSnippet: "Approval is handled by the extension — do not call this directly",
    parameters: Type.Object({
      messageId: Type.Optional(Type.String({ description: "Message id (informational only)" })),
    }),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      return {
        content: [{
          type: "text",
          text:
            "Approval is handled automatically by the pi-coord extension, not by the LLM. " +
            "When a requiresApproval message arrives, the extension shows a confirmation dialog to the user directly. " +
            "The outcome is written as a signed token to the registry — coord_ask on the sender side unblocks on that token. " +
            "You do not need to call coord_approve.",
        }],
        details: {},
      };
    },
  });
}
