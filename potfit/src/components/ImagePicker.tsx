import { useRef, useState } from 'react';

export interface PickedImage {
  name: string;
  /** JPEG data URL, at most MAX_SIDE pixels on its longest side. */
  dataUrl: string;
}

const MAX_SIDE = 1600;

/** Decode any image the browser can read and re-encode it as a modest JPEG. */
export async function readImage(file: Blob, name: string): Promise<PickedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`Can't read ${name}; use a JPEG, PNG or WebP image`);
  }
  const k = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * k));
  canvas.height = Math.max(1, Math.round(bitmap.height * k));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // transparent PNGs get a white background
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { name: name.replace(/\.[^.]+$/, ''), dataUrl: canvas.toDataURL('image/jpeg', 0.88) };
}

/** Images from a drop or paste, ignoring anything that isn't an image. */
export function imageFiles(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return [];
  const out: File[] = [];
  for (const item of Array.from(list as ArrayLike<File | DataTransferItem>)) {
    const file = item instanceof File ? item : item.kind === 'file' ? item.getAsFile() : null;
    if (file && file.type.startsWith('image/')) out.push(file);
  }
  return out;
}

interface Props {
  images: PickedImage[];
  onChange(images: PickedImage[]): void;
  max?: number;
  compact?: boolean;
  disabled?: boolean;
}

/** Thumbnails with add (button, drop or paste) and remove. */
export function ImagePicker({ images, onChange, max = 8, compact, disabled }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const add = async (files: File[]) => {
    setError(null);
    const room = max - images.length;
    if (files.length > room) setError(`Only ${max} images at a time`);
    const picked: PickedImage[] = [];
    for (const f of files.slice(0, Math.max(0, room))) {
      try {
        picked.push(await readImage(f, f.name || 'pasted image'));
      } catch (e) {
        setError((e as Error).message);
      }
    }
    if (picked.length) onChange([...images, ...picked]);
  };

  return (
    <div
      className={`image-picker ${compact ? 'compact' : ''} ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (disabled) return;
        const files = imageFiles(e.dataTransfer.files);
        if (files.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        void add(files);
      }}
      onPaste={(e) => {
        const files = imageFiles(e.clipboardData.items);
        if (files.length === 0 || disabled) return;
        e.preventDefault();
        void add(files);
      }}
    >
      {images.map((img, i) => (
        <figure key={i} className="thumb">
          <img src={img.dataUrl} alt={img.name} />
          <button className="icon" title="Remove" disabled={disabled} onClick={() => onChange(images.filter((_, j) => j !== i))}>
            ×
          </button>
        </figure>
      ))}
      {images.length < max && (
        <button className="add-image" disabled={disabled} onClick={() => input.current?.click()} title="Add images (or drop or paste them here)">
          {compact ? '+ image' : '+ Add images'}
          {!compact && <small>drop or paste here too</small>}
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void add(imageFiles(e.target.files));
          e.target.value = '';
        }}
      />
      {error && <p className="error">{error}</p>}
    </div>
  );
}
