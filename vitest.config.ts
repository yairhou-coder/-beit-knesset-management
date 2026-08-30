import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    // הטסטים משתמשים בבסיס נתונים בזיכרון ובספקי Mock, ולכן אין תלות חיצונית.
    pool: 'forks',
  },
});
