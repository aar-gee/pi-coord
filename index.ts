/**
 * pi-coord — lightweight multi-agent coordination extension
 *
 * Design:
 *  - Channels are named topics (e.g. "CH-to-PG-migration")
 *  - Agents join channels with human-readable aliases (e.g. "taql", "team007")
 *  - Messages are fire-and-forget (coord_send) or blocking ask (coord_ask)
 *  - Delivery: auto-inject as steering prompt (triggerTurn: true)
 *  - Approval flow is handled ENTIRELY by the extension, never the LLM
 *  - coord_ack: explicit sentinel — closes a thread without a substantive reply,
 *    unblocks coord_ask on the sender side
 *  - State lives in ~/.pi/agent/coord/ — shared across all projects, no daemon
 *
 * Slash commands:
 *   /coord                              — show status
 *   /coord join <channel> <alias>       — join (creates channel if new)
 *   /coord leave <channel>              — leave
 *   /coord channels                     — list all channels and members
 *   /coord history [channel]            — threaded chat history TUI
 *
 * LLM tools:
 *   coord_send    — fire-and-forget
 *   coord_ask     — blocking send+wait (unblocks on reply OR ack OR approval token)
 *   coord_reply   — reply with new information (gated if approval required)
 *   coord_ack     — sentinel: "received and handled, no further reply coming"
 *   coord_status  — inspect channels / membership
 *   coord_approve — STUB: approval is handled by the extension, not the LLM
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

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
  isAck: boolean;           // sentinel: closes thread without substantive reply
  requiresApproval: boolean;
  sentAt: number;
  deliveredAt: number | null;
}

interface ApprovalToken {
  messageId: string;
  approved: boolean;
  decidedAt: number;
  decidedByAlias: string;
  token: string;
}

interface Registry {
  channels: Record<string, Channel>;
  inboxes: Record<string, Message[]>;
  approvals: Record<string, ApprovalToken>;
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
  if (existsSync(SECRET_FILE)) return (await readFile(SECRET_FILE, "utf8")).trim();
  const secret = randomBytes(32).toString("hex");
  await writeFile(SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}

function signApproval(secret: string, messageId: string, approved: boolean): string {
  return createHmac("sha256", secret).update(`${messageId}:${approved}`).digest("hex");
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
  if (!existsSync(REGISTRY_FILE)) return { channels: {}, inboxes: {}, approvals: {} };
  const raw = await readFile(REGISTRY_FILE, "utf8");
  const reg = JSON.parse(raw) as Registry;
  reg.approvals = reg.approvals ?? {};
  // Backfill isAck for older messages
  for (const msgs of Object.values(reg.inboxes)) {
    for (const m of msgs) {
      if (m.isAck === undefined) m.isAck = false;
    }
  }
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

function newMsgId(): string { return randomBytes(6).toString("hex"); }

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ─── History TUI ─────────────────────────────────────────────────────────────

/**
 * Threaded message list for /coord history.
 * Layout:
 *   ┌─ CH-to-PG-migration ─── 2 members ────────────────┐
 *   │ 14:22  team007  Feature request: schema_for_user…  │
 *   │ 14:24    taql   Both addressed in tlr revset…      │  ← reply, indented
 *   │ 14:26    taql   ✓ ack                              │  ← ack sentinel
 *   │ ...                                                │
 *   └────────────────────── ↑↓ scroll • Esc close ──────┘
 */
class HistoryComponent {
  private lines: string[] = [];
  private scrollOffset = 0;
  private viewHeight = 0;
  private cachedWidth = 0;
  public onClose: () => void = () => {};

  constructor(
    private channelName: string,
    private allMessages: Message[],
    private myAlias: string,
    private theme: any,
  ) {
    // nothing — rendered lazily
  }

