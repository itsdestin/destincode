import { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import type { ArtifactViewProps } from './types';

export function XlsxView({ absolutePath }: ArtifactViewProps) {
  const [sheets, setSheets] = useState<{ name: string; html: string }[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`file://${absolutePath}`)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const wb = XLSX.read(buf, { type: 'array' });
        const sheetData = wb.SheetNames.map((name) => ({
          name,
          html: XLSX.utils.sheet_to_html(wb.Sheets[name]),
        }));
        if (!cancelled) setSheets(sheetData);
      });
    return () => { cancelled = true; };
  }, [absolutePath]);

  return (
    <div className="flex flex-col h-full">
      {sheets.length > 1 && (
        <div className="flex gap-1 p-2 border-b border-edge overflow-x-auto">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              className={`px-3 py-1 rounded ${i === active ? 'bg-accent text-on-accent' : 'hover:bg-inset'}`}
              onClick={() => setActive(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div
        className="flex-1 overflow-auto p-4"
        dangerouslySetInnerHTML={{ __html: sheets[active]?.html ?? '' }}
      />
    </div>
  );
}
