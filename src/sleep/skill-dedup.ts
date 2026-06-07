/**
 * Skill dedup detection for sleep step 10 (skill-review).
 *
 * Scans self/ skills against core/ skills for overlap,
 * and detects fragmentation (multiple self/ skills for the same domain).
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SkillDedupCandidate {
  selfSkill: string;
  reason: 'core-overlap' | 'fragmentation';
  coreMatch?: string;
  siblings?: string[];
}

/**
 * Detect self/ skills that duplicate core/ skills or fragment the same domain.
 *
 * @param coreSkillsDir - path to skills/core/ (may have nested dirs like tools/gmail/)
 * @param selfSkillsDir - path to skills/self/
 */
export function detectSkillDuplicates(
  coreSkillsDir: string,
  selfSkillsDir: string,
): SkillDedupCandidate[] {
  if (!existsSync(coreSkillsDir) || !existsSync(selfSkillsDir)) return [];

  // Collect core skill domains (flatten nested dirs)
  const coreDomains = new Set<string>();
  const scanCore = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        coreDomains.add(entry.name.toLowerCase());
        scanCore(join(dir, entry.name));
      }
    }
  };
  scanCore(coreSkillsDir);

  // Collect self skill names
  const selfSkills: string[] = [];
  for (const entry of readdirSync(selfSkillsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) selfSkills.push(entry.name);
  }
  if (selfSkills.length === 0) return [];

  const candidates: SkillDedupCandidate[] = [];
  const seen = new Set<string>();

  // Core overlap: self skill's root word matches a core domain
  for (const skill of selfSkills) {
    const root = skill.toLowerCase().split('-')[0]!;
    if (coreDomains.has(root)) {
      candidates.push({ selfSkill: skill, reason: 'core-overlap', coreMatch: root });
      seen.add(skill);
    }
  }

  // Fragmentation: multiple self/ skills sharing a prefix
  const groups = new Map<string, string[]>();
  for (const skill of selfSkills) {
    const prefix = skill.toLowerCase().split('-')[0]!;
    const list = groups.get(prefix) ?? [];
    list.push(skill);
    groups.set(prefix, list);
  }
  for (const [_prefix, members] of groups) {
    if (members.length > 1) {
      for (const skill of members) {
        if (!seen.has(skill)) {
          candidates.push({
            selfSkill: skill,
            reason: 'fragmentation',
            siblings: members.filter(s => s !== skill),
          });
          seen.add(skill);
        }
      }
    }
  }

  return candidates;
}

/** Format candidates as text for prompt injection. Returns empty string if none. */
export function formatDedupCandidates(candidates: SkillDedupCandidate[]): string {
  if (candidates.length === 0) return '';
  const lines: string[] = [];
  for (const c of candidates) {
    if (c.reason === 'core-overlap') {
      lines.push(`- self/${c.selfSkill} → overlaps core skill "${c.coreMatch}"`);
    } else {
      lines.push(`- self/${c.selfSkill} → fragmented (siblings: ${c.siblings!.join(', ')})`);
    }
  }
  return lines.join('\n');
}
