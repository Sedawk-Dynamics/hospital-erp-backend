import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { formatDateTimeIST } from '../../shared/date.utils';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreateSavedReportInput,
  UpdateSavedReportInput,
  GetSavedReportsQuery,
  GenerateReportInput,
  ExportReportQuery,
  CreateScheduledReportInput,
  UpdateScheduledReportInput,
  GetScheduledReportsQuery,
  CreateSupportTicketInput,
  UpdateSupportTicketInput,
  GetSupportTicketsQuery,
  AddSupportTicketCommentInput,
  CloseSupportTicketInput,
} from './reports.validation';

// ============================================================
// Saved Reports
// ============================================================

export async function createSavedReport(tenantId: string, userId: string, data: CreateSavedReportInput) {
  const report = await prisma.savedReport.create({
    data: {
      tenantId,
      reportName: data.reportName,
      reportType: data.reportType,
      parameters: data.parameters as Prisma.InputJsonValue | undefined,
      fileFormat: data.fileFormat,
      generatedBy: userId,
    },
    include: {
      generator: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, reportId: report.id }, 'Saved report created');
  return report;
}

export async function getSavedReports(tenantId: string, query: GetSavedReportsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.reportType) {
    where.reportType = query.reportType;
  }

  if (query.search) {
    where.OR = [
      { reportName: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [reports, total] = await Promise.all([
    prisma.savedReport.findMany({
      where,
      skip,
      take,
      include: {
        generator: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: query.sortOrder || 'desc' },
    }),
    prisma.savedReport.count({ where }),
  ]);

  return { reports, total, page, limit };
}

export async function getSavedReportById(tenantId: string, id: string) {
  const report = await prisma.savedReport.findFirst({
    where: { id, tenantId },
    include: {
      generator: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });

  if (!report) {
    throw AppError.notFound('Saved report not found');
  }

  return report;
}

export async function updateSavedReport(tenantId: string, id: string, data: UpdateSavedReportInput) {
  const report = await prisma.savedReport.findFirst({
    where: { id, tenantId },
  });

  if (!report) {
    throw AppError.notFound('Saved report not found');
  }

  const updated = await prisma.savedReport.update({
    where: { id },
    data: {
      reportName: data.reportName,
      reportType: data.reportType,
      parameters: data.parameters as Prisma.InputJsonValue | undefined,
      fileFormat: data.fileFormat,
    },
    include: {
      generator: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, reportId: id }, 'Saved report updated');
  return updated;
}

export async function deleteSavedReport(tenantId: string, id: string) {
  const report = await prisma.savedReport.findFirst({
    where: { id, tenantId },
  });

  if (!report) {
    throw AppError.notFound('Saved report not found');
  }

  await prisma.savedReport.delete({ where: { id } });

  logger.info({ tenantId, reportId: id }, 'Saved report deleted');
  return { id };
}

export async function generateReport(
  tenantId: string,
  id: string,
  body?: GenerateReportInput,
) {
  const report = await prisma.savedReport.findFirst({
    where: { id, tenantId },
  });

  if (!report) {
    throw AppError.notFound('Saved report not found');
  }

  const fromDate = body?.fromDate ? new Date(body.fromDate) : undefined;
  const toDate = body?.toDate ? new Date(body.toDate) : undefined;

  const dateFilter: any = {};
  if (fromDate) {
    dateFilter.gte = fromDate;
  }
  if (toDate) {
    dateFilter.lte = toDate;
  }
  const hasDateFilter = Object.keys(dateFilter).length > 0;

  let reportData: any;

  switch (report.reportType) {
    case 'clinical': {
      // Patient summary
      const totalPatients = await prisma.patient.count({ where: { tenantId } });
      const recentPatients = await prisma.patient.count({
        where: {
          tenantId,
          ...(hasDateFilter ? { createdAt: dateFilter } : {}),
        },
      });
      reportData = { type: 'clinical', totalPatients, recentPatients };
      break;
    }

    case 'operational': {
      // Appointment summary
      const totalAppointments = await prisma.appointment.count({
        where: {
          tenantId,
          ...(hasDateFilter ? { appointmentDate: dateFilter } : {}),
        },
      });
      const appointmentsByStatus = await prisma.appointment.groupBy({
        by: ['status'],
        where: {
          tenantId,
          ...(hasDateFilter ? { appointmentDate: dateFilter } : {}),
        },
        _count: { id: true },
      });
      reportData = { type: 'operational', totalAppointments, appointmentsByStatus };
      break;
    }

    case 'financial': {
      // Revenue / billing summary
      const billingAgg = await prisma.bill.aggregate({
        where: {
          tenantId,
          ...(hasDateFilter ? { billDate: dateFilter } : {}),
        },
        _sum: { totalAmount: true, amountPaid: true, balanceDue: true },
        _count: { id: true },
      });
      reportData = {
        type: 'financial',
        totalBills: billingAgg._count.id,
        totalAmount: billingAgg._sum.totalAmount,
        amountPaid: billingAgg._sum.amountPaid,
        balanceDue: billingAgg._sum.balanceDue,
      };
      break;
    }

    case 'inventory': {
      // Department stats as proxy for inventory
      const departments = await prisma.department.findMany({
        where: { tenantId },
        select: {
          id: true,
          name: true,
          isActive: true,
        },
      });
      reportData = {
        type: 'inventory',
        totalDepartments: departments.length,
        departments,
      };
      break;
    }

    default: {
      // Generic report - return basic counts
      const [patientCount, appointmentCount, billCount] = await Promise.all([
        prisma.patient.count({ where: { tenantId } }),
        prisma.appointment.count({
          where: {
            tenantId,
            ...(hasDateFilter ? { appointmentDate: dateFilter } : {}),
          },
        }),
        prisma.bill.count({
          where: {
            tenantId,
            ...(hasDateFilter ? { billDate: dateFilter } : {}),
          },
        }),
      ]);
      reportData = {
        type: report.reportType,
        patientCount,
        appointmentCount,
        billCount,
      };
      break;
    }
  }

  // Update last generated timestamp
  await prisma.savedReport.update({
    where: { id },
    data: { createdAt: new Date() },
  });

  logger.info({ tenantId, reportId: id, reportType: report.reportType }, 'Report generated');
  return {
    reportId: id,
    reportName: report.reportName,
    reportType: report.reportType,
    generatedAt: new Date(),
    filters: { fromDate: body?.fromDate, toDate: body?.toDate, ...body?.filters },
    data: reportData,
  };
}

export async function exportReport(tenantId: string, id: string, query: ExportReportQuery) {
  const report = await prisma.savedReport.findFirst({
    where: { id, tenantId },
  });

  if (!report) {
    throw AppError.notFound('Saved report not found');
  }

  // In a real implementation this would generate a file and return a download URL.
  // For now, return metadata about the export.
  logger.info({ tenantId, reportId: id, format: query.format }, 'Report export requested');
  return {
    reportId: id,
    reportName: report.reportName,
    format: query.format,
    status: 'pending',
    message: `Export in ${query.format} format has been queued for processing`,
  };
}

// ============================================================
// Scheduled Reports
// ============================================================

export async function createScheduledReport(tenantId: string, userId: string, data: CreateScheduledReportInput) {
  const report = await prisma.scheduledReport.create({
    data: {
      tenantId,
      reportName: data.reportName,
      reportType: data.reportType,
      parameters: data.parameters as Prisma.InputJsonValue | undefined,
      schedule: data.schedule,
      deliveryEmail: data.deliveryEmail,
      createdBy: userId,
    },
    include: {
      creator: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, scheduledReportId: report.id }, 'Scheduled report created');
  return report;
}

export async function getScheduledReports(tenantId: string, query: GetScheduledReportsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.isActive !== undefined) {
    where.isActive = query.isActive;
  }

  if (query.schedule) {
    where.schedule = query.schedule;
  }

  if (query.search) {
    where.OR = [
      { reportName: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [reports, total] = await Promise.all([
    prisma.scheduledReport.findMany({
      where,
      skip,
      take,
      include: {
        creator: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: query.sortOrder || 'desc' },
    }),
    prisma.scheduledReport.count({ where }),
  ]);

  return { reports, total, page, limit };
}

export async function getScheduledReportById(tenantId: string, id: string) {
  const report = await prisma.scheduledReport.findFirst({
    where: { id, tenantId },
    include: {
      creator: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });

  if (!report) {
    throw AppError.notFound('Scheduled report not found');
  }

  return report;
}

export async function updateScheduledReport(
  tenantId: string,
  id: string,
  data: UpdateScheduledReportInput,
) {
  const report = await prisma.scheduledReport.findFirst({
    where: { id, tenantId },
  });

  if (!report) {
    throw AppError.notFound('Scheduled report not found');
  }

  const updated = await prisma.scheduledReport.update({
    where: { id },
    data: {
      reportName: data.reportName,
      reportType: data.reportType,
      parameters: data.parameters as Prisma.InputJsonValue | undefined,
      schedule: data.schedule,
      deliveryEmail: data.deliveryEmail,
    },
    include: {
      creator: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, scheduledReportId: id }, 'Scheduled report updated');
  return updated;
}

export async function deleteScheduledReport(tenantId: string, id: string) {
  const report = await prisma.scheduledReport.findFirst({
    where: { id, tenantId },
  });

  if (!report) {
    throw AppError.notFound('Scheduled report not found');
  }

  await prisma.scheduledReport.delete({ where: { id } });

  logger.info({ tenantId, scheduledReportId: id }, 'Scheduled report deleted');
  return { id };
}

export async function toggleScheduledReport(tenantId: string, id: string) {
  const report = await prisma.scheduledReport.findFirst({
    where: { id, tenantId },
  });

  if (!report) {
    throw AppError.notFound('Scheduled report not found');
  }

  const updated = await prisma.scheduledReport.update({
    where: { id },
    data: { isActive: !report.isActive },
    include: {
      creator: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info(
    { tenantId, scheduledReportId: id, isActive: updated.isActive },
    'Scheduled report toggled',
  );
  return updated;
}

// ============================================================
// Support Tickets
// ============================================================

export async function createSupportTicket(tenantId: string, userId: string, data: CreateSupportTicketInput) {
  const ticket = await prisma.supportTicket.create({
    data: {
      tenantId,
      raisedBy: userId,
      subject: data.subject,
      description: data.description,
      priority: data.priority,
    },
    include: {
      raiser: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, supportTicketId: ticket.id }, 'Support ticket created');
  return ticket;
}

export async function getSupportTickets(tenantId: string, query: GetSupportTicketsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.status) {
    where.status = query.status;
  }

  if (query.priority) {
    where.priority = query.priority;
  }

  if (query.search) {
    where.OR = [
      { subject: { contains: query.search, mode: 'insensitive' } },
      { description: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [tickets, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      skip,
      take,
      include: {
        raiser: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: query.sortOrder || 'desc' },
    }),
    prisma.supportTicket.count({ where }),
  ]);

  return { tickets, total, page, limit };
}

export async function getSupportTicketById(tenantId: string, id: string) {
  const ticket = await prisma.supportTicket.findFirst({
    where: { id, tenantId },
    include: {
      raiser: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });

  if (!ticket) {
    throw AppError.notFound('Support ticket not found');
  }

  return ticket;
}

export async function updateSupportTicket(
  tenantId: string,
  id: string,
  data: UpdateSupportTicketInput,
) {
  const ticket = await prisma.supportTicket.findFirst({
    where: { id, tenantId },
  });

  if (!ticket) {
    throw AppError.notFound('Support ticket not found');
  }

  if (ticket.status === 'closed') {
    throw AppError.badRequest('Cannot update a closed support ticket');
  }

  const updated = await prisma.supportTicket.update({
    where: { id },
    data: {
      subject: data.subject,
      description: data.description,
      priority: data.priority,
      status: data.status,
    },
    include: {
      raiser: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, supportTicketId: id }, 'Support ticket updated');
  return updated;
}

export async function addSupportTicketComment(
  tenantId: string,
  id: string,
  userId: string,
  data: AddSupportTicketCommentInput,
) {
  const ticket = await prisma.supportTicket.findFirst({
    where: { id, tenantId },
  });

  if (!ticket) {
    throw AppError.notFound('Support ticket not found');
  }

  if (ticket.status === 'closed') {
    throw AppError.badRequest('Cannot add comment to a closed ticket');
  }

  // Append comment to description since the model doesn't have a separate comments table
  const commentEntry = `\n\n--- Comment by ${userId} at ${formatDateTimeIST(new Date())} ---\n${data.content}`;
  const updatedDescription = (ticket.description || '') + commentEntry;

  const updated = await prisma.supportTicket.update({
    where: { id },
    data: { description: updatedDescription },
    include: {
      raiser: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, supportTicketId: id, commentBy: userId }, 'Comment added to support ticket');
  return updated;
}

export async function closeSupportTicket(
  tenantId: string,
  id: string,
  userId: string,
  data: CloseSupportTicketInput,
) {
  const ticket = await prisma.supportTicket.findFirst({
    where: { id, tenantId },
  });

  if (!ticket) {
    throw AppError.notFound('Support ticket not found');
  }

  if (ticket.status === 'closed') {
    throw AppError.badRequest('Support ticket is already closed');
  }

  const updated = await prisma.supportTicket.update({
    where: { id },
    data: {
      status: 'closed',
      resolutionNotes: data.resolutionNotes,
    },
    include: {
      raiser: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, supportTicketId: id, closedBy: userId }, 'Support ticket closed');
  return updated;
}
