import type { IncomingMessage, ServerResponse } from 'node:http';

export const LIB_DIR: string;
export const BLUEPRINT_DIR: string;
export function localApi(req: IncomingMessage, res: ServerResponse, next: () => void): void;
