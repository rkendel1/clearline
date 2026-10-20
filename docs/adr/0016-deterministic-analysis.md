# 0016: Deterministic, explainable analysis first; models may only narrate

**Context.** Scheduled insights are acted on without a person checking each one. A model asked to "find anomalies" can invent numbers, imply causes, and give different answers for the same data.

**Decision.** The built-in analysis pipeline is deterministic and offline: robust anomaly detection (rolling MAD with seasonality; seasonal decomposition with a median trend), baseline forecasts selected and evaluated by rolling-origin backtests with empirical intervals, robust outlier scores with per-feature contributions, and seeded k-means. Every result has an explicit status, method and version, limitations and quality measures. Insights are templated from computed values and store their evidence. An optional model may write a summary of an insight from its evidence only; the summary is accepted only if every number in it appears in the evidence and it asserts no cause, misconduct or certainty, and the templated insight is always shown.

**Reasons.** The same input always gives the same output (tests compare against generator ground truth), methods can be explained and audited, and the core runs with no credentials or network. Simple, well-understood baselines are hard to beat on short business series and make failures (insufficient history, stale schema) explicit.

**Costs.** No learned models: no holiday calendars, no multivariate forecasting, no automatic feature learning; clusters need a person to name them. Algorithms run in the worker process, bounded by input caps rather than isolated in a sandbox.

**Revisit when** a use case needs models beyond these baselines; they would be added as new versioned algorithms behind the same configuration validation, status codes and evidence rules.
