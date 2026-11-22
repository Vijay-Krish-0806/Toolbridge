/**
 * @toolbridge/chat-widget: load this module once and `<toolbridge-chat>` is available.
 * `RunClient` is exported too, for hosts that want their own UI on the same run API.
 */
import { ToolbridgeChat } from './element.js';

export { RunApiError, RunClient, type GetToken, type SessionToken } from './client.js';
export { ToolbridgeChat } from './element.js';

if (typeof customElements !== 'undefined' && !customElements.get('toolbridge-chat')) {
  customElements.define('toolbridge-chat', ToolbridgeChat);
}
