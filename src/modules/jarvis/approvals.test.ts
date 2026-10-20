import { describe, expect, it, vi } from 'vitest';

import { ACTION_ID, approvalContent, handleApprovalAction, syncApprovals, type ApprovalDeps } from './approvals.js';

const make = (over: Partial<ApprovalDeps> = {}, sync: unknown = { post: [], expired: [] }) => {
  const calls: { path: string; body?: unknown }[] = [];
  const posted: { kind: string; content: string }[] = [];
  const deps: ApprovalDeps = {
    data: async (path, body) => {
      calls.push({ path, body });
      if (path === '/host/approvals/sync') return sync;
      if (path === '/host/approvals/decide') return { ok: true, text: '✅ Approved: Publish the theme' };
      return { ok: true };
    },
    post: async (kind, content) => {
      posted.push({ kind, content });
      return '4242';
    },
    ownerId: () => '555',
    now: () => new Date('2026-10-20T17:05:00Z'),
    warn: () => undefined,
    ...over,
  };
  return { deps, calls, posted };
};
const request = {
  id12: 'abcdef012345',
  title: 'Approval needed: qaaf',
  question: 'Publish the theme\n\nExpires in 30 minutes.',
};
const event = (actionId: string, userId = '555') =>
  ({ actionId, value: '0', user: { userId }, threadId: 'telegram:-100:25', messageId: 'm9' }) as any;
const adapter = () => ({ editMessage: vi.fn(async () => undefined) }) as any;

describe('the card', () => {
  it('is an ask_question card with Approve and Reject, identified by the request id', () => {
    const c = JSON.parse(approvalContent(request));
    expect(c).toMatchObject({
      type: 'ask_question',
      questionId: 'jv-appr-abcdef012345',
      title: 'Approval needed: qaaf',
    });
    expect(c.options.map((o: any) => o.label)).toEqual(['✅ Approve', '❌ Reject']);
    expect(c.question).toContain('Publish the theme');
  });
  it('the action pattern matches only our ids', () => {
    expect(ACTION_ID.test('ncq:jv-appr-abcdef012345:0')).toBe(true);
    expect(ACTION_ID.test('ncq:jv-appr-abcdef012345:1')).toBe(true);
    for (const id of [
      'ncq:jv-appr-abcdef012345:2',
      'ncq:jv-appr-abcdef01234:0',
      'ncq:jv-appr-ABCDEF012345:0',
      'ncq:jv-log-abc123:0',
      'ncq:x:0',
    ])
      expect(ACTION_ID.test(id), id).toBe(false);
  });
});

describe('the poll', () => {
  it('posts a card for each new request and records it, so it is not posted twice', async () => {
    const { deps, calls, posted } = make({}, { post: [request], expired: [] });
    await syncApprovals(deps);
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0]!.content).questionId).toBe('jv-appr-abcdef012345');
    expect(calls.map((c) => c.path)).toEqual(['/host/approvals/sync', '/host/approvals/posted']);
    expect(calls[1]!.body).toEqual({ id12: 'abcdef012345', message_id: '4242' });
  });
  it('tells the owner about a request that expired unanswered, naming what was NOT done', async () => {
    const { deps, posted } = make({}, { post: [], expired: [{ id12: 'aaaaaaaaaaaa', action: 'Email the professor' }] });
    await syncApprovals(deps);
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0]!.content).text).toMatch(/expired and was not done: Email the professor/);
  });
  it('does nothing when there is nothing to do', async () => {
    const { deps, posted, calls } = make();
    await syncApprovals(deps);
    expect(posted).toEqual([]);
    expect(calls).toHaveLength(1);
  });
  it('never throws when the data service is down or posting fails, and warns instead', async () => {
    const warn = vi.fn();
    await expect(
      syncApprovals(
        make({
          warn,
          data: async () => {
            throw new Error('ECONNREFUSED');
          },
        }).deps,
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    const warn2 = vi.fn();
    await expect(
      syncApprovals(
        make(
          {
            warn: warn2,
            post: async () => {
              throw new Error('telegram down');
            },
          },
          { post: [request], expired: [] },
        ).deps,
      ),
    ).resolves.toBeUndefined();
    expect(warn2).toHaveBeenCalled();
  });
  it('does not mark a request as posted when posting failed (so it is tried again)', async () => {
    const { deps, calls } = make(
      {
        post: async () => {
          throw new Error('telegram down');
        },
      },
      { post: [request], expired: [] },
    );
    await syncApprovals(deps);
    expect(calls.map((c) => c.path)).toEqual(['/host/approvals/sync']);
  });
});

