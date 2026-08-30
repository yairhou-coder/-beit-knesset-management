import { config } from './config.js';
import { getDb } from './db/index.js';
import { createApp } from './app.js';

const db = getDb();
const app = createApp(db);

const server = app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`בית המדרש אנשי מעשה - מערכת הניהול פועלת על http://localhost:${config.port}`);
});

function shutdown(signal: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n${signal} התקבל, סוגר את השרת...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
