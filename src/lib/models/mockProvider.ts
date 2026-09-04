/* Mock provider — simulates brain-cited streaming responses */

import type { ModelProvider, ModelInfo, StreamChatRequest } from './types.js';
import { ALL_MODELS } from './registry.js';

// Canned responses varied by mode
const ASK_RESPONSE = [
  "D'après la décision du 14/03 ",
  '#auth-oauth',
  ", les handlers ont été unifiés après le bug ",
  '#bug-342',
  " pour éviter la duplication de logique d'authentification. ",
  "L'héritage de `BaseHandler` garantit que chaque handler expose les méthodes `authenticate()` et `authorize()` avec la même signature, ce qui permet à l'orchestrateur d'appels en cascade de rester générique.\n\n",
  "Voir aussi `auth.ts` ligne 42 pour l'implémentation concrète.",
];

const PLAN_RESPONSE = [
  "Voici un plan basé sur le contexte brain ",
  '#auth-oauth',
  " et la décision d'architecture ",
  '#bug-342',
  " :\n\n",
  "**Étape 1** — Extraire l'interface `IHandler` de `BaseHandler`\n",
  "**Étape 2** — Migrer `auth.ts` pour implémenter `IHandler` directement\n",
  "**Étape 3** — Mettre à jour les tests unitaires dans `auth.test.ts`\n",
  "**Étape 4** — Vérifier la compatibilité avec l'orchestrateur\n\n",
  "Estimation : 45 min · Impact : faible risque",
];

const EDIT_RESPONSE = [
  "Voici la modification suggérée (basée sur ",
  '#auth-oauth',
  ") :\n\n",
  '```typescript\n',
  '// auth.ts — ligne 42\n',
  'export class AuthHandler extends BaseHandler {\n',
  '  authenticate(token: string): Promise<User> {\n',
  '    return this.verifyJwt(token);\n',
  '  }\n',
  '}\n',
  '```\n\n',
  "Appuie sur **Appliquer** pour injecter ce bloc dans l'éditeur.",
];

// 'transform' mode (Ctrl+K inline-edit, auto-fix) is a non-agentic code
// transform — the caller treats the ENTIRE response as literal replacement
// code (see codeOutputSanitizer.ts), unlike EDIT_RESPONSE above which is
// conversational chat narration around a fence. Falling through to
// ASK_RESPONSE for this mode would feed prose into the sanitizer and break
// the web-demo Ctrl+K path, so it gets its own plain-code canned response.
const TRANSFORM_RESPONSE = [
  'export class AuthHandler extends BaseHandler {\n',
  '  authenticate(token: string): Promise<User> {\n',
  '    return this.verifyJwt(token);\n',
  '  }\n',
  '}\n',
];

function getTokens(mode: string): string[] {
  if (mode === 'plan') return PLAN_RESPONSE;
  if (mode === 'edit') return EDIT_RESPONSE;
  if (mode === 'transform') return TRANSFORM_RESPONSE;
  return ASK_RESPONSE;
}

async function* streamTokens(tokens: string[]): AsyncIterable<string> {
  for (const token of tokens) {
    await new Promise<void>(resolve => setTimeout(resolve, 60 + Math.random() * 80));
    yield token;
  }
}

export const mockProvider: ModelProvider = {
  id: 'mock',
  label: 'Mock Provider',

  listModels(): ModelInfo[] {
    return ALL_MODELS;
  },

  async *streamChat(req: StreamChatRequest): AsyncIterable<string> {
    const tokens = getTokens(req.mode);
    for await (const token of streamTokens(tokens)) {
      if (req.signal?.aborted) return;
      yield token;
    }
  },
};