describe('a tap', () => {
  it('Approve sends the decision for that request and replaces the card with the result', async () => {
    const { deps, calls } = make();
    const a = adapter();
    expect(await handleApprovalAction(event('ncq:jv-appr-abcdef012345:0'), a, deps)).toBe(true);
    expect(calls[0]).toEqual({ path: '/host/approvals/decide', body: { id12: 'abcdef012345', decision: 'approved' } });
    const [tid, mid, content] = a.editMessage.mock.calls[0];
    expect([tid, mid]).toEqual(['telegram:-100:25', 'm9']);
    expect(JSON.stringify(content.card)).toContain('Approved: Publish the theme');
    expect(JSON.stringify(content.card)).not.toContain('ncq:'); // no buttons left to tap again
  });
  it('Reject sends the opposite decision', async () => {
    const { deps, calls } = make();
    await handleApprovalAction(event('ncq:jv-appr-abcdef012345:1'), adapter(), deps);
    expect(calls[0]!.body).toEqual({ id12: 'abcdef012345', decision: 'rejected' });
  });
  it('does not claim events that are not ours', async () => {
    const { deps, calls } = make();
    expect(await handleApprovalAction(event('ncq:jv-log-abc123:0'), adapter(), deps)).toBe(false);
    expect(calls).toEqual([]);
  });
  it('a tap by anyone but the owner decides nothing and changes nothing', async () => {
    const { deps, calls } = make();
    const a = adapter();
    expect(await handleApprovalAction(event('ncq:jv-appr-abcdef012345:0', '999'), a, deps)).toBe(true);
    expect(calls).toEqual([]);
    expect(a.editMessage).not.toHaveBeenCalled();
  });
  it('does nothing when no owner is configured', async () => {
    const { deps, calls } = make({ ownerId: () => undefined });
    expect(await handleApprovalAction(event('ncq:jv-appr-abcdef012345:0'), adapter(), deps)).toBe(true);
    expect(calls).toEqual([]);
  });
  it('keeps the buttons when the data service is unreachable, so he can tap again', async () => {
    const { deps } = make({
      data: async () => {
        throw new Error('down');
      },
    });
    const a = adapter();
    expect(await handleApprovalAction(event('ncq:jv-appr-abcdef012345:0'), a, deps)).toBe(true);
    expect(a.editMessage).not.toHaveBeenCalled();
  });
  it('survives Telegram refusing the card edit: the decision is already recorded', async () => {
    const warn = vi.fn();
    const { deps } = make({ warn });
    const a = {
      editMessage: vi.fn(async () => {
        throw new Error('message is not modified');
      }),
    } as any;
    expect(await handleApprovalAction(event('ncq:jv-appr-abcdef012345:0'), a, deps)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
  it('shows "already decided" text from the server when a second tap arrives', async () => {
    const { deps } = make({ data: async () => ({ ok: false, text: 'Already decided or expired.' }) });
    const a = adapter();
    await handleApprovalAction(event('ncq:jv-appr-abcdef012345:0'), a, deps);
    expect(JSON.stringify(a.editMessage.mock.calls[0][2].card)).toContain('Already decided or expired.');
  });
});
