/* assistantIdentity.ts — optional theming/quick-action contract that lets a
   host space (Code space, D8) reskin the shared AssistantPanel to a
   distinct visual identity (cyan "Assistant Code") and inject file-context
   quick actions, WITHOUT forking the panel or its real chat/streaming
   wiring. Every field is optional and additive — omitting `identity`/
   `quickActions` reproduces the exact pre-existing AssistantPanel used by
   AgentsSpace/SettingsSpace today.
*/

export interface AssistantIdentityStatusLine {
  projectColor: string;
  filePath: string;
  diffStat?: string;
}

export interface AssistantIdentity {
  title: string;
  tagline: string;
  avatarLetter: string;
  avatarGradient: string;
  accentColor: string;
  statusLine?: AssistantIdentityStatusLine | null;
}

export interface AssistantQuickAction {
  id: string;
  label: string;
  /** 'send' routes buildText's output through the real chat pipeline
   *  (Composer's send()) — a genuine LLM turn, never a canned reply.
   *  'launch' emits the real `agent:launch` bus event with buildText's
   *  output as the task. */
  kind: 'send' | 'launch';
  buildText: (composerText: string) => string;
}
