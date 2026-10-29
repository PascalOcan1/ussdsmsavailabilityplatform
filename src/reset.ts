import { closeDb, openDb } from './db.ts';
import { resetAll, seedIfEmpty } from './seed.ts';

openDb();
resetAll();
const seeded = seedIfEmpty();
closeDb();
console.log(seeded ? 'Database cleared and reseeded with pilot data.' : 'Database cleared.');
