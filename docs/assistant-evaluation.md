# Assistant retrieval evaluation

Measured, not claimed. Produced by `npm run assistant:eval` (add `-- --write` to refresh this file) against the index described below.

| | |
|---|---|
| Embedding provider / model | local / Xenova/all-MiniLM-L6-v2 (384 dimensions) |
| Corpus version | `9147614ff53d247f` (255 chunks) |
| Retrieval depth (k) | 6 |
| Evidence threshold | 0.3 cosine similarity |
| Questions with known sources | 26 |
| **Recall@6** (at least one expected source in the top 6) | **96%** (25/26) |
| Mean reciprocal rank | 0.85 |
| Unsupported questions correctly declined (best score below threshold) | 3/3 |
| By kind | component: 4/4; tradeoff: 5/5; security: 3/3; capability: 3/3; multi-document: 2/2; conflicting-or-obsolete: 2/2; paraphrase: 6/7 |

The set is small and was written by the authors of the corpus, so it measures regression and coarse quality, not general accuracy. Retrieval is evaluated separately from answer grounding: grounding and citation checks are in `test/unit/assistant.test.ts` and `test/integration/assistant.test.ts`.

## Per question

| Id | Kind | Question | Rank of first expected source | Best score | Result |
|---|---|---|---|---|---|
| c1 | component | Where is authorization enforced in Clearline? | 1 | 0.49 | pass |
| c2 | component | What does the worker do when it claims a batch? | 1 | 0.50 | pass |
| c3 | component | How does the query workspace stop a model from running dangerous SQL? | 1 | 0.58 | pass |
| c4 | component | What happens to a delivery if the recipient lost access after the query ran? | 1 | 0.50 | pass |
| t1 | tradeoff | Why is PostgreSQL the work queue instead of a message broker? | 1 | 0.51 | pass |
| t2 | tradeoff | When would a data warehouse become justified? | 1 | 0.49 | pass |
| t3 | tradeoff | Why use statistical baselines instead of a machine-learning model for anomalies? | 1 | 0.51 | pass |
| t4 | tradeoff | Why separate vector retrieval from SQL for the assistant? | 1 | 0.63 | pass |
| t5 | tradeoff | What are the costs of a modular monolith? | 1 | 0.44 | pass |
| s1 | security | How is tenant isolation enforced if the application has a bug? | 1 | 0.69 | pass |
| s2 | security | Why are permissions rechecked when a scheduled run executes? | 1 | 0.58 | pass |
| s3 | security | Is Clearline HIPAA compliant? | 1 | 0.57 | pass |
| k1 | capability | Is scheduled delivery implemented and how was it verified? | 1 | 0.45 | pass |
| k2 | capability | Which demonstration scenarios cover reconciliation failures? | 1 | 0.53 | pass |
| k3 | capability | Can the assistant answer questions about current claim totals? | 1 | 0.59 | pass |
| m1 | multi-document | How does Clearline decide that a batch can be trusted? | 1 | 0.60 | pass |
| m2 | multi-document | What happens if a worker crashes in the middle of processing a batch? | 1 | 0.51 | pass |
| x1 | conflicting-or-obsolete | Does the API serve any browser content? | 1 | 0.47 | pass |
| x2 | conflicting-or-obsolete | Is the web client covered by the recorded scenario suite? | 1 | 0.51 | pass |
| n1 | no-answer | What is the best pizza topping? | n/a | 0.17 | pass |
| n2 | no-answer | How do I train a neural network in PyTorch? | n/a | 0.13 | pass |
| n3 | no-answer | What is the stock price of Anthropic? | n/a | 0.18 | pass |
| p1 | paraphrase | What stops two workers from grabbing the same job? | 4 | 0.32 | pass |
| p2 | paraphrase | If the database server dies halfway through a run, do I end up with half-loaded data? | not in top 6 | 0.30 | **miss** |
| p3 | paraphrase | Who gets to sign off on a schema change that could break downstream consumers? | 5 | 0.44 | pass |
| p4 | paraphrase | How do you keep a chatbot from making up numbers? | 1 | 0.34 | pass |
| p5 | paraphrase | Does any of this need an internet connection or paid AI to work? | 4 | 0.40 | pass |
| p6 | paraphrase | Can I trust it when the system flags an unusual spike? | 2 | 0.36 | pass |
| p7 | paraphrase | What would we have to build before turning this loose on real patient records? | 1 | 0.41 | pass |

## What this shows

- On questions that share vocabulary with the documents (the first 19), the right source is always first. The content records were written for exactly these questions, so this is the easy case.
- On paraphrases with little vocabulary overlap (p1 to p7), recall drops to 6 of 7 and the right source is often ranked 4th or 5th. p2 ("half-loaded data") is missed: its best score (0.30) sits on the answer threshold, so the assistant would either decline or answer from weaker evidence.
- Therefore: retrieval is adequate for a demonstration with a small local embedding model, and clearly not strong. Candidate improvements, none of which has been tried or measured: a hybrid of keyword and vector scores, a reranker, query expansion, or a larger embedding model. Each adds complexity that this evaluation would have to justify.
- No threshold or accuracy claim is made beyond the numbers above.

## Known limits of this evaluation

- Expected sources are chosen by the question's author; other chunks may also be relevant.
- A small local embedding model has lower recall than a large hosted one; the evidence threshold was set by inspection of this set and may reject some answerable questions.
- It does not measure the quality of the written answer, only whether the right evidence is retrieved.

