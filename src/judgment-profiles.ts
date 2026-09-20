/**
 * judgment-profiles.ts — #1813 build-time validated decision profiles.
 *
 * A profile binds (backend, exact model pin, question-set version) to the
 * gates fitted on the harness evidence artifact. A decision activates only
 * with a matching profile; anything else stays inactive and visible via
 * status/doctor. No runtime registry: this table plus the artifacts are the
 * profile store. Re-validate on any model, checkpoint, or question change.
 *
 * Evidence lives in abproject/laya/results/ (private harness, not packaged).
 * Lookup has no passing profile on either backend — the bypass stays inactive
 * by construction, not by flag. Attribution is advisory and carries no gate.
 */

export type JudgmentQuestionSet = "recall-rerank-v1" | "lookup-v1" | "repeat-v1" | "attribution-v1";

export interface RepeatGate {
  readonly addsThreshold: number;
}

export interface LookupGate {
  readonly completeThreshold: number;
  readonly answersGate: number;
}

export interface JudgmentProfile {
  readonly backend: "jev" | "laya";
  /** Exact model pin ("" matches any — reserved for advisory-only profiles). */
  readonly model: string;
  readonly questionSet: JudgmentQuestionSet;
  readonly repeatGate?: RepeatGate;
  readonly lookupGate?: LookupGate;
  /** Harness artifact recording the fit behind this profile. */
  readonly evidence: string;
}

const PROFILES: readonly JudgmentProfile[] = [
  {
    backend: "jev",
    model: "jev-1.13.0",
    questionSet: "repeat-v1",
    repeatGate: { addsThreshold: 0.7 },
    evidence: "laya/results/repeat-1813-jev.json",
  },
  {
    backend: "jev",
    model: "",
    questionSet: "attribution-v1",
    evidence: "laya/results/attribution-1813-jev.json",
  },
  {
    backend: "laya",
    model: "",
    questionSet: "attribution-v1",
    evidence: "laya/results/attribution-1813-laya.json",
  },
];

/** Match an exact profile for a provider, model, and question set. */
export function matchJudgmentProfile(
  providerName: string,
  providerModel: string,
  questionSet: JudgmentQuestionSet,
): JudgmentProfile | null {
  for (const profile of PROFILES) {
    if (profile.backend !== providerName) continue;
    if (profile.questionSet !== questionSet) continue;
    if (profile.model !== "" && profile.model !== providerModel) continue;
    return profile;
  }
  return null;
}

/** Profile identity for status/doctor: implemented profiles, not live state. */
export function describeJudgmentProfiles(): string {
  return PROFILES.map((p) => {
    const gate = p.repeatGate
      ? ` adds<${p.repeatGate.addsThreshold}`
      : p.lookupGate
        ? ` complete>=${p.lookupGate.completeThreshold}`
        : " advisory";
    return `${p.backend}/${p.model || "*"} ${p.questionSet}${gate}`;
  }).join("; ");
}
