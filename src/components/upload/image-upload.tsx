"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  type StorageBucket,
  uploadBusinessImage,
  validateImageFile,
} from "@/lib/storage/upload";

export function ImageUpload({
  label,
  hint,
  value,
  onChange,
  businessId,
  bucket,
  prefix,
  previewClassName,
  disabled = false,
  onUploadingChange,
}: {
  label: string;
  hint?: string;
  value: string | null;
  onChange: (url: string | null) => void;
  businessId: string;
  bucket: StorageBucket;
  prefix: string;
  previewClassName?: string;
  disabled?: boolean;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = localPreview ?? value;

  useEffect(() => {
    return () => {
      if (localPreview) URL.revokeObjectURL(localPreview);
    };
  }, [localPreview]);

  function setBusy(next: boolean) {
    setUploading(next);
    onUploadingChange?.(next);
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError(null);

    try {
      validateImageFile(file);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Please choose a JPEG, PNG, WebP, or GIF image.",
      );
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setLocalPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return objectUrl;
    });
    setBusy(true);

    try {
      const publicUrl = await uploadBusinessImage({
        bucket,
        businessId,
        file,
        prefix,
      });
      onChange(publicUrl);
      setLocalPreview((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
    } catch (caught) {
      setLocalPreview((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
      setError(
        caught instanceof Error
          ? caught.message
          : "Couldn't upload the image. Please try again.",
      );
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{label}</Label>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}

      <div
        className={cn(
          "relative overflow-hidden rounded-xl border bg-muted/30",
          previewClassName ?? "aspect-[4/3] w-full max-w-sm",
        )}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
            No image yet
          </div>
        )}
        {uploading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 text-sm font-medium">
            Uploading…
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif"
          disabled={disabled || uploading}
          className="block w-full max-w-sm text-sm file:mr-3 file:rounded-lg file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground"
          onChange={(event) => {
            void handleFile(event.target.files?.[0]);
          }}
        />
        {value ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || uploading}
            onClick={() => {
              setError(null);
              onChange(null);
            }}
          >
            Remove
          </Button>
        ) : null}
      </div>

      {error ? (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
