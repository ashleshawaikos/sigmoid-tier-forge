import type { Request, Response } from 'express';

import { jobService } from '../services/tierforgeServices.js';

export const dashboardController = {
  get(_request: Request, response: Response): void {
    response.json({ data: { latestJob: jobService.getDashboard() } });
  },
};
