// 来源: lib/skills/skill_config.dart

import type { ToolDefinition } from '@/types/skill';

interface SkillConfig {
  id: string;
  name: string;
  category: string;
  description: string;
  tools: ToolDefinition[];
  nameCn?: string;
  descriptionCn?: string;
  categoryCn?: string;
  usage?: string;
  usageCn?: string;
}

function parseYaml(yaml: string): Record<string, string> {
  const map: Record<string, string> = {};
  const lines = yaml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.substring(0, colon).trim();
    const rest = line.substring(colon + 1).trim();

    if (rest === '|' || rest === '|-' || rest === '>-') {
      // Block scalar — collect subsequent indented lines
      const valueLines: string[] = [];
      while (i + 1 < lines.length && (lines[i + 1].startsWith('  ') || lines[i + 1].startsWith('\t'))) {
        i++;
        valueLines.push(lines[i].replace(/^ {2}/, ''));
      }
      map[key] = valueLines.join('\n');
    } else {
      let value = rest;
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.substring(1, value.length - 1);
      }
      if (key) map[key] = value;
    }
  }
  return map;
}

export function parseSkillMarkdown(md: string): SkillConfig {
  const fmMatch = /^---\s*\n([\s\S]*?)\n---/.exec(md);
  if (!fmMatch) throw new Error('Missing YAML frontmatter');

  const fm = parseYaml(fmMatch[1]);
  const id = fm['id'] ?? '';
  const name = fm['name'] ?? '';
  const category = fm['category'] ?? '';

  const afterFM = md.substring(fmMatch.index! + fmMatch[0].length);
  const jsonMatch = /```json\s*\n([\s\S]*?)\n```/.exec(afterFM);
  const description = jsonMatch
    ? afterFM.substring(0, jsonMatch.index).trim()
    : afterFM.trim();

  let tools: ToolDefinition[] = [];
  if (jsonMatch) {
    const list = JSON.parse(jsonMatch[1]);
    tools = list.map((t: Record<string, unknown>) => ({
      name: t['name'] as string,
      description: t['description'] as string,
      parameters: (t['parameters'] as Record<string, unknown>) ?? {},
      nameCn: (t['name_cn'] as string) || undefined,
      descriptionCn: (t['description_cn'] as string) || undefined,
    }));
  }

  return {
    id, name, category, description, tools,
    nameCn: fm['name_cn'] || undefined,
    descriptionCn: fm['description_cn'] || undefined,
    categoryCn: fm['category_cn'] || undefined,
    usage: fm['usage'] || undefined,
    usageCn: fm['usage_cn'] || undefined,
  };
}

const skillFiles = ['desktop_screen', 'desktop_uia', 'web_screen', 'phone_screen', 'app_builder', 'office_doc'];

export async function loadSkills(): Promise<SkillConfig[]> {
  const skills: SkillConfig[] = [];
  for (const name of skillFiles) {
    try {
      const res = await fetch(`/skills/${name}.md`);
      if (!res.ok) continue;
      const text = await res.text();
      skills.push(parseSkillMarkdown(text));
    } catch {
      console.debug(`Failed to load skill: ${name}`);
    }
  }
  return skills;
}

export async function loadSkill(name: string): Promise<SkillConfig | null> {
  try {
    const res = await fetch(`/skills/${name}.md`);
    if (!res.ok) return null;
    const text = await res.text();
    return parseSkillMarkdown(text);
  } catch {
    return null;
  }
}
