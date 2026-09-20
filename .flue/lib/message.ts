/**
 * Channel-neutral boundary between an inbound connector and the agent.
 *
 * Connectors authenticate the sender and resolve the tenant before creating
 * this envelope. The model never receives a user-controlled tenant selector.
 */
export type ChannelName = "telegram" | "whatsapp" | "imessage" | "web" | "mcp";

export type AgentAttachment = {
  kind: "image" | "audio" | "file";
  base64?: string;
  mimeType?: string;
  externalId?: string;
};

export type AgentMessage = {
  tenantId: string;
  channel: ChannelName;
  externalMessageId: string;
  text: string;
  attachments?: AgentAttachment[];
};

/** Keep tenant IDs safe as Redis/session key components. */
export function assertTenantId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_+.@-]{0,127}$/.test(value)) {
    throw new Error("Invalid tenant identity");
  }
  return value;
}

export function toAgentMessage(message: AgentMessage): AgentMessage {
  return {
    ...message,
    tenantId: assertTenantId(message.tenantId),
    externalMessageId: message.externalMessageId.slice(0, 256),
    text: message.text.slice(0, 32_000),
  };
}
