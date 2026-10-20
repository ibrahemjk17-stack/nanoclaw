/**
 * Jarvis: approvals in the Telegram Approvals topic.
 *
 * An agent asks through the data server's `request_approval` tool. The host polls the data server every few seconds (no model, one
 * small HTTP call), posts a card with Approve / Reject buttons into the Approvals topic, and handles the owner's tap. The decision is
 * written to the `approvals` table by the data server; the agent reads it with `get_approval`. Typed or spoken words never approve
 * anything: only these buttons do, and only for the owner.
 *
 * Button ids are `ncq:jv-appr-<12 hex>:<0|1>` (NanoClaw's own card format), 0 = approve, 1 = reject.
 */
import { Card, CardText, type ActionEvent, type Adapter } from 'chat';

import { handleTail } from './commands.js';

export interface ApprovalDeps {
  /** POST to /host/<path>; throws when unreachable. */
  data: (path: string, body?: unknown) => Promise<any>;
  /** Sends content to the Approvals topic through NanoClaw's delivery adapter; resolves to the message id when known. */
  post: (kind: string, content: string) => Promise<string | undefined>;
  ownerId: () => string | undefined;
  now: () => Date;
  warn: (msg: string, extra?: unknown) => void;
  /** Leaves a visible line for every tap that reaches us, so a tap can never disappear without a trace. */
  trace?: (msg: string, extra?: unknown) => void;
}

export const ACTION_ID = /^ncq:jv-appr-([0-9a-f]{12}):([01])$/;

export const approvalContent = (p: { id12: string; title: string; question: string }): string =>
  JSON.stringify({
    type: 'ask_question',
    questionId: `jv-appr-${p.id12}`,
    title: p.title,
    question: p.question,
    options: [
      { label: '✅ Approve', value: 'approved' },
      { label: '❌ Reject', value: 'rejected' },
    ],
  });

let running = false;

/** One poll: post cards for new requests, tell the owner about requests that expired unanswered. Never throws. */
export async function syncApprovals(deps: ApprovalDeps): Promise<void> {
  if (running) return; // a slow poll must not overlap the next one
  running = true;
  try {
    const sync = (await deps.data('/host/approvals/sync')) as {
      post: { id12: string; title: string; question: string }[];
      expired: { id12: string; action: string }[];
    };
    for (const p of sync.post) {
      const messageId = await deps.post('chat-sdk', approvalContent(p));
      // Recorded right away so the same request is never posted twice. If this call fails the card is posted again next poll.
      await deps.data('/host/approvals/posted', { id12: p.id12, message_id: messageId ?? null });
    }
    for (const e of sync.expired) {
      await deps.post(
        'chat-sdk',
        JSON.stringify({ text: `⌛ No decision in 30 minutes, so this expired and was not done: ${e.action}` }),
      );
    }
  } catch (err) {
    // the data service being down is normal during a restart: quiet, and tried again next time
    deps.warn('Approvals poll failed', err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

/** A tap on an approval card. Returns false when the event is not ours, true when it is (even if ignored). */
export async function handleApprovalAction(event: ActionEvent, adapter: Adapter, deps: ApprovalDeps): Promise<boolean> {
  const m = ACTION_ID.exec(event.actionId);
  if (!m) return false;
  const owner = deps.ownerId();
  deps.trace?.('Jarvis approval tap', {
    decision: m[2] === '0' ? 'approve' : 'reject',
    user: event.user?.userId ?? null,
  });
  if (!owner || handleTail(event.user?.userId) !== owner) {
    deps.trace?.('Jarvis approval tap ignored: not the owner', {
      user: event.user?.userId ?? null,
      ownerConfigured: Boolean(owner),
    });
    return true; // ours, but not the owner: nothing happens, no reply
  }

  let text: string;
  try {
    const r = (await deps.data('/host/approvals/decide', {
      id12: m[1],
      decision: m[2] === '0' ? 'approved' : 'rejected',
    })) as { ok: boolean; text: string };
    text = r.text;
  } catch {
    return true; // could not reach the data service: the buttons stay, he can tap again
  }
  try {
    const stamp = deps.now().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    await adapter.editMessage(event.threadId, event.messageId, {
      card: Card({ title: 'Approval', children: [CardText(`${text}  ·  ${stamp}`)] }),
      fallbackText: text,
    });
  } catch (err) {
    deps.warn('Approvals: could not update the card (the decision was still recorded)', err);
  }
  return true;
}
