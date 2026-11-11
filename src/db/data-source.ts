import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { credentials } from '../config/credentials';

// Shared by the Nest app (app.module.ts) and the TypeORM CLI (npm run db:migrate).
// synchronize is OFF: schema changes only through migrations.
export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: credentials.db.host,
  port: credentials.db.port,
  username: credentials.db.username,
  password: credentials.db.password,
  database: credentials.db.database,
  synchronize: false,
  entities: [__dirname + '/../**/*.entity.{ts,js}'],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  extra: { max: credentials.db.poolMax },
};

export default new DataSource(dataSourceOptions);
