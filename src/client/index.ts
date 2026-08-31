/**
 * dsh-feishu — browser half. Registers the Feishu settings panel into the
 * web settings page (settings.section entry). The panel configures the
 * Feishu app credentials, shows connection status, and drives connection
 * tests. Failure policy: registration problems are logged, never thrown —
 * the web shell fails the whole boot when a plugin apply throws, and an
 * external plugin must not take the GUI down.
 */
// Type-only: pulls the settings-surface SlotMap merge (the 'settings.section'
// entry) and the client runtime Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { FeishuPanel } from './FeishuPanel.tsx'

/** Required services. */
export const inject = ['slots']

/**
 * Register the Feishu settings page.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  try {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'feishu-mcp',
      order: 330,
      label: () => '飞书',
    }, FeishuPanel))
  } catch (error) {
    console.warn('[dsh-feishu] settings panel registration failed:', error)
  }
}
