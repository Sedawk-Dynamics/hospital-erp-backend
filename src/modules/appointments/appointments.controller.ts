import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as appointmentsService from './appointments.service';

// --- Doctor Profiles ---

export async function createDoctorProfile(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const doctor = await appointmentsService.createDoctorProfile(tenantId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Doctor profile created successfully',
      data: doctor,
    });
  } catch (err) {
    next(err);
  }
}

export async function getDoctorProfiles(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { doctors, total, page, limit } = await appointmentsService.getDoctorProfiles(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, doctors, total, page, limit, 'Doctor profiles retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getDoctorProfile(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const doctor = await appointmentsService.getDoctorProfile(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Doctor profile retrieved successfully',
      data: doctor,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateDoctorProfile(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const doctor = await appointmentsService.updateDoctorProfile(tenantId, req.params.id as string, req.body);
    sendResponse({
      res,
      message: 'Doctor profile updated successfully',
      data: doctor,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateDoctorSchedule(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const schedules = await appointmentsService.updateDoctorSchedule(req.params.id as string, req.body);
    sendResponse({
      res,
      message: 'Doctor schedule updated successfully',
      data: schedules,
    });
  } catch (err) {
    next(err);
  }
}

export async function createDoctorLeave(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const leave = await appointmentsService.createDoctorLeave(req.params.id as string, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Doctor leave requested successfully',
      data: leave,
    });
  } catch (err) {
    next(err);
  }
}

export async function getDoctorLeaves(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const leaves = await appointmentsService.getDoctorLeaves(
      req.params.id as string,
      req.query as any,
    );
    sendResponse({
      res,
      message: 'Doctor leaves retrieved successfully',
      data: leaves,
    });
  } catch (err) {
    next(err);
  }
}

export async function listAllDoctorLeaves(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { leaves, total, page, limit } = await appointmentsService.listAllDoctorLeaves(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, leaves, total, page, limit, 'Doctor leave requests retrieved');
  } catch (err) {
    next(err);
  }
}

export async function approveDoctorLeave(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const leave = await appointmentsService.approveDoctorLeave(
      tenantId,
      req.params.leaveId as string,
      userId,
    );
    sendResponse({ res, message: 'Leave approved', data: leave });
  } catch (err) {
    next(err);
  }
}

export async function rejectDoctorLeave(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const leave = await appointmentsService.rejectDoctorLeave(
      tenantId,
      req.params.leaveId as string,
      userId,
      req.body?.reason,
    );
    sendResponse({ res, message: 'Leave rejected', data: leave });
  } catch (err) {
    next(err);
  }
}

export async function cancelDoctorLeave(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const leave = await appointmentsService.cancelDoctorLeave(
      tenantId,
      req.params.leaveId as string,
    );
    sendResponse({ res, message: 'Leave cancelled', data: leave });
  } catch (err) {
    next(err);
  }
}

// ── Schedule Overrides ─────────────────────────────────────

export async function listScheduleOverrides(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await appointmentsService.listScheduleOverrides(
      tenantId,
      req.params.id as string,
      req.query as any,
    );
    sendResponse({ res, message: 'Schedule overrides retrieved', data });
  } catch (err) {
    next(err);
  }
}

export async function upsertScheduleOverride(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await appointmentsService.upsertScheduleOverride(
      tenantId,
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, statusCode: 201, message: 'Schedule override saved', data });
  } catch (err) {
    next(err);
  }
}

export async function bulkApplyOverrides(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await appointmentsService.bulkApplyOverrides(
      tenantId,
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, message: 'Bulk overrides applied', data });
  } catch (err) {
    next(err);
  }
}

export async function deleteScheduleOverride(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await appointmentsService.deleteScheduleOverride(
      tenantId,
      req.params.overrideId as string,
    );
    sendResponse({ res, message: 'Override removed', data });
  } catch (err) {
    next(err);
  }
}

