import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 4000),
  simulatorBaseUrl: process.env.SIMULATOR_BASE_URL || 'http://localhost:8000',
  databasePath: process.env.DATABASE_PATH || './data/tierforge.sqlite',
  appName: process.env.APP_NAME || 'TierForge',
};
