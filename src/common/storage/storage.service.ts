import { randomUUID } from 'crypto';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../../modules/supabase/supabase-admin.service';

/**
 * Narrow contract for an uploaded file. Multer 2.x ships without type
 * declarations and we'd rather not depend on the global UploadedFile
 * augmentation. Multer's runtime objects satisfy this shape.
 */
export interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname: string;
}

const PHOTO_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
const VIDEO_MIMES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;

const PHOTO_MAX_BYTES = 10 * 1024 * 1024; //  10 MB
const VIDEO_MAX_BYTES = 50 * 1024 * 1024; //  50 MB

export type StoredKind = 'photo' | 'video';

export interface StoredFile {
  kind: StoredKind;
  /** Storage path inside the bucket (e.g. `<ownerId>/<uuid>.jpg`). */
  path: string;
  /** Public (or signed) URL the client can use to render the file. */
  url: string;
  mimeType: string;
  sizeBytes: number;
}

export interface UploadOptions {
  /** Optional path prefix under `<ownerId>/`. Useful for grouping (`post`, `avatar`, etc.). */
  pathPrefix?: string;
  /** Restrict allowed kinds. Default: both photo and video. */
  allow?: ReadonlyArray<StoredKind>;
}

/**
 * Shared upload pipeline. Validates mime + size, writes to Supabase Storage,
 * returns the persisted URL. Owner id is baked into the storage path so the
 * uploader is verifiable from the URL alone.
 *
 * Caller is responsible for batching uploads when storing multi-file
 * attachments, and for deleting on failure if a downstream DB write fails.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(private readonly supabase: SupabaseAdminService) {}

  async uploadOne(
    bucket: string,
    ownerId: string,
    file: UploadedFile,
    opts: UploadOptions = {},
  ): Promise<StoredFile> {
    const kind = this.classify(file.mimetype, opts.allow);
    this.assertSize(kind, file.size);

    const ext = extensionFor(file.mimetype, file.originalname);
    const prefix = opts.pathPrefix ? `${opts.pathPrefix}/` : '';
    const path = `${ownerId}/${prefix}${randomUUID()}.${ext}`;

    const { error } = await this.supabase.client.storage
      .from(bucket)
      .upload(path, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });
    if (error) {
      this.logger.warn(
        `Storage upload failed: bucket=${bucket} path=${path} err=${error.message}`,
      );
      throw new InternalServerErrorException('Failed to upload file');
    }

    const { data: pub } = this.supabase.client.storage.from(bucket).getPublicUrl(path);
    return {
      kind,
      path,
      url: pub.publicUrl,
      mimeType: file.mimetype,
      sizeBytes: file.size,
    };
  }

  /**
   * Upload many files. If any single upload fails, previously-uploaded files
   * in the same batch are best-effort deleted before throwing — keeps storage
   * clean when a partial batch can't be persisted.
   */
  async uploadMany(
    bucket: string,
    ownerId: string,
    files: UploadedFile[],
    opts: UploadOptions = {},
  ): Promise<StoredFile[]> {
    const uploaded: StoredFile[] = [];
    try {
      for (const f of files) {
        uploaded.push(await this.uploadOne(bucket, ownerId, f, opts));
      }
      return uploaded;
    } catch (err) {
      for (const u of uploaded) {
        await this.delete(bucket, u.path).catch(() => undefined);
      }
      throw err;
    }
  }

  async delete(bucket: string, path: string): Promise<void> {
    const { error } = await this.supabase.client.storage.from(bucket).remove([path]);
    if (error) {
      this.logger.warn(
        `Storage delete failed: bucket=${bucket} path=${path} err=${error.message}`,
      );
    }
  }

  private classify(mime: string, allow?: ReadonlyArray<StoredKind>): StoredKind {
    if ((PHOTO_MIMES as readonly string[]).includes(mime)) {
      if (allow && !allow.includes('photo')) {
        throw new BadRequestException('Photos are not allowed for this upload');
      }
      return 'photo';
    }
    if ((VIDEO_MIMES as readonly string[]).includes(mime)) {
      if (allow && !allow.includes('video')) {
        throw new BadRequestException('Videos are not allowed for this upload');
      }
      return 'video';
    }
    throw new BadRequestException(`Unsupported file type: ${mime}`);
  }

  private assertSize(kind: StoredKind, bytes: number): void {
    const cap = kind === 'photo' ? PHOTO_MAX_BYTES : VIDEO_MAX_BYTES;
    if (bytes > cap) {
      throw new PayloadTooLargeException(
        `${kind} exceeds ${Math.floor(cap / 1024 / 1024)} MB limit`,
      );
    }
  }
}

function extensionFor(mime: string, originalName: string): string {
  const fromName = originalName.split('.').pop();
  if (fromName && /^[a-zA-Z0-9]{1,5}$/.test(fromName)) return fromName.toLowerCase();
  const fromMime = mime.split('/')[1];
  return fromMime ? fromMime.replace(/[^a-z0-9]/g, '') : 'bin';
}
