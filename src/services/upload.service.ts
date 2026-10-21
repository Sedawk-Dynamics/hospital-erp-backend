import multer, { FileFilterCallback } from 'multer';
import path from 'path';
import fs from 'fs';
import { Request } from 'express';
import { logger } from '../config/logger';

const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  logger.info({ dir: UPLOAD_DIR }, 'Created uploads directory');
}

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

const ALLOWED_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.pdf', '.doc', '.docx',
];

const ALLOWED_IMAGING_MIME_TYPES = [
  ...ALLOWED_TYPES,
  'image/bmp',
  'image/tiff',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/dicom',
  'application/octet-stream', // .dcm often arrives as octet-stream
];

const ALLOWED_IMAGING_EXTENSIONS = [
  ...ALLOWED_EXTENSIONS,
  '.bmp', '.tif', '.tiff',
  '.mp4', '.webm', '.mov',
  '.dcm', '.dicom','.zip'
];

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_IMAGING_FILE_SIZE = 100 * 1024 * 1024;


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


const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
  fileFilter,
});


export function uploadSingle(fieldName: string) {
  return upload.single(fieldName);
}


function imagingFileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  const ext = path.extname(file.originalname).toLowerCase();

  if (!ALLOWED_IMAGING_EXTENSIONS.includes(ext)) {
    return cb(
      new Error(
        `File extension '${ext}' is not allowed for imaging. Allowed: ${ALLOWED_IMAGING_EXTENSIONS.join(', ')}.`,
      ),
    );
  }

  const isDicomExt = ext === '.dcm' || ext === '.dicom' || ext === '.zip';
  if (!isDicomExt && !ALLOWED_IMAGING_MIME_TYPES.includes(file.mimetype)) {
    return cb(
      new Error(
        `File type '${file.mimetype}' is not allowed for imaging.`,
      ),
    );
  }

  cb(null, true);
}

const imagingUpload = multer({
  storage,
  limits: { fileSize: MAX_IMAGING_FILE_SIZE },
  fileFilter: imagingFileFilter,
});

function dicomFolderFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  const ext = path.extname(file.originalname).toLowerCase();
  const isDicom = ext === '.dcm' || ext === '.dicom';
  cb(null, isDicom);
}

const dicomFolderUpload = multer({
  storage,
  limits: { fileSize: MAX_IMAGING_FILE_SIZE },
  fileFilter: dicomFolderFilter,
});

export function uploadImagingSingle(fieldName: string) {
  return imagingUpload.single(fieldName);
}

export function uploadImagingMultiple(fieldName: string, maxCount = 10) {
  return imagingUpload.array(fieldName, maxCount);
}


export function uploadMultiple(fieldName: string, maxCount = 5) {
  return upload.array(fieldName, maxCount);
}


export function uploadFields(fields: multer.Field[]) {
  return upload.fields(fields);
}


export function getFileUrl(filename: string): string {
  return `/uploads/${filename}`;
}


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


export async function getFileInfo(filename: string): Promise<fs.Stats | null> {
  const filePath = path.join(UPLOAD_DIR, filename);

  try {
    const stats = await fs.promises.stat(filePath);
    return stats;
  } catch {
    return null;
  }
}


export async function fileExists(filename: string): Promise<boolean> {
  const filePath = path.join(UPLOAD_DIR, filename);

  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function uploadImagingArray(fieldName: string, maxCount = 1000) {
  return imagingUpload.array(fieldName, maxCount);
}

export function uploadDicomFolderArray(fieldName: string, maxCount = 1000) {
  return dicomFolderUpload.array(fieldName, maxCount);
}


export { UPLOAD_DIR, MAX_FILE_SIZE, ALLOWED_TYPES, ALLOWED_EXTENSIONS };
