import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as progressNotesService from './progress-notes.service';

// ============================================================
// Progress Notes
// ============================================================

export async function createProgressNote(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const note = await progressNotesService.createProgressNote(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Progress note created successfully',
      data: note,
    });
  } catch (err) {
    next(err);
  }
}

export async function getProgressNotes(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { notes, total, page, limit } = await progressNotesService.getProgressNotes(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, notes, total, page, limit, 'Progress notes retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getProgressNoteById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const note = await progressNotesService.getProgressNoteById(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Progress note retrieved successfully',
      data: note,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateProgressNote(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const note = await progressNotesService.updateProgressNote(tenantId, req.params.id as string, req.body);
    sendResponse({
      res,
      message: 'Progress note updated successfully',
      data: note,
    });
  } catch (err) {
    next(err);
  }
}

export async function deleteProgressNote(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    await progressNotesService.deleteProgressNote(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Progress note deleted successfully',
    });
  } catch (err) {
    next(err);
  }
}

export async function signProgressNote(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const note = await progressNotesService.signProgressNote(tenantId, req.params.id as string, userId);
    sendResponse({
      res,
      message: 'Progress note signed successfully',
      data: note,
    });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Progress Note Templates
// ============================================================

export async function listProgressNoteTemplates(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const templates = await progressNotesService.listProgressNoteTemplates(tenantId, userId);
    sendResponse({ res, message: 'Templates retrieved successfully', data: templates });
  } catch (err) {
    next(err);
  }
}

export async function createProgressNoteTemplate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const template = await progressNotesService.createProgressNoteTemplate(tenantId, userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Template created successfully', data: template });
  } catch (err) {
    next(err);
  }
}

export async function updateProgressNoteTemplate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const template = await progressNotesService.updateProgressNoteTemplate(
      tenantId,
      userId,
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, message: 'Template updated successfully', data: template });
  } catch (err) {
    next(err);
  }
}

export async function deleteProgressNoteTemplate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    await progressNotesService.deleteProgressNoteTemplate(tenantId, userId, req.params.id as string);
    sendResponse({ res, message: 'Template deleted successfully' });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Nursing Notes
// ============================================================

export async function createNursingNote(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const note = await progressNotesService.createNursingNote(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Nursing note created successfully',
      data: note,
    });
  } catch (err) {
    next(err);
  }
}

export async function getNursingNotes(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { notes, total, page, limit } = await progressNotesService.getNursingNotes(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, notes, total, page, limit, 'Nursing notes retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getNursingNoteById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const note = await progressNotesService.getNursingNoteById(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Nursing note retrieved successfully',
      data: note,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateNursingNote(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const note = await progressNotesService.updateNursingNote(tenantId, req.params.id as string, req.body);
    sendResponse({
      res,
      message: 'Nursing note updated successfully',
      data: note,
    });
  } catch (err) {
    next(err);
  }
}

export async function deleteNursingNote(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    await progressNotesService.deleteNursingNote(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Nursing note deleted successfully',
    });
  } catch (err) {
    next(err);
  }
}
