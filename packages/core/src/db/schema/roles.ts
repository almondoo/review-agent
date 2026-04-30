import { pgRole } from 'drizzle-orm/pg-core';

export const appRole = pgRole('review_agent_app', { inherit: true });
