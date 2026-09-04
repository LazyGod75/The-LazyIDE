/**
 * lib/grader.mjs — grading.
 *
 * Primary grade: deterministic required-terms match. Ground truths in
 * questions.json were written as specific identifiers/values (function
 * names, flags, numbers) precisely so "does the answer contain all of
 * these" is a legitimate exact-match proxy, not a fuzzy stand-in — this is
 * the "exact-match where possible" arm of the design brief.
 *
 * Secondary (optional, off by default — see run.mjs --judge): an LLM judge
 * against a fixed rubric, callable multiple times so judge noise can be
 * averaged out. Implemented so a fuller run can turn it on; NOT exercised
 * in the pilot bundled with this commit (time-boxed — see README-FIXTURE).
 */

import { callRawPrompt } from './answerModel.mjs';

export function gradeKeywordMatch(answerText, groundTruth) {
  const lower = (answerText || '').toLowerCase();
  const hits = groundTruth.requiredTerms.map((term) => ({
    term,
    present: lower.includes(term.toLowerCase()),
  }));
  const presentCount = hits.filter((h) => h.present).length;
  return {
    correct: presentCount === hits.length,
    presentCount,
    totalTerms: hits.length,
    hits,
  };
}

const JUDGE_PROMPT = (question, groundTruth, candidateAnswer) =>
  `You are grading whether a CANDIDATE ANSWER correctly answers a QUESTION, given a REFERENCE ANSWER ` +
  `that is known to be correct. Grade strictly on factual correctness of the specific claims asked for ` +
  `(names, values, mechanisms) — wording does not need to match. Reply with EXACTLY one line: ` +
  `"VERDICT: correct" or "VERDICT: incorrect", optionally followed by a one-sentence reason.\n\n` +
  `QUESTION: ${question}\n\nREFERENCE ANSWER: ${groundTruth.answer}\n\nCANDIDATE ANSWER: ${candidateAnswer}\n\nVERDICT:`;

/**
 * Run the LLM judge `runs` times (default 3) against a fixed rubric and
 * majority-vote. Not used by the bundled pilot results but implemented and
 * unit-exercisable for a fuller run.
 */
export function gradeLlmJudge(question, groundTruth, candidateAnswer, { runs = 3, model = 'haiku' } = {}) {
  const verdicts = [];
  for (let i = 0; i < runs; i++) {
    const prompt = JUDGE_PROMPT(question, groundTruth, candidateAnswer);
    const { text } = callRawPrompt(prompt, model);
    const correct = /verdict:\s*correct/i.test(text);
    verdicts.push({ raw: text, correct });
  }
  const correctVotes = verdicts.filter((v) => v.correct).length;
  return {
    correct: correctVotes > runs / 2,
    correctVotes,
    runs,
    verdicts,
  };
}
