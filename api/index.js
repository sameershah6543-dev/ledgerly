// Vercel serverless entry: every /api/* request is handled by the Express app.
// Static files (the app itself) are served by Vercel straight from /public.
import { app } from '../server/index.js';
export default app;