  private buildLines(width: number): string[] {
    const th = this.theme;
    const inner = Math.max(10, width - 2);
    const lines: string[] = [];

    // Header
    const total = this.allMessages.length;
    const hdr = ` ${this.channelName} — ${total} message${total !== 1 ? "s" : ""} `;
    const hdrW = visibleWidth(hdr);
    const leftDash = Math.max(0, Math.floor((inner - hdrW) / 2));
    const rightDash = Math.max(0, inner - hdrW - leftDash);
    lines.push(
      th.fg("borderMuted", "┌") +
      th.fg("borderMuted", "─".repeat(leftDash)) +
      th.fg("accent", hdr) +
      th.fg("borderMuted", "─".repeat(rightDash)) +
      th.fg("borderMuted", "┐"),
    );

    if (this.allMessages.length === 0) {
      lines.push(th.fg("borderMuted", "│") + th.fg("dim", "  (no messages yet)".padEnd(inner)) + th.fg("borderMuted", "│"));
    } else {
      // Build a thread tree: root messages in chronological order,
      // replies inserted immediately after their parent (depth-first).
      const byId = new Map<string, Message>();
      for (const m of this.allMessages) byId.set(m.id, m);

      const childrenOf = new Map<string, Message[]>();
      const roots: Message[] = [];
      for (const m of this.allMessages) {
        if (m.replyToId) {
          const arr = childrenOf.get(m.replyToId) ?? [];
          arr.push(m);
          childrenOf.set(m.replyToId, arr);
        } else {
          roots.push(m);
        }
      }
      roots.sort((a, b) => a.sentAt - b.sentAt);

      const walk = (msgs: Message[], depth: number) => {
        for (const m of msgs) {
          const indent = depth * 2;
          const time = th.fg("dim", fmtTime(m.sentAt));
          const isMe = m.fromAlias === this.myAlias;
          const aliasColor = isMe ? "success" : "accent";
          const alias = th.fg(aliasColor, m.fromAlias.padEnd(12));
          const ackLabel = m.isAck ? th.fg("dim", "✓ ack") : null;
          const textColor = m.isAck ? "dim" : "text";

          const prefix = " ".repeat(indent) + time + "  " + alias + "  ";
          const prefixWidth = indent + visibleWidth(time) + 2 + 12 + 2;
          const textAvail = Math.max(10, inner - prefixWidth - 2); // 2 for borders

          const msgLines = ackLabel
            ? [ackLabel]
            : wrapText(m.text, textAvail, th, textColor);

          for (let i = 0; i < msgLines.length; i++) {
            const left = i === 0 ? prefix : " ".repeat(prefixWidth);
            const row = left + msgLines[i];
            lines.push(
              th.fg("borderMuted", "│") +
              truncateToWidth(row, inner) +
              th.fg("borderMuted", "│"),
            );
          }

          const children = childrenOf.get(m.id);
          if (children) {
            children.sort((a, b) => a.sentAt - b.sentAt);
            walk(children, depth + 1);
          }
        }
      };

      walk(roots, 0);
    }

    // Footer
    const footer = " ↑↓ scroll • Esc close ";
    const footerW = visibleWidth(footer);
    const lf = Math.max(0, inner - footerW);
    lines.push(
      th.fg("borderMuted", "└") +
      "─".repeat(Math.floor(lf / 2)) +
      th.fg("dim", footer) +
      "─".repeat(Math.ceil(lf / 2)) +
      th.fg("borderMuted", "┘"),
    );

    return lines;
  }

  render(width: number): string[] {
    if (width !== this.cachedWidth) {
      this.cachedWidth = width;
      this.lines = this.buildLines(width);
    }

    const headerLines = 1;
    const footerLines = 1;
    const totalContent = this.lines.length - headerLines - footerLines;
    const termRows = 24; // conservative default
    this.viewHeight = Math.max(5, termRows - 4);
    const maxScroll = Math.max(0, totalContent - this.viewHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

    const visible = [
      this.lines[0],
      ...this.lines.slice(1 + this.scrollOffset, 1 + this.scrollOffset + this.viewHeight),
      this.lines[this.lines.length - 1],
    ];
    return visible;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.invalidate();
    }
    if (matchesKey(data, Key.down)) {
      this.scrollOffset = Math.max(0, this.scrollOffset + 1);
      this.invalidate();
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      this.scrollOffset = Math.max(0, this.scrollOffset - Math.floor(this.viewHeight / 2));
      this.invalidate();
    }
    if (matchesKey(data, Key.ctrl("d"))) {
      this.scrollOffset += Math.floor(this.viewHeight / 2);
      this.invalidate();
    }
  }

