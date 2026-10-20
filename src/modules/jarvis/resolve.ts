/**
 * Jarvis: which agent group and which model a session will run with. The group's own model wins; NANOCLAW_DEFAULT_MODEL fills in for a
 * group with none (the same rule NanoClaw uses when it builds the container config). No model at all returns undefined, and the
 * budget check refuses that: the SDK would otherwise pick one, possibly an unapproved one.
 */
import { DEFAULT_MODEL } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import type { Session } from '../../types.js';

export async function resolveSession(session: Session): Promise<{ group: string; model: string | undefined } | null> {
  const group = await getAgentGroup(session.agent_group_id);
  if (!group) return null;
  const config = await getContainerConfig(group.id);
  return { group: group.name, model: config?.model ?? (DEFAULT_MODEL || undefined) };
}