export async function getAvailableSlots(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const date = req.query.date as string;
    const slots = await appointmentsService.getAvailableSlots(tenantId, req.params.id as string, date);
    sendResponse({
      res,
      message: 'Available slots retrieved successfully',
      data: slots,
    });
  } catch (err) {
    next(err);
  }
}

// --- Appointment Stats ---

export async function getAppointmentStats(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const date = req.query.date as string | undefined;
    const stats = await appointmentsService.getAppointmentStats(tenantId, date);
    sendResponse({
      res,
      message: 'Appointment stats retrieved successfully',
      data: stats,
    });
  } catch (err) {
    next(err);
  }
}

// --- Appointments ---

export async function bookAppointment(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const appointment = await appointmentsService.bookAppointment(tenantId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Appointment booked successfully',
      data: appointment,
    });
  } catch (err) {
    next(err);
  }
}

export async function getAppointments(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { appointments, total, page, limit } = await appointmentsService.getAppointments(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(
      res,
      appointments,
      total,
      page,
      limit,
      'Appointments retrieved successfully',
    );
  } catch (err) {
    next(err);
  }
}

export async function getAppointmentById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const appointment = await appointmentsService.getAppointmentById(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Appointment retrieved successfully',
      data: appointment,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateAppointmentStatus(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const appointment = await appointmentsService.updateAppointmentStatus(
      tenantId,
      req.params.id as string,
      req.body,
      userId,
    );
    sendResponse({
      res,
      message: 'Appointment status updated successfully',
      data: appointment,
    });
  } catch (err) {
    next(err);
  }
}

export async function cancelAppointment(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const reason = req.body?.reason;
    const appointment = await appointmentsService.cancelAppointment(
      tenantId,
      req.params.id as string,
      userId,
      reason,
    );
    sendResponse({
      res,
      message: 'Appointment cancelled successfully',
      data: appointment,
    });
  } catch (err) {
    next(err);
  }
}

export async function rescheduleAppointment(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const appointment = await appointmentsService.rescheduleAppointment(
      tenantId,
      req.params.id as string,
      req.body,
      userId,
    );
    sendResponse({
      res,
      message: 'Appointment rescheduled successfully',
      data: appointment,
    });
  } catch (err) {
    next(err);
  }
}

export async function frontdeskCheckout(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const result = await appointmentsService.frontdeskCheckout(
      tenantId,
      req.params.id as string,
      userId,
      req.body,
    );
    const message = result.paymentId
      ? 'Payment collected and bill updated'
      : result.balanceDue <= 0
        // Nothing left to collect — either already settled, or the doctor has
        // no consultation fee configured so the bill is a zero-value record.
        ? result.totalAmount > 0
          ? 'This bill is already fully paid'
          : 'Consultation bill raised (no fee configured for this doctor)'
        : 'Consultation bill raised — payable at the counter';

    sendResponse({ res, message, data: result });
  } catch (err) {
    next(err);
  }
}

export async function initiateFrontdeskPayment(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const result = await appointmentsService.initiateFrontdeskPayment(
      tenantId,
      req.params.id as string,
      userId,
    );
    sendResponse({
      res,
      statusCode: 201,
      message: 'Frontdesk payment bill created',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function getConsultationFormData(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await appointmentsService.getConsultationFormData(
      tenantId,
      req.params.id as string,
    );
    sendResponse({ res, message: 'Consultation form data', data });
  } catch (err) {
    next(err);
  }
}

// --- Queue ---

export async function generateQueueToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const token = await appointmentsService.generateQueueToken(tenantId, req.params.id as string);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Queue token generated successfully',
      data: token,
    });
  } catch (err) {
    next(err);
  }
}

export async function getQueueByDoctor(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const date = req.query.date as string | undefined;
    const queue = await appointmentsService.getQueueByDoctor(
      tenantId,
      req.params.doctorId as string,
      date,
    );
    sendResponse({
      res,
      message: 'Queue retrieved successfully',
      data: queue,
    });
  } catch (err) {
    next(err);
  }
}
