import { Router } from 'express';
import multer from 'multer';

import { jobsController } from '../controllers/jobsController.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.get('/', jobsController.list);
router.post('/', upload.single('file'), jobsController.create);
router.post('/:jobId/retry-failed', jobsController.retryFailed);
router.get('/:jobId/stores', jobsController.stores);
router.get('/:jobId', jobsController.get);
router.post('/:jobId/score', jobsController.score);

export default router;
