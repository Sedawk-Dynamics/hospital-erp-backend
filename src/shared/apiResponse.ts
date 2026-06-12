import { Response } from 'express';

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface ApiResponseOptions<T> {
  res: Response;
  statusCode?: number;
  success?: boolean;
  message?: string;
  data?: T;
  // `summary` is an optional, endpoint-specific roll-up (e.g. the pharmacy
  // Transactions page's period totals) carried alongside pagination.
  meta?: PaginationMeta & { summary?: unknown };
}

export function sendResponse<T>({
  res,
  statusCode = 200,
  success = true,
  message = 'Success',
  data,
  meta,
}: ApiResponseOptions<T>) {
  return res.status(statusCode).json({
    success,
    message,
    data: data ?? null,
    ...(meta && { meta }),
  });
}

export function sendPaginatedResponse<T>(
  res: Response,
  data: T[],
  total: number,
  page: number,
  limit: number,
  message = 'Success',
) {
  return sendResponse({
    res,
    data,
    message,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}
