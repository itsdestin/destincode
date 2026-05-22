import type { ArtifactViewProps } from './types';

export function ImageView({ absolutePath }: ArtifactViewProps) {
  return (
    <div className="flex items-center justify-center h-full p-4 overflow-auto">
      <img
        src={`file://${absolutePath}`}
        alt=""
        className="max-w-full max-h-full"
        style={{ touchAction: 'pinch-zoom' }}
      />
    </div>
  );
}
