process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5433/bv_agent_msg_test';
process.env.CREDENTIAL_KEY = Buffer.alloc(32, 3).toString('base64');
process.env.CREDENTIAL_KEY_ID = 'v1';
process.env.APP_URL = 'http://localhost:3000';
process.env.META_APP_SECRET = 'testsecret';
process.env.META_VERIFY_TOKEN = 'verify-token';
process.env.LLM_PROVIDERS = '[]';
process.env.WORKER_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.PORT = '3001';
process.env.SETUP_TOKEN = 'setup-token';
