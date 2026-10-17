import { AuthStore } from '../src/auth-store.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const store=new AuthStore(process.env.AUTH_DATA_DIR||path.join(root,'data/auth'));
try {
  const token=store.issueSetupToken();
  const origin=process.env.APP_ORIGIN||`http://127.0.0.1:${process.env.PORT||4173}`;
  console.log(`教师初始化链接（24 小时有效，仅供管理员使用）：\n${origin}/#/setup-teacher?token=${token}\n创建成功后链接立即失效。再次运行此命令会使旧链接失效。`);
} catch(error) { console.error(error.message); process.exitCode=1; }
finally { store.close(); }
