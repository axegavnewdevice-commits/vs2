import { createService } from './service.js';
import { supabaseBackend } from './backend-supabase.js';
import { buildRoutes } from './routes.js';

export const routes = buildRoutes({ backend: supabaseBackend, service: createService(supabaseBackend) });
