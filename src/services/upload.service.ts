import multer, { FileFilterCallback } from 'multer';
import path from 'path';
import fs from 'fs';
import { Request } from 'express';
import { logger } from '../config/logger';

// Ensure uploads directory exists
const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  logger.info({ dir: UPLOAD_DIR }, 'Created uploads directory');
}

// Allowed MIME types
const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];

const ALLOWED_DOCUMENT_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const ALLOWED_TYPES = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_DOCUMENT_TYPES];

// File extension mapping for validation
const ALLOWED_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.pdf', '.doc', '.docx',
];

// Max file size: 10MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Configure multer disk storage
 */
const storage = multer.diskStorage({
  destination(_req: Request, _file: Express.Multer.File, cb: (error: Error | null, destination: string) => void) {
    cb(null, UPLOAD_DIR);
  },
  filename(_req: Request, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  },
});

/**
 * File filter to validate MIME types and extensions
 */
function fileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  const ext = path.extname(file.originalname).toLowerCase();

  if (!ALLOWED_TYPES.includes(file.mimetype)) {
    return cb(new Error(`File type '${file.mimetype}' is not allowed. Allowed types: images (jpg, png, gif, webp) and documents (pdf, doc, docx).`));
  }

  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return cb(new Error(`File extension '${ext}' is not allowed.`));
  }

  cb(null, true);
}

/**
 * Multer upload instance with configured storage, limits, and file filter.
 */
const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
  fileFilter,
});

/**
 * Middleware for single file upload.
 * @param fieldName - The form field name for the file input.
 */
export function uploadSingle(fieldName: string) {
  return upload.single(fieldName);
}

/**
 * Middleware for multiple file uploads.
 * @param fieldName - The form field name for the file input.
 * @param maxCount - Maximum number of files (default: 5).
 */
export function uploadMultiple(fieldName: string, maxCount = 5) {
  return upload.array(fieldName, maxCount);
}

/**
 * Middleware for file uploads with specific fields.
 * @param fields - Array of field configurations.
 */
export function uploadFields(fields: multer.Field[]) {
  return upload.fields(fields);
}

/**
 * Get the public URL path for an uploaded file.
 * @param filename - The stored filename.
 * @returns The URL path to access the file.
 */
export function getFileUrl(filename: string): string {
  return `/uploads/${filename}`;
}

/**
 * Delete a file from the uploads directory.
 * @param filename - The stored filename to delete.
 */
export async function deleteFile(filename: string): Promise<void> {
  const filePath = path.join(UPLOAD_DIR, filename);

  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    await fs.promises.unlink(filePath);
    logger.info({ filename }, 'File deleted from uploads');
  } catch (err) {
    logger.warn({ filename, err }, 'Failed to delete file - it may not exist');
  }
}

/**
 * Get information about an uploaded file.
 * @param filename - The stored filename.
 * @returns File stats or null if file does not exist.
 */
export async function getFileInfo(filename: string): Promise<fs.Stats | null> {
  const filePath = path.join(UPLOAD_DIR, filename);

  try {
    const stats = await fs.promises.stat(filePath);
    return stats;
  } catch {
    return null;
  }
}

/**
 * Check if a file exists in the uploads directory.
 * @param filename - The stored filename.
 */
export async function fileExists(filename: string): Promise<boolean> {
  const filePath = path.join(UPLOAD_DIR, filename);

  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export { UPLOAD_DIR, MAX_FILE_SIZE, ALLOWED_TYPES, ALLOWED_EXTENSIONS };
