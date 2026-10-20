// Explicit question routing. The category decides which evidence an answer may use:
//   architecture / capability -> retrieval over the approved corpus
//   data / interpretation     -> needs computation over authorized data; the validated data tools are planned
//                                (ADR 0018), so today these are declined with a pointer, never answered from prose
//   unsupported               -> no evidence path

export type Category = 'architecture' | 'capability' | 'data' | 'interpretation' | 'unsupported';

const DESIGN = /\b(why|design|architect\w*|decision|tradeoff|trade-off|alternative|how does|how do|work|works|boundary|enforce\w*|secur\w*|fail\w*|schedul\w*|retr\w*|vector|authori[sz]\w*|isolat\w*|reconcil\w*|validat\w*|explain|diagram|component|pipeline|scale|production|compliance|hipaa)\b/i;
const CAPABILITY = /\b(what can i|which (scenarios|capabilit|features)|capabilit\w*|implemented|verified|planned|status|supported|demo scenario|what does this screen|what am i looking at|what is clearline|what does clearline)\b/i;
const NUMERIC = /\b(how many|how much|total|count|sum|average|mean|median|rate|percent\w*|number of|last (week|month|quarter|year|\d+ (days|weeks|months))|this (week|month|year)|yesterday|compared? (to|with)|versus|vs\.?|largest|biggest|highest|lowest|top \d+|trend)\b/i;
const DATA_NOUN = /\b(claims?|members?|enrollees?|batch(es)?|paid|billed|rejected|rejection|quarantine\w*|pharmacy|fills?|plans?|amount|metrics?|rows?|records?)\b/i;
const INTERPRET = /\b(is (this|that|it) (change |result |spike |value )?(unusual|anomal\w*|normal)|how strong is|what (evidence )?supports (this|that)|other explanations|what caused|why did (the|this) (value|number|rate|metric|total))\b/i;

export function classify(q: string): Category {
  const s = q.trim();
  if (!s) return 'unsupported';
  if (INTERPRET.test(s) && !/\b(algorithm|method|how does)\b/i.test(s)) return 'interpretation';
  if (NUMERIC.test(s) && DATA_NOUN.test(s) && !DESIGN.test(s)) return 'data';
  if (CAPABILITY.test(s)) return 'capability';
  return 'architecture';
}
