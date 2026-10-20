// Tiny event bus so any page can open the assistant with a page context and an optional prefilled question,
// without coupling components to the assistant's state.
export interface AssistantContext { component?: string; capability?: string; decision?: string; view?: string }
export interface OpenRequest { context: AssistantContext; question?: string }
const EVT = 'clearline:assistant-open';
export function openAssistant(context: AssistantContext = {}, question?: string) { window.dispatchEvent(new CustomEvent<OpenRequest>(EVT, { detail: { context, question } })); }
export function onOpenAssistant(fn: (r: OpenRequest) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<OpenRequest>).detail);
  window.addEventListener(EVT, h); return () => window.removeEventListener(EVT, h);
}
