export const strategySkills = [
  { id: 'structure', name: '稳健结构型', version: 1, description: '保留组合结构，谨慎使用控制牌' },
  { id: 'tempo', name: '控场进攻型', version: 1, description: '争取主动权，及时阻止对手收尾' },
  { id: 'teamwork', name: '协作均衡型', version: 1, description: '农民配合队友，地主兼顾两家威胁' },
] as const;

export type SkillId = typeof strategySkills[number]['id'];
export interface SkillMetadata {
  readonly id: SkillId;
  readonly name: string;
  readonly version: number;
  readonly digest: string;
}

export function validateSkillId(value: unknown): SkillId {
  if (!strategySkills.some((skill) => skill.id === value)) throw new Error('Unknown DeepSeek strategy skill');
  return value as SkillId;
}

export function defaultSkillForSeat(seat: number): SkillId {
  if (!Number.isInteger(seat) || seat < 0 || seat > 2) throw new Error('Invalid skill seat');
  return strategySkills[seat].id;
}
