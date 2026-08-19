import { useCallback, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';

interface Props {
  onFile(file: File): void;
}

/**
 * The entire first screen: take a photo, choose a file, or drop one.
 *
 * `capture="environment"` makes iOS and Android open the rear camera directly,
 * which is the main use case — photograph the artwork, get a count.
 */
export function UploadPanel({ onFile }: Props) {
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file && file.type.startsWith('image/')) onFile(file);
    },
    [onFile],
  );

  return (
    <div
      className={`upload${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <div className="upload-inner">
        <h1>Count the markers</h1>
        <p className="upload-lede">
          Photograph a numbered picture and get a count for every number on it.
        </p>
        <div className="upload-actions">
          <button type="button" className="btn btn-primary" onClick={() => cameraRef.current?.click()}>
            Take photo
          </button>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            Upload image
          </button>
        </div>
        <p className="upload-privacy">
          Images are processed on your device and are not uploaded.
        </p>
        <p className="upload-drop">or drop an image anywhere on this panel</p>
      </div>
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}
