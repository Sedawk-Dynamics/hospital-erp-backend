import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate';
import * as controller from './transcribe.controller';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('audio/') || file.mimetype === 'video/webm') {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  },
});

export const transcribeRoutes = Router();

transcribeRoutes.post('/',authenticate,upload.single('audio'),controller.transcribe);
