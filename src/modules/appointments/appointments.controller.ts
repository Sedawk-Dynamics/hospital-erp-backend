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
      message: 'Doctor leave created successfully',
      data: leave,
    });
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
