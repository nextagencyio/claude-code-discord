/**
 * Button handlers for Discord bot interactions.
 * Only expand/collapse buttons remain for truncated content viewing.
 *
 * @module core/button-handlers
 */

import type { ButtonHandlers, InteractionContext } from "../discord/index.ts";

/**
 * Expandable content storage (shared with claude handlers).
 */
export type ExpandableContentMap = Map<string, string>;

/**
 * Dependencies for button handler creation.
 */
export interface ButtonHandlerDeps {
  // Currently no deps needed — kept for future extensibility
}

/**
 * Create button handlers for Discord interactions.
 * Only handles expand/collapse for truncated content.
 */
export function createButtonHandlers(
  _deps: ButtonHandlerDeps,
  expandableContent: ExpandableContentMap
): ButtonHandlers {
  const buttonHandlers: ButtonHandlers = new Map([
    // Collapse expanded content
    ['collapse-content', async (ctx: InteractionContext) => {
      await ctx.update({
        embeds: [{
          color: 0x808080,
          title: '🔼 Content Collapsed',
          description: 'Content has been collapsed. Use the expand button to view it again.',
          timestamp: true
        }],
        components: []
      });
    }],
  ]);

  return buttonHandlers;
}

/**
 * Create the expand content button handler (separate due to prefix-matched IDs).
 * This handles the 'expand:' prefixed button IDs.
 */
export function createExpandButtonHandler(
  expandableContent: ExpandableContentMap
): (ctx: InteractionContext, customId: string) => Promise<void> {
  return async (ctx: InteractionContext, customId: string) => {
    if (!customId.startsWith('expand:')) return;

    const expandId = customId.substring(7);
    const fullContent = expandableContent.get(expandId);

    if (!fullContent) {
      await ctx.update({
        embeds: [{
          color: 0xffaa00,
          title: '📖 Content Not Available',
          description: 'The full content is no longer available for expansion.',
          timestamp: true
        }],
        components: []
      });
      return;
    }

    const maxLength = 4090 - "```\n\n```".length;
    if (fullContent.length <= maxLength) {
      await ctx.update({
        embeds: [{
          color: 0x0099ff,
          title: '📖 Full Content',
          description: expandId.startsWith('result-') ?
            `\`\`\`\n${fullContent}\n\`\`\`` :
            `\`\`\`json\n${fullContent}\n\`\`\``,
          timestamp: true
        }],
        components: [{
          type: 'actionRow',
          components: [{
            type: 'button',
            customId: 'collapse-content',
            label: '🔼 Collapse',
            style: 'secondary'
          }]
        }]
      });
    } else {
      const chunk = fullContent.substring(0, maxLength - 100);
      await ctx.update({
        embeds: [{
          color: 0x0099ff,
          title: '📖 Full Content (Large - Showing First Part)',
          description: expandId.startsWith('result-') ?
            `\`\`\`\n${chunk}...\n\`\`\`` :
            `\`\`\`json\n${chunk}...\n\`\`\``,
          fields: [
            { name: 'Note', value: 'Content is very large. This shows the first portion.', inline: false }
          ],
          timestamp: true
        }],
        components: [{
          type: 'actionRow',
          components: [{
            type: 'button',
            customId: 'collapse-content',
            label: '🔼 Collapse',
            style: 'secondary'
          }]
        }]
      });
    }
  };
}
