import type { PrismaClient } from '@prisma/client';

declare global {
	namespace App {
		interface Locals {
			dangerousDb: PrismaClient;
			user?: { isAdmin: boolean; id: string } | null;
		}
	}
}

export {};
