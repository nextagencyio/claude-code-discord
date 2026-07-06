import { splitText } from "../discord/utils.ts";
import type { ClaudeMessage } from "./types.ts";
import type { MessageContent, EmbedData } from "../discord/types.ts";

// Discord sender interface for dependency injection
export interface DiscordSender {
  sendMessage(content: MessageContent): Promise<void>;
}

// Store full content for expand functionality
export const expandableContent = new Map<string, string>();

// Helper function to truncate content with smart preview
function truncateContent(content: string, maxLines = 15, maxChars = 1000): { preview: string; isTruncated: boolean; totalLines: number } {
  const lines = content.split('\n');
  const totalLines = lines.length;
  const truncatedLines = lines.slice(0, maxLines);
  const preview = truncatedLines.join('\n');

  if (preview.length > maxChars) {
    return {
      preview: preview.substring(0, maxChars - 3) + '...',
      isTruncated: true,
      totalLines
    };
  }

  return {
    preview,
    isTruncated: lines.length > maxLines,
    totalLines
  };
}

// Image file extensions
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

function isImagePath(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return IMAGE_EXTENSIONS.has(ext);
}

// Tools whose invocations are high-signal enough to show in Discord.
// Everything else (Read, Glob, Grep, WebFetch, WebSearch, etc.) is skipped.
const HIGH_SIGNAL_TOOLS = new Set([
  'Edit', 'Write', 'NotebookEdit',  // Code changes
  'Bash',                            // Shell commands
  'TodoWrite',                       // Task tracking
  'Task',                            // Sub-agent spawning
]);

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

        // Skip low-signal tools (Read, Glob, Grep, etc.)
        if (!HIGH_SIGNAL_TOOLS.has(toolName)) {
          // Exception: show Read when it targets an image file (attaches the image)
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

        if (toolName === 'TodoWrite') {
          const todos = msg.metadata?.input?.todos || [];
          const statusEmojis: Record<string, string> = {
            pending: '⏳',
            in_progress: '🔄',
            completed: '✅'
          };

          let todoList = '';
          if (todos.length === 0) {
            todoList = 'Task list is empty';
          } else {
            for (const todo of todos) {
              const statusEmoji = statusEmojis[todo.status] || '❓';
              todoList += `${statusEmoji} **${todo.content}**\n`;
            }
          }

          await sender.sendMessage({
            embeds: [{
              color: 0x9932cc,
              title: 'Todo List Updated',
              description: todoList,
              timestamp: true
            }]
          });
        } else if (toolName === 'Edit') {
          const filePath = msg.metadata.input?.file_path || 'Unknown file';
          const oldString = msg.metadata.input?.old_string || '';
          const newString = msg.metadata.input?.new_string || '';

          const fields = [
            { name: 'File', value: `\`${filePath}\``, inline: false }
          ];

          if (oldString) {
            const { preview: oldPreview } = truncateContent(oldString, 2, 80);
            fields.push({ name: 'Replacing', value: `\`\`\`\n${oldPreview}\n\`\`\``, inline: false });
          }
          if (newString) {
            const { preview: newPreview } = truncateContent(newString, 2, 80);
            fields.push({ name: 'With', value: `\`\`\`\n${newPreview}\n\`\`\``, inline: false });
          }

          await sender.sendMessage({
            embeds: [{
              color: 0xffaa00,
              title: 'Edit',
              fields,
              timestamp: true
            }]
          });
        } else if (toolName === 'Write') {
          const filePath = msg.metadata.input?.file_path || 'Unknown file';
          const content = msg.metadata.input?.content || '';
          const lineCount = content.split('\n').length;

          await sender.sendMessage({
            embeds: [{
              color: 0xffaa00,
              title: 'Write',
              description: `\`${filePath}\` (${lineCount} lines)`,
              timestamp: true
            }]
          });
        } else if (toolName === 'Bash') {
          const command = msg.metadata.input?.command || '';
          const { preview } = truncateContent(command, 3, 300);

          await sender.sendMessage({
            embeds: [{
              color: 0x0099ff,
              title: 'Bash',
              description: `\`\`\`bash\n${preview}\n\`\`\``,
              timestamp: true
            }]
          });
        } else if (toolName === 'Task') {
          const desc = msg.metadata.input?.description || msg.metadata.input?.prompt?.substring(0, 100) || 'Sub-agent task';

          await sender.sendMessage({
            embeds: [{
              color: 0x9b59b6,
              title: 'Sub-agent Spawned',
              description: desc,
              timestamp: true
            }]
          });
        } else {
          // Fallback for other high-signal tools (NotebookEdit, etc.)
          const inputStr = JSON.stringify(msg.metadata.input || {}, null, 2);
          const { preview } = truncateContent(inputStr, 3, 200);

          await sender.sendMessage({
            embeds: [{
              color: 0x0099ff,
              title: `Tool: ${toolName}`,
              description: `\`\`\`json\n${preview}\n\`\`\``,
              timestamp: true
            }]
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
        // Skip pure telemetry subtypes — token accounting, not reader-facing
        if (msg.metadata?.subtype === 'thinking_tokens') {
          break;
        }

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

        const embedData: EmbedData = {
          color: msg.metadata?.subtype === 'completion' ? 0x00ff00 : 0xaaaaaa,
          title: msg.metadata?.subtype === 'completion' ? 'Claude Code Complete' : `System: ${msg.metadata?.subtype || 'info'}`,
          timestamp: true,
          fields: []
        };

        if (msg.metadata?.model) {
          embedData.fields!.push({ name: 'Model', value: msg.metadata.model, inline: true });
        }
        if (msg.metadata?.total_cost_usd !== undefined) {
          embedData.fields!.push({ name: 'Cost', value: `$${msg.metadata.total_cost_usd.toFixed(4)}`, inline: true });
        }
        if (msg.metadata?.duration_ms !== undefined) {
          embedData.fields!.push({ name: 'Duration', value: `${(msg.metadata.duration_ms / 1000).toFixed(2)}s`, inline: true });
        }

        // Special handling for shutdown
        if (msg.metadata?.subtype === 'shutdown') {
          embedData.color = 0xff0000;
          embedData.title = 'Shutdown';
          embedData.description = `Bot stopped by signal ${msg.metadata.signal}`;
          embedData.fields = [
            { name: 'Category', value: msg.metadata.categoryName, inline: true },
            { name: 'Repository', value: msg.metadata.repoName, inline: true },
            { name: 'Branch', value: msg.metadata.branchName, inline: true }
          ];
        }

        await sender.sendMessage({ embeds: [embedData] });
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