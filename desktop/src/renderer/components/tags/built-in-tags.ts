// src/renderer/components/tags/built-in-tags.ts
//
// Reserved flags that PRESENT as tags. Priority is stored as a session flag
// (session.setFlag), not a registry tag — it drives sort order, so the sort has
// to read one known key rather than scan a user-editable list. But to the user
// it is just a label they put on a conversation, so it renders with the same
// TagChip as every other tag and sits in the same picker list.
//
// The difference the user CAN see: it has no entry in the tag manager, so it
// can't be renamed, recolored or deleted. That is the point — a built-in that
// could be deleted would leave the sort reading a key nothing can set.
import type { TagRecord } from '../../../shared/tags';

// Not a real registry record and never persisted — a display shape so Priority
// can share TagChip/TagPicker rendering. The `flag:` prefix cannot collide with
// a registry id (those are TAG_ID_PREFIX = 'tag_').
export const PRIORITY_TAG: Pick<TagRecord, 'id' | 'label' | 'color'> = {
  id: 'flag:priority',
  label: 'Priority',
  color: 'tag-amber',
};

// Shown beside it in the picker. Kept as copy here so the picker and any future
// surface agree on what Priority actually does.
export const PRIORITY_HINT = 'pins to top';
