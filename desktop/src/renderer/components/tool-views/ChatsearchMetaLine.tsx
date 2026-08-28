// The metadata line shared by every chatsearch row: tags, then either the
// project + date pair (date pinned right) or the blocked-resume sentence.
// One component so ChatsearchFindCard's rows and ChatsearchShowCard's single
// row can never drift into two different orderings of the same three facts.
// Shape settled by the owner's Round 2 pick (registry.tsx, `b-closed`): tags
// stay visible even when the row is blocked — they're independent of resume
// eligibility — but the blocked sentence still REPLACES project+date, the
// same house rule ResumeBrowser.tsx uses for its own blocked rows.
import { TagChip } from '../tags/TagChip';
import type { ChipTag } from './chatsearch-tags';

export function ChatsearchMetaLine({ tags, blocked, project, date, className = '' }: {
  tags: ChipTag[];
  blocked: string | null;
  project: string;
  date: string;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-1 text-3xs text-fg-muted min-w-0 ${className}`}>
      {tags.map((t, i) => <TagChip key={`${t.label}-${i}`} tag={t} />)}
      {blocked ? (
        <span className="truncate">{blocked}</span>
      ) : (
        <>
          <span className="truncate">{project}</span>
          <span className="shrink-0 ml-auto">{date}</span>
        </>
      )}
    </div>
  );
}
