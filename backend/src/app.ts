import cors from 'cors';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { randomUUID } from 'node:crypto';

import { ApiError } from './lib/apiError.js';
import { logger } from './lib/logger.js';
import dashboardRoutes from './routes/dashboard.js';
import jobRoutes from './routes/jobs.js';

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use((request, response, next) => {
  const requestId = randomUUID();
  const startedAt = Date.now();
  response.setHeader('X-Request-Id', requestId);
  response.once('finish', () => {
    const context = {
      requestId,
      method: request.method,
      path: request.originalUrl.split('?')[0],
      status: response.statusCode,
      durationMs: Date.now() - startedAt,
    };
    if (response.statusCode >= 500) {
      logger.error('http.request.completed', context);
    } else if (response.statusCode >= 400) {
      logger.warn('http.request.completed', context);
    } else {
      logger.info('http.request.completed', context);
    }
  });
  next();
});

app.get('/health', (_req, res) => {
  res.json({ data: { status: 'ok' } });
});

app.use('/api/jobs', jobRoutes);
app.use('/api/dashboard', dashboardRoutes);

app.use((_request, response) => {
  response.status(404).json({
    error: { code: 'NOT_FOUND', message: 'API endpoint not found.' },
  });
});

const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _req,
  res,
  _next,
) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({
      error: {
        code: error.code,
        message: `CSV upload failed: ${error.message}`,
      },
    });
  }
  if (error instanceof ApiError) {
    return res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
  }
  if (
    error instanceof SyntaxError &&
    'status' in error &&
    error.status === 400
  ) {
    return res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'Request body must contain valid JSON.',
      },
    });
  }
  logger.error('http.request.unhandled_error', {
    message: error instanceof Error ? error.message : 'Unknown error',
  });
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected server error occurred.',
    },
  });
};

app.use(errorHandler);

export default app;
