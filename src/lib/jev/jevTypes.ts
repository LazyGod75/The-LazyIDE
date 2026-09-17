/* jevTypes.ts — contract types for the TypeSafe Jev integration.

   Jev is a bounded semantic-judgment primitive (System One model), NOT a
   generative LLM: it takes a JSON `state` plus typed `questions` and
   returns structured answers with calibrated probabilities and confidence.
   Everything in this module mirrors https://docs.typesafe.ai (verify the
   live docs before changing the wire format — do not invent fields).

   LazyIDE rule (open-source constraint): Jev is a BYOK, opt-in
   ENHANCEMENT layer. No core path may depend on it — every call site
   must stay functional (deterministic fallback) when no key is set.
*/

export type JevQuestionType = 'noul' | 'choice' | 'score';

/** One question sent to /v1/systemone. `instructions` may be a plain
 *  string or a JSON object/array of strings (state fragments). `criteria`
 *  is type-dependent: a map of option→description for `choice`, an array
 *  of level descriptions for `score`, a {true,false} pair for `noul`. */
export interface JevQuestion {
  type: JevQuestionType;
  instructions: unknown;
  criteria?: unknown;
}

export interface JevNoulAnswer {
  type: 'noul';
  /** P(yes) in [0,1] — calibrated probability, not a logit. */
  noul: number;
}

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface JevScoreAnswer {
  type: 'score';
  /** Index into the score levels. */
  score: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export const JEV_DEFAULT_MODEL = 'jev-latest';

/** Default per-request timeout — the enhancement paths budget ~400ms and
 *  the interactive tool path ~2s; individual callers override. */
export const JEV_DEFAULT_TIMEOUT_MS = 4_000;