  invalidate(): void {
    this.cachedWidth = 0; // force rebuild on next render
  }
}

/** Simple word-wrap that respects ANSI — wraps on spaces */
function wrapText(text: string, width: number, theme: any, color: string): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? current + " " + word : word;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
    } else {
      if (current) lines.push(theme.fg(color, current));
      // If the word itself is too long, hard-truncate
      current = word.length > width ? word.slice(0, width) : word;
    }
  }
  if (current) lines.push(theme.fg(color, current));
  return lines.length ? lines : [theme.fg(color, "")];
}

/** Collect all messages for a channel across all inboxes */
function collectChannelMessages(reg: Registry, channelName: string): Message[] {
  const seen = new Set<string>();
  const result: Message[] = [];
  for (const msgs of Object.values(reg.inboxes)) {
    for (const m of msgs) {
      if (m.channelName === channelName && !seen.has(m.id)) {
        seen.add(m.id);
        result.push(m);
      }
    }
  }
  result.sort((a, b) => a.sentAt - b.sentAt);
  return result;
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let mySessionId = "";
  let myAlias = "";
  let myChannels: string[] = [];
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  const pendingApprovals = new Set<string>();

  // ── session_start ────────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    mySessionId = ctx.sessionManager.getSessionFile() ?? `ephemeral-${process.pid}`;

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

    if (pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(async () => {
      if (!mySessionId) return;
      const r = await readRegistry();
      const inbox = r.inboxes[mySessionId] ?? [];
      const pending = inbox.filter(m => !m.deliveredAt);
      if (pending.length === 0) return;

      for (const msg of pending) {
        if (msg.requiresApproval && !msg.replyToId && !msg.isAck) {
          // ── APPROVAL PATH ─────────────────────────────────────────────────
          if (pendingApprovals.has(msg.id)) continue;
          pendingApprovals.add(msg.id);

          await withLock(async () => {
            const r2 = await readRegistry();
            const m = (r2.inboxes[mySessionId] ?? []).find(x => x.id === msg.id);
            if (m && !m.deliveredAt) m.deliveredAt = Date.now();
            await writeRegistry(r2);
          });

          const approved = await ctx.ui.confirm(
            `[coord] Approval request from "${msg.fromAlias}" (${msg.channelName})`,
            `"${msg.text}"\n\nApprove this action?`,
          );

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

          const outcome = approved ? "✅ APPROVED" : "❌ DENIED";
          pi.sendMessage(
            {
              customType: "coord-approval-outcome",
              content: `[coord] Approval from "${msg.fromAlias}" for "${msg.text}" — ${outcome} by user.\nThe approval token is written to the registry. ${msg.fromAlias}'s coord_ask will unblock automatically.`,
              display: true,
            },
            { deliverAs: "steer", triggerTurn: false },
          );

          ctx.ui.setStatus("coord", `coord: ${myAlias} (${myChannels.join(", ")})`);

        } else {
          // ── NORMAL / ACK MESSAGE PATH ─────────────────────────────────────
          await withLock(async () => {
            const r2 = await readRegistry();
            const m = (r2.inboxes[mySessionId] ?? []).find(x => x.id === msg.id);
            if (m && !m.deliveredAt) m.deliveredAt = Date.now();
            await writeRegistry(r2);
          });

          // ACK messages are just sentinel signals — don't inject them as prompts
          if (msg.isAck) continue;

          const replyCtx = msg.replyToId ? ` (reply to msg ${msg.replyToId})` : "";
          const text = [
            `[coord/${msg.channelName}] Message from **${msg.fromAlias}**${replyCtx}:`,
            msg.text,
            "",
            `Reply with \`coord_reply\` (messageId="${msg.id}") ONLY if you have new information, a question, or a concrete result to share.`,
            `If you have handled this message and the sender is waiting (coord_ask), but you have nothing substantive to add, use \`coord_ack\` instead — it closes the thread without noise.`,
            `Do NOT reply just to acknowledge, say "sounds good", "great", "noted", or "thanks".`,
            `If the message is a terminal status update (e.g. "done", "fixed", "passing") — silence is correct, unless the sender is explicitly waiting.`,
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
    description: "Coord channels. Usage: /coord [join <ch> <alias> | leave <ch> | channels | history [ch] | status]",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "status";

      // ── join ──────────────────────────────────────────────────────────────
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
          ch.members.push({ sessionId: mySessionId, alias, project: ctx.cwd, pid: process.pid, joinedAt: Date.now() });
          await writeRegistry(reg);
        });
        myAlias = alias;
        if (!myChannels.includes(channelName)) myChannels.push(channelName);
        ctx.ui.setStatus("coord", `coord: ${myAlias} (${myChannels.join(", ")})`);
        ctx.ui.notify(`Joined channel "${channelName}" as "${alias}"`, "success");
        return;
      }

      // ── leave ─────────────────────────────────────────────────────────────
      if (sub === "leave") {
        const channelName = parts[1];
        if (!channelName) { ctx.ui.notify("Usage: /coord leave <channel-name>", "error"); return; }
        await withLock(async () => {
          const reg = await readRegistry();
          if (reg.channels[channelName]) {
            reg.channels[channelName].members = reg.channels[channelName].members.filter(m => m.sessionId !== mySessionId);
          }
          await writeRegistry(reg);
        });
        myChannels = myChannels.filter(c => c !== channelName);
        ctx.ui.setStatus("coord", `coord: ${myAlias} (${myChannels.join(", ") || "no channels"})`);
        ctx.ui.notify(`Left channel "${channelName}"`, "info");
        return;
      }

      // ── channels ──────────────────────────────────────────────────────────
      if (sub === "channels") {
        const reg = pruneDeadAgents(await readRegistry());
        if (Object.keys(reg.channels).length === 0) {
          ctx.ui.notify("No channels exist yet. Use /coord join <channel> <alias>", "info");
          return;
        }
        const lines = Object.entries(reg.channels).map(([name, ch]) => {
          const members = ch.members.length === 0 ? "(empty)" : ch.members.map(m => `${m.alias} [${m.project}]`).join(", ");
          return `  ${name}${myChannels.includes(name) ? " ◀ you" : ""}: ${members}`;
        });
        ctx.ui.notify("Channels:\n" + lines.join("\n"), "info");
        return;
      }

      // ── history ───────────────────────────────────────────────────────────
      if (sub === "history") {
        const channelArg = parts[1];

        // Pick channel: explicit arg > single channel I'm in > ask
        let channelName: string | null = null;
        if (channelArg) {
          channelName = channelArg;
        } else if (myChannels.length === 1) {
          channelName = myChannels[0];
        } else if (myChannels.length > 1) {
          channelName = await ctx.ui.select(
            "Which channel?",
            myChannels.map(c => ({ label: c, value: c })),
          ) ?? null;
        }

        if (!channelName) {
          ctx.ui.notify("No channel specified and not in any channel.", "error");
          return;
        }

        const reg = await readRegistry();
        if (!reg.channels[channelName]) {
          ctx.ui.notify(`Channel "${channelName}" does not exist.`, "error");
          return;
        }

        const messages = collectChannelMessages(reg, channelName);

        await ctx.ui.custom<void>(
          (tui, theme, _kb, done) => {
            const comp = new HistoryComponent(channelName!, messages, myAlias, theme);
            comp.onClose = done;
            return comp;
          },
          {
            overlay: true,
            overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" },
          },
        );
        return;
      }

      // ── status (default) ──────────────────────────────────────────────────
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
      "ONLY send if the other agent needs to act, is blocked waiting, or needs information to continue. " +
      "Do NOT send acknowledgements, thank-yous, or 'sounds good' replies. " +
      "Do NOT duplicate information already sent in the same turn. " +
      "If you need a reply, use coord_ask instead.",
    promptSnippet: "Send a message to another agent via a named coordination channel",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel name (e.g. CH-to-PG-migration)" }),
      message: Type.String({ description: "The message to send" }),
      toAlias: Type.Optional(Type.String({ description: "Target agent alias. Omit to broadcast." })),
      requiresApproval: Type.Optional(Type.Boolean({
        description: "If true, the receiver's extension shows a user confirmation dialog before delivery.",
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
          throw new Error(`No target found in "${params.channel}". Members: ${ch.members.map(m => m.alias).join(", ") || "none (just you)"}`);
        }

        const messages: Message[] = targets.map(t => ({
          id: newMsgId(),
          channelName: params.channel,
          fromAlias: myAlias,
          fromSessionId: mySessionId,
          toAlias: t.alias,
          text: params.message,
          replyToId: null,
          isAck: false,
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
        content: [{ type: "text", text: `Sent to ${result.map(m => m.toAlias).join(", ")} in "${params.channel}". IDs: ${result.map(m => m.id).join(", ")}` }],
        details: { messageIds: result.map(m => m.id) },
      };
    },
  });

  // ── coord_ask ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "coord_ask",
    label: "Coord Ask",
    description:
      "Send a message to another agent and WAIT for a reply or ack (blocking, default 120s). " +
      "Unblocks when the receiver calls coord_reply (substantive answer) or coord_ack (sentinel close). " +
      "If requiresApproval=true, unblocks when the receiving user approves or denies via a confirmation dialog — the LLM is not involved in that decision.",
    promptSnippet: "Send a message to an agent and wait for their reply",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel name" }),
      message: Type.String({ description: "Your question or request" }),
      toAlias: Type.String({ description: "Alias of the agent to ask" }),
      timeoutSeconds: Type.Optional(Type.Number({ description: "How long to wait (default 120s)" })),
      requiresApproval: Type.Optional(Type.Boolean({
        description: "If true, waits for the receiving user to approve/deny via confirmation dialog.",
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
          id: newMsgId(),
          channelName: params.channel,
          fromAlias: myAlias,
          fromSessionId: mySessionId,
          toAlias: params.toAlias,
          text: params.message,
          replyToId: null,
          isAck: false,
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
        while (Date.now() < deadline) {
          if (signal?.aborted) throw new Error("Cancelled");
          await new Promise(r => setTimeout(r, 1500));
          const reg = await readRegistry();
          const tok = reg.approvals[sentMsg.id];
          if (!tok) continue;
          const expected = signApproval(secret, tok.messageId, tok.approved);
          if (tok.token !== expected) throw new Error(`Approval token verification failed for ${sentMsg.id}.`);
          return {
            content: [{ type: "text", text: tok.approved
              ? `User on "${tok.decidedByAlias}" APPROVED: "${params.message}". You may proceed.`
              : `User on "${tok.decidedByAlias}" DENIED: "${params.message}". Do not proceed.` }],
            details: { approved: tok.approved, decidedByAlias: tok.decidedByAlias },
          };
        }
        throw new Error(`Approval not received within ${params.timeoutSeconds ?? 120}s.`);
      }

      // Wait for coord_reply OR coord_ack — both unblock the caller
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error("Cancelled");
        await new Promise(r => setTimeout(r, 1500));
        const reg = await readRegistry();
        const inbox = reg.inboxes[mySessionId] ?? [];
        const response = inbox.find(m => m.replyToId === sentMsg.id);
        if (!response) continue;

        await withLock(async () => {
          const r2 = await readRegistry();
          const m = (r2.inboxes[mySessionId] ?? []).find(x => x.id === response.id);
          if (m) m.deliveredAt = Date.now();
          await writeRegistry(r2);
        });

        if (response.isAck) {
          return {
            content: [{ type: "text", text: `${response.fromAlias} acknowledged (handled, no further reply).` }],
            details: { acked: true, fromAlias: response.fromAlias },
          };
        }

        return {
          content: [{ type: "text", text: `Reply from ${response.fromAlias}: ${response.text}` }],
          details: { replyId: response.id, fromAlias: response.fromAlias },
        };
      }

      throw new Error(`No reply from "${params.toAlias}" within ${params.timeoutSeconds ?? 120}s.`);
    },
  });

  // ── coord_reply ───────────────────────────────────────────────────────────
  pi.registerTool({
    name: "coord_reply",
    label: "Coord Reply",
    description:
      "Reply to an incoming message with new information, a result, or a question. " +
      "ONLY use this when you have something substantive to say. " +
      "If you have handled the message but have nothing to add, use coord_ack instead — it closes the thread without noise. " +
      "Do NOT use coord_reply to acknowledge, say 'sounds good', 'noted', 'thanks', or 'will do'. " +
      "Do NOT reply to terminal status updates (done/fixed/passing) — silence or coord_ack is correct.",
    promptSnippet: "Reply to a coord message by its id",
    parameters: Type.Object({
      messageId: Type.String({ description: "The id of the message you're replying to" }),
      message: Type.String({ description: "Your reply (must contain new information or a question)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!myAlias) throw new Error("Not in any channel.");

      await withLock(async () => {
        const reg = await readRegistry();
        let original: Message | null = null;
        for (const msgs of Object.values(reg.inboxes)) {
          const found = msgs.find(m => m.id === params.messageId);
          if (found) { original = found; break; }
        }
        if (!original) throw new Error(`Message "${params.messageId}" not found.`);

        if (original.requiresApproval) {
          const tok = reg.approvals[params.messageId];
          if (!tok) throw new Error(`Message "${params.messageId}" requires approval but none exists yet.`);
          if (!tok.approved) throw new Error(`Message "${params.messageId}" was DENIED. Cannot reply as approved.`);
        }

        const reply: Message = {
          id: newMsgId(),
          channelName: original.channelName,
          fromAlias: myAlias,
          fromSessionId: mySessionId,
          toAlias: original.fromAlias,
          text: params.message,
          replyToId: params.messageId,
          isAck: false,
          requiresApproval: false,
          sentAt: Date.now(),
          deliveredAt: null,
        };
        reg.inboxes[original.fromSessionId] = reg.inboxes[original.fromSessionId] ?? [];
        reg.inboxes[original.fromSessionId].push(reply);
        await writeRegistry(reg);
      });

      return {
        content: [{ type: "text", text: `Reply sent (to msg ${params.messageId}).` }],
        details: {},
      };
    },
  });

  // ── coord_ack ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "coord_ack",
    label: "Coord Ack",
    description:
      "Send a sentinel acknowledgement to close a thread without a substantive reply. " +
      "Use this when you have received and handled a message, the sender may be waiting (coord_ask), " +
      "but you have nothing new to add — a result, question, or new information. " +
      "coord_ack unblocks the sender's coord_ask immediately and is recorded in history as '✓ ack'. " +
      "This is preferred over silence (which leaves coord_ask waiting until timeout) " +
      "and over coord_reply with empty filler words ('sounds good', 'noted', 'thanks').",
    promptSnippet: "Close a coord thread with a silent sentinel ACK (no reply noise)",
    parameters: Type.Object({
      messageId: Type.String({ description: "The id of the message you are acknowledging" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!myAlias) throw new Error("Not in any channel.");

      await withLock(async () => {
        const reg = await readRegistry();
        let original: Message | null = null;
        for (const msgs of Object.values(reg.inboxes)) {
          const found = msgs.find(m => m.id === params.messageId);
          if (found) { original = found; break; }
        }
        if (!original) throw new Error(`Message "${params.messageId}" not found.`);

        const ack: Message = {
          id: newMsgId(),
          channelName: original.channelName,
          fromAlias: myAlias,
          fromSessionId: mySessionId,
          toAlias: original.fromAlias,
          text: "",
          replyToId: params.messageId,
          isAck: true,
          requiresApproval: false,
          sentAt: Date.now(),
          deliveredAt: null,
        };
        reg.inboxes[original.fromSessionId] = reg.inboxes[original.fromSessionId] ?? [];
        reg.inboxes[original.fromSessionId].push(ack);
        await writeRegistry(reg);
      });

      return {
        content: [{ type: "text", text: `Ack sent for msg ${params.messageId}. Sender's coord_ask will unblock.` }],
        details: { acked: true },
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
          content: [{ type: "text", text: "No channels yet. Ask the user to run /coord join <channel> <alias>." }],
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
      "NOTE: You do not need to call this. Approval is handled automatically by the extension. " +
      "When a requiresApproval message arrives, the extension calls ctx.ui.confirm() and writes a signed token. " +
      "coord_ask unblocks on that token. This tool is a no-op stub.",
    promptSnippet: "Approval is handled by the extension — do not call this",
    parameters: Type.Object({
      messageId: Type.Optional(Type.String({ description: "Informational only" })),
    }),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text", text: "Approval is handled by the pi-coord extension, not the LLM. No action needed." }],
        details: {},
      };
    },
  });
}
