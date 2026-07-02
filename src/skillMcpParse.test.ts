import assert from 'node:assert/strict';
import test from 'node:test';
import { isModelBoundErrorContent, parseSkillMcpPayload } from './skillMcpParse.js';

test('parseSkillMcpPayload handles body_md objects', () => {
  const id = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
  const parsed = parseSkillMcpPayload(
    {
      skill_id: id,
      slug: 'demo',
      source_path: '.modelbound/demo.md',
      body_md: '# Title\n\nMarker: v2',
    },
    id,
  );
  assert.ok(parsed);
  assert.match(parsed!.content, /Marker: v2/);
  assert.equal(parsed!.slug, 'demo');
});

test('parseSkillMcpPayload rejects error content', () => {
  assert.equal(parseSkillMcpPayload('Skill not found', 'id'), null);
  assert.equal(isModelBoundErrorContent('Error: nope'), true);
});

test('parseSkillMcpPayload handles markdown strings', () => {
  const parsed = parseSkillMcpPayload('# Hello', 'skill-1');
  assert.equal(parsed?.content, '# Hello');
});
