import { createClient } from "@/lib/supabase/client";

export const PRODUCT_IMAGES_BUCKET = "product-images";
export const BUSINESS_BRANDING_BUCKET = "business-branding";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export type StorageBucket =
  | typeof PRODUCT_IMAGES_BUCKET
  | typeof BUSINESS_BRANDING_BUCKET;

export class ImageUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageUploadError";
  }
}

function extensionFor(file: File): string {
  const mime = file.type.toLowerCase();
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  const fromName = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  if (fromName === "jpeg") return "jpg";
  if (fromName === "jpg" || fromName === "png" || fromName === "webp" || fromName === "gif") {
    return fromName;
  }
  return "jpg";
}

function contentTypeFor(file: File): string {
  const mime = file.type.toLowerCase();
  if (mime === "image/jpg") return "image/jpeg";
  if (ALLOWED_MIME.has(mime) && mime !== "image/jpg") return mime;
  const ext = extensionFor(file);
  if (ext === "jpg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/jpeg";
}

export function validateImageFile(file: File): void {
  const mime = file.type.toLowerCase();
  const looksLikeImage =
    ALLOWED_MIME.has(mime) ||
    (!mime && /\.(jpe?g|png|webp|gif)$/i.test(file.name));
  if (!looksLikeImage) {
    throw new ImageUploadError(
      "Please choose a JPEG, PNG, WebP, or GIF image.",
    );
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ImageUploadError("That image is too large. Maximum size is 5 MB.");
  }
  if (file.size <= 0) {
    throw new ImageUploadError("That file is empty. Please choose another image.");
  }
}

function objectPath(businessId: string, prefix: string, ext: string): string {
  const id = crypto.randomUUID();
  const safePrefix = prefix.replace(/[^a-z0-9-]/gi, "") || "image";
  return `${businessId}/${safePrefix}-${id}.${ext}`;
}

export async function uploadBusinessImage(options: {
  bucket: StorageBucket;
  businessId: string;
  file: File;
  prefix: string;
}): Promise<string> {
  validateImageFile(options.file);

  const path = objectPath(
    options.businessId,
    options.prefix,
    extensionFor(options.file),
  );
  const supabase = createClient();
  const { error } = await supabase.storage
    .from(options.bucket)
    .upload(path, options.file, {
      cacheControl: "3600",
      upsert: false,
      contentType: contentTypeFor(options.file),
    });

  if (error) {
    throw new ImageUploadError(
      error.message || "Couldn't upload the image. Please try again.",
    );
  }

  const { data } = supabase.storage.from(options.bucket).getPublicUrl(path);
  const publicUrl = data.publicUrl?.trim();
  if (!publicUrl) {
    throw new ImageUploadError(
      "The image uploaded, but we couldn't get a public URL. Please try again.",
    );
  }
  return publicUrl;
}
