import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { strategySkills, validateSkillId, type SkillId, type SkillMetadata } from '../../shared/strategy-skills.js';

interface LoadedSkill {
  readonly metadata: SkillMetadata;
  readonly content: string;
}

const loaded = new Map<SkillId, LoadedSkill>();

export function loadStrategySkill(value: SkillId): LoadedSkill {
  const id = validateSkillId(value);
  const existing = loaded.get(id);
  if (existing) return existing;
  const definition = strategySkills.find((skill) => skill.id === id)!;
  const content = readFileSync(new URL('../../skills/doudizhu/' + id + '/SKILL.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n').trim();
  if (!content || content.length > 800) throw new Error('Strategy skill must contain 1–800 characters');
  const metadata = Object.freeze({ id, name: definition.name, version: definition.version, digest: createHash('sha256').update(content).digest('hex') });
  const skill = Object.freeze({ metadata, content });
  loaded.set(id, skill);
  return skill;
}
