import { splitText } from "../discord/utils.ts";
import type { ClaudeMessage } from "./types.ts";
import type { MessageContent } from "../discord/types.ts";

// Discord sender interface for dependency injection
export interface DiscordSender {
  sendMessage(content: MessageContent): Promise<void>;
}

// Store full content for expand functionality
export const expandableContent = new Map<string, string>();

// Image file extensions
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

function isImagePath(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return IMAGE_EXTENSIONS.has(ext);
}

// Create sendClaudeMessages function with dependency injection
export function createClaudeSender(sender: DiscordSender) {
  return async function sendClaudeMessages(messages: ClaudeMessage[]) {
  for (const msg of messages) {
    switch (msg.type) {
      case 'text': {
        // Always show assistant text responses
        const chunks = splitText(msg.content, 4000);
        for (let i = 0; i < chunks.length; i++) {
          await sender.sendMessage({
            embeds: [{
              color: 0x00ff00,
              title: chunks.length > 1 ? `Assistant (${i + 1}/${chunks.length})` : 'Assistant',
              description: chunks[i],
              timestamp: true
            }]
          });
        }
        break;
      }

      case 'tool_use': {
        const toolName = msg.metadata?.name || 'Unknown';

        // Tool invocations are not shown in Discord — they're mechanics, not
        // conversation. The channel carries assistant text only.
        //
        // Sole exception: a Read that targets an image file, which is how an
        // image actually gets attached into the channel for the user to see.
        if (toolName === 'Read' && msg.metadata?.input?.file_path && isImagePath(msg.metadata.input.file_path)) {
          const filePath = msg.metadata.input.file_path;
          const fileName = filePath.split('/').pop() || 'image.png';
          await sender.sendMessage({
            embeds: [{
              color: 0x0099ff,
              title: `Image: ${fileName}`,
              description: `\`${filePath}\``,
              timestamp: true
            }],
            files: [{ path: filePath, name: fileName }]
          });
        }
        break;
      }

      case 'tool_result': {
        // Skip tool results — they're internal output Claude reads, not useful in Discord
        break;
      }

      case 'thinking': {
        // Skip thinking blocks — internal reasoning, too verbose for Discord
        break;
      }

      case 'system': {
        // Sub-agent heartbeat — show "still working" status
        if (msg.metadata?.subtype === 'heartbeat') {
          const elapsed = msg.metadata.elapsed_ms || 0;
          const minutes = Math.floor(elapsed / 60000);
          const agents = msg.metadata.pending_subagents || 1;
          await sender.sendMessage({
            embeds: [{
              color: 0xffaa00,
              title: `Sub-agent Working (${minutes}m elapsed)`,
              description: `${agents} sub-agent${agents > 1 ? 's' : ''} running.`,
              timestamp: true
            }]
          });
          break;
        }

        if (msg.metadata?.subtype === 'shutdown') {
          await sender.sendMessage({
            embeds: [{
              color: 0xff0000,
              title: 'Shutdown',
              description: `Bot stopped by signal ${msg.metadata.signal}`,
              fields: [
                { name: 'Category', value: msg.metadata.categoryName, inline: true },
                { name: 'Repository', value: msg.metadata.repoName, inline: true },
                { name: 'Branch', value: msg.metadata.branchName, inline: true }
              ],
              timestamp: true
            }]
          });
          break;
        }

        // Skip all other system messages (init, hook_started, hook_response,
        // completion, thinking_tokens, ...) — noise in the channel
        break;
      }

      case 'other': {
        // Skip miscellaneous content — rarely useful
        break;
      }
    }
  }
  };
}