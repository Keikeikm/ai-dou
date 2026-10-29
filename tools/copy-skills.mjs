import { cpSync } from 'node:fs';

cpSync(new URL('../skills/', import.meta.url), new URL('../dist/skills/', import.meta.url), { recursive: true });
