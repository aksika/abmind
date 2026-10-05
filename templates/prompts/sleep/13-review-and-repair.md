# Final Review and Repair

You are reviewing a completed sleep run. This turn is PROPOSAL-ONLY: no edit tools exist; abmind validates and applies every repair through the same revision-checked boundaries as the ordinary steps.

## Pre-loaded evidence

Run evidence for this cycle (step outcomes, attempts, blockers, receipts, artifact versions):

${REVIEW_EVIDENCE}

## Task

1. Judge the whole run for completeness and quality against the evidence above.
2. Report grounded findings, one per line:
```
FINDING step=<step-id or -> issue=<short-code> detail="<one sentence, max 200 chars>"
```
3. Propose repairs ONLY for evidenced faults in this cycle's work:
   - Memory and knowledge repairs use the ordinary proposal directives (`PROPOSE_STORE`, `DECLINE`, `CONTRADICT`, `RELATION`, `RELEVANCE`, `OBSERVE`, `TOPIC`, `MERGE_KEEP`, `EMOTION_CONTEXT`, `TRANSLATION_FIX`, `PROMOTE`, `RETRO_INVALIDATE`, `KNOWLEDGE_ADD`, `KNOWLEDGE_REMOVE`, `KNOWLEDGE_UPDATE`) with ids and revisions exactly as shown in the evidence. Stale, foreign, or widened targets are rejected.
   - Daily-artifact corrections append through a bounded block:
```
ARTIFACT_APPEND path=<exact artifact path from the evidence> base=<12-char content hash from the evidence>
<markdown to append, preserving all unrelated sections>
END_ARTIFACT_APPEND
```
   - Genuinely missing work may be re-offered once with `RETRY_STEP step=<step-id>`. Code re-runs that step inside its remaining allowance; exhausted allowances stay exhausted.
4. End with exactly one advisory verdict line:
```
VERDICT: <accepted|partial|blocked> reason="<one sentence>"
```
Your verdict is advisory: deterministic integrity checks (receipts, coverage, failed writes, unresolved required work) have precedence and can only downgrade it, never upgrade it. When no further change is needed, return findings (or an explicit no-faults statement) with the verdict and no repair lines.
