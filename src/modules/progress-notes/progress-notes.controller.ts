import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as progressNotesService from './progress-notes.service';
import { getSmartSuggestions } from './progress-notes.ai';
import { assertFeatureEnabled } from '../ai/ai.config.service';

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
    const userId = req.user!.userId;
    const note = await progressNotesService.updateProgressNote(
      tenantId,
      userId,
      req.params.id as string,
      req.body,
    );
    sendResponse({
      res,
      message: 'Progress note updated successfully',
      data: note,
    });
  } catch (err) {
    next(err);
  }
}

export async function listProgressNoteAmendments(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const amendments = await progressNotesService.listProgressNoteAmendments(
      tenantId,
      req.params.id as string,
    );
    sendResponse({
      res,
      message: 'Amendments retrieved successfully',
      data: amendments,
    });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Physical Observation Catalog
// ============================================================

export async function listPhysicalObservations(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const items = await progressNotesService.listPhysicalObservations(tenantId, req.query as any);
    sendResponse({ res, message: 'Physical observations retrieved', data: items });
  } catch (err) {
    next(err);
  }
}

export async function createPhysicalObservation(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const item = await progressNotesService.createPhysicalObservation(tenantId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Physical observation entry created',
      data: item,
    });
  } catch (err) {
    next(err);
  }
}

export async function updatePhysicalObservation(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const item = await progressNotesService.updatePhysicalObservation(
      tenantId,
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, message: 'Physical observation entry updated', data: item });
  } catch (err) {
    next(err);
  }
}

export async function deletePhysicalObservation(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    await progressNotesService.deletePhysicalObservation(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Physical observation entry deleted' });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// AI Smart Suggestions
// ============================================================

export async function smartSuggestions(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    // Super-admin can disable progress-note AI suggestions per hospital.
    await assertFeatureEnabled('progressNotesAi', req.user!.tenantId);
    const result = await getSmartSuggestions(req.body, req.user!.tenantId);
    sendResponse({ res, message: 'AI suggestions generated', data: result });
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

export async function unlockProgressNote(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const hours = (req.body as { hours?: number } | undefined)?.hours;
    const data = await progressNotesService.unlockProgressNote(
      tenantId,
      req.params.id as string,
      userId,
      hours,
    );
    sendResponse({ res, message: 'Progress note unlocked for editing', data });
  } catch (err) {
    next(err);
  }
}

export async function relockProgressNote(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const note = await progressNotesService.relockProgressNote(
      tenantId,
      req.params.id as string,
      userId,
    );
    sendResponse({ res, message: 'Progress note re-locked', data: note });
  } catch (err) {
    next(err);
  }
}

export async function listUnlockedProgressNotes(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const query = req.query as { doctorId?: string; mine?: unknown };

    let doctorId: string | undefined;
    if (query.doctorId) {
      doctorId = query.doctorId;
    } else if (query.mine === true || query.mine === 'true') {
      const profile = await (await import('../../config/database')).prisma.doctorProfile.findFirst({
        where: { userId, tenantId },
        select: { id: true },
      });
      doctorId = profile?.id;
      if (!doctorId) {
        sendResponse({ res, message: 'Unlocked progress notes', data: [] });
        return;
      }
    }

    const notes = await progressNotesService.listUnlockedProgressNotes(tenantId, { doctorId });
    sendResponse({ res, message: 'Unlocked progress notes', data: notes });
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

// ============================================================
// Wound Care
// ============================================================

export async function createWoundCare(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const record = await progressNotesService.createWoundCare(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Wound care record created successfully',
      data: record,
    });
  } catch (err) {
    next(err);
  }
}

export async function getWoundCare(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { records, total, page, limit } = await progressNotesService.listWoundCare(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, records, total, page, limit, 'Wound care records retrieved successfully');
  } catch (err) {
    next(err);
  }
}

// ============================================================
// IV Lines
// ============================================================

export async function createIvLine(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const record = await progressNotesService.createIvLine(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'IV line record created successfully',
      data: record,
    });
  } catch (err) {
    next(err);
  }
}

export async function getIvLines(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { records, total, page, limit } = await progressNotesService.listIvLines(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, records, total, page, limit, 'IV line records retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function removeIvLine(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const record = await progressNotesService.removeIvLine(
      tenantId,
      userId,
      req.params.id as string,
      req.body,
    );
    sendResponse({
      res,
      message: 'IV line removed successfully',
      data: record,
    });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Intake / Output
// ============================================================

export async function createIntakeOutput(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const record = await progressNotesService.createIntakeOutput(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Intake/output record created successfully',
      data: record,
    });
  } catch (err) {
    next(err);
  }
}

export async function getIntakeOutput(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { records, total, page, limit, summary } = await progressNotesService.listIntakeOutput(
      tenantId,
      req.query as any,
    );
    // Include intake/output summary totals alongside the records payload.
    res.status(200).json({
      success: true,
      message: 'Intake/output records retrieved successfully',
      data: records,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      summary,
    });
  } catch (err) {
    next(err);
  }
}
