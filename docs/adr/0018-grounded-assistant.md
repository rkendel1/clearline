# 0018: A grounded assistant: retrieval for explanation, validated tools for facts

**Context.** A visitor evaluating Clearline should be able to question the design, the decisions and the evidence, and later the demo data. A generic chatbot would invent answers, and a model that "answers" a total from retrieved prose can be fluently wrong.

**Decision.** Two separate evidence paths with an explicit router (`src/assistant/router.ts`):
1. **Explanation** (architecture, decisions, capabilities, security): vector retrieval over an approved, versioned corpus. Chunks carry source, heading, content hash and an access class, and the class filter runs in SQL before any text reaches an answer. A model, when configured, may only phrase an answer from the retrieved sources and must cite them; without a model the answer is extractive and labelled as such.
2. **Facts** (current numbers, run status, reconciliation outcomes, authorization): never from retrieval. Planned as narrow, authorized, templated data tools over the existing validated query path (anonymous visitors: fixed aggregate templates over synthetic data only; signed-in users: the existing governed SQL). **Not built yet.** Until then the assistant declines these questions and points to the query workspace.

**Vector store.** pgvector inside the existing PostgreSQL (schema `assistant`), built into the database image (`db/Dockerfile`) so there is no second database and the index shares backups. Embeddings come from a small local model (`Xenova/all-MiniLM-L6-v2`, 384 dimensions, run in-process, baked into the image), so no corpus text leaves the machine and no paid key is needed. The index records the embedding provider, model and dimension and refuses to mix vectors; changing the model requires an explicit rebuild.

**Alternatives.** A dedicated vector database (another system to run, secure and back up); hosted embeddings (a third-party dependency and key for a small public corpus); full-text search only (does not meet semantic retrieval); a retrieval-only design that also answers data questions (rejected: it would present prose as data).

**Consequences.** Retrieval quality is limited by a small model; it is measured on a version-controlled evaluation set (`docs/assistant-evaluation.md`) rather than claimed. The assistant has no tools in this release, so prompt injection in retrieved text cannot cause an action; output is rendered as text and navigation targets come from a fixed destination table. Public requests are rate limited per client and globally (in memory, per process). Conversations are not stored on the server. The index must be rebuilt after content changes (`npm run assistant:index`, or `docker compose run --rm index`).

**Revisit when** recall on the evaluation set is too low, the corpus outgrows pgvector, or per-tenant private corpora are needed.
