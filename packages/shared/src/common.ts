import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email().max(255);
