"use client";

import { useId, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { MAX_PRODUCT_IMAGES } from "@/lib/products/images";
import {
  PRODUCT_IMAGES_BUCKET,
  uploadBusinessImage,
  validateImageFile,
} from "@/lib/storage/upload";

export type GalleryDraft = {
  clientId: string;
  url: string;
};

export function ProductGalleryUpload({
  images,
  onChange,
  businessId,
  disabled = false,
  onUploadingChange,
}: {
  images: GalleryDraft[];
  onChange: (images: GalleryDraft[]) => void;
  businessId: string;
  disabled?: boolean;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const remaining = MAX_PRODUCT_IMAGES - images.length;
  const busy = uploadingCount > 0;

  function setBusyDelta(delta: number) {
    setUploadingCount((current) => {
      const next = Math.max(0, current + delta);
      onUploadingChange?.(next > 0);
      return next;
    });
  }

  async function handleFiles(fileList: FileList | null) {
    if (!fileList?.length) return;
    setError(null);

    const slots = MAX_PRODUCT_IMAGES - images.length;
    if (slots <= 0) {
      setError(`A product can have at most ${MAX_PRODUCT_IMAGES} images.`);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    const chosen = Array.from(fileList).slice(0, slots);
    const skipped = fileList.length - chosen.length;

    const valid: File[] = [];
    for (const file of chosen) {
      try {
        validateImageFile(file);
        valid.push(file);
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Please choose a JPEG, PNG, WebP, or GIF image.",
        );
        if (inputRef.current) inputRef.current.value = "";
        return;
      }
    }

    setBusyDelta(valid.length);
    const uploaded: GalleryDraft[] = [];
    try {
      for (const file of valid) {
        const publicUrl = await uploadBusinessImage({
          bucket: PRODUCT_IMAGES_BUCKET,
          businessId,
          file,
          prefix: "product",
        });
        uploaded.push({
          clientId: `img-${crypto.randomUUID()}`,
          url: publicUrl,
        });
      }
      if (uploaded.length) {
        onChange([...images, ...uploaded]);
      }
      if (skipped > 0) {
        setError(
          `Only ${MAX_PRODUCT_IMAGES} images per product. ${skipped} extra file${
            skipped === 1 ? " was" : "s were"
          } skipped.`,
        );
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Couldn't upload the image. Please try again.",
      );
    } finally {
      setBusyDelta(-valid.length);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function move(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= images.length) return;
    const next = [...images];
    const [item] = next.splice(index, 1);
    next.splice(nextIndex, 0, item);
    onChange(next);
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>Photos</Label>
      <p className="text-xs text-muted-foreground">
        JPEG, PNG, WebP, or GIF. Maximum 5 MB each. Up to {MAX_PRODUCT_IMAGES}{" "}
        images. The first photo is the cover.
      </p>

      {images.length > 0 ? (
        <ul className="space-y-2">
          {images.map((image, index) => (
            <li
              key={image.clientId}
              className="flex items-center gap-3 rounded-xl border p-2"
            >
              <div className="relative size-16 shrink-0 overflow-hidden rounded-lg bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.url}
                  alt=""
                  className="h-full w-full object-cover"
                />
                {index === 0 ? (
                  <span className="absolute bottom-0 inset-x-0 bg-background/80 text-center text-[10px] font-medium">
                    Cover
                  </span>
                ) : null}
              </div>
              <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                Photo {index + 1} of {images.length}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled || busy || index === 0}
                  aria-label="Move up"
                  onClick={() => move(index, -1)}
                >
                  <ChevronUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled || busy || index === images.length - 1}
                  aria-label="Move down"
                  onClick={() => move(index, 1)}
                >
                  <ChevronDown />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled || busy}
                  aria-label="Remove photo"
                  onClick={() =>
                    onChange(images.filter((item) => item.clientId !== image.clientId))
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex aspect-[4/3] w-full max-w-sm items-center justify-center rounded-xl border bg-muted/30 px-3 text-center text-xs text-muted-foreground">
          No images yet
        </div>
      )}

      <input
        ref={inputRef}
        id={inputId}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif"
        disabled={disabled || busy || remaining <= 0}
        className="block w-full max-w-sm text-sm file:mr-3 file:rounded-lg file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground"
        onChange={(event) => {
          void handleFiles(event.target.files);
        }}
      />

      {busy ? (
        <p className="text-sm text-muted-foreground">Uploading…</p>
      ) : null}

      {error ? (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
