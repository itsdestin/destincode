import type { TagRecord } from '../../../../shared/tags';

// Colors are SLOT KEYS from TAG_COLORS ('tag-red', not 'red') and ids carry
// TAG_ID_PREFIX ('tag_'), both per shared/tags.ts. Getting either wrong renders
// an unstyled swatch rather than failing loudly, so the compiler check on
// TagColor is doing real work here.
export function tags(): TagRecord[] {
  return [
    { id: 'tag_work', label: 'work', color: 'tag-blue', archived: false, createdAt: '2026-07-01T09:00:00.000Z' },
    { id: 'tag_bug', label: 'bug', color: 'tag-red', archived: false, createdAt: '2026-07-02T09:00:00.000Z' },
    { id: 'tag_idea', label: 'idea', color: 'tag-green', archived: false, createdAt: '2026-07-03T09:00:00.000Z' },
    // Archived tags are filtered out of the picker but must still resolve when
    // an existing conversation references one.
    { id: 'tag_retired', label: 'retired', color: 'tag-gray', archived: true, createdAt: '2026-06-01T09:00:00.000Z' },
  ];
}

// Promo (scenario=site&student=1): a student's tag set. The Resume browser's
// Organize sheet lists every tag by name, so "work / bug / idea" would read as
// a developer's app in the middle of a student's clip. Same slot rules as above.
export function studentTags(): TagRecord[] {
  return [
    { id: 'tag_econ', label: 'econ', color: 'tag-blue', archived: false, createdAt: '2026-07-01T09:00:00.000Z' },
    { id: 'tag_club', label: 'club', color: 'tag-green', archived: false, createdAt: '2026-07-02T09:00:00.000Z' },
    { id: 'tag_jobhunt', label: 'job hunt', color: 'tag-purple', archived: false, createdAt: '2026-07-03T09:00:00.000Z' },
    { id: 'tag_urgent', label: 'urgent', color: 'tag-red', archived: false, createdAt: '2026-07-04T09:00:00.000Z' },
  ];
}
