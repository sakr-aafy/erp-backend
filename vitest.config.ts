import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', fileParallelism: false, testTimeout: 30000, hookTimeout: 30000,
    env: { NODE_ENV: 'test', MONGO_URI: 'mongodb://127.0.0.1:27017/erp_test?replicaSet=rs0' } },
});
