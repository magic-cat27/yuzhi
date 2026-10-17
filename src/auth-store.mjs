import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';

const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
export const authError = (status, message) => Object.assign(new Error(message), { status });
const publicUser = user => ({ id:user.id, username:user.username, name:user.name, role:user.role });
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
let hashing = 0;
async function passwordHash(password, salt) {
  if (hashing >= 2) throw authError(429, '登录请求较多，请稍后重试');
  hashing++;
  try { return await derive(password, salt, 64, { N:32768, r:8, p:3, maxmem:64*1024*1024 }); }
  finally { hashing--; }
}

export class AuthStore {
  constructor(directory, { inviteOnly=false }={}) {
    this.inviteOnly=inviteOnly;
    mkdirSync(directory, { recursive:true, mode:0o700 });
    const file = path.join(directory, 'accounts.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('student','teacher')),
        salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS setup (id INTEGER PRIMARY KEY CHECK(id=1), token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (code_hash TEXT PRIMARY KEY, used_by TEXT REFERENCES users(id));`);
  }
  issueInvite() {
    const code=randomBytes(12).toString('hex');
    this.db.prepare('INSERT INTO invites(code_hash) VALUES (?)').run(digest(code));
    return code;
  }
  validInvite(code) {
    return typeof code==='string' && !!this.db.prepare('SELECT 1 FROM invites WHERE code_hash=? AND used_by IS NULL').get(digest(code.trim()));
  }
  close() { this.db.close(); }
  user(id) { const user=this.db.prepare('SELECT id,username,name,role FROM users WHERE id=?').get(id); return user ? publicUser(user) : null; }
  hasTeacher() { return !!this.db.prepare("SELECT 1 FROM users WHERE role='teacher'").get(); }
  issueSetupToken() {
    if(this.hasTeacher()) throw authError(409, '教师账号已创建，不能再次初始化');
    const token=randomBytes(32).toString('base64url');
    this.db.prepare('INSERT OR REPLACE INTO setup VALUES (1,?,?)').run(digest(token),Date.now()+24*60*60*1000);
    return token;
  }
  validSetup(token) {
    if(typeof token!=='string'||token.length!==43||this.hasTeacher()) return false;
    return !!this.db.prepare('SELECT 1 FROM setup WHERE id=1 AND token_hash=? AND expires_at>?').get(digest(token),Date.now());
  }
  throttle(key, limit=15) {
    const now=Date.now();
    this.db.prepare('DELETE FROM attempts WHERE expires_at<=?').run(now);
    this.db.prepare('INSERT INTO attempts VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key,now+15*60*1000);
    if(this.db.prepare('SELECT count FROM attempts WHERE key=?').get(key).count>limit) throw authError(429, '尝试次数过多，请 15 分钟后重试');
  }
  async register(input, teacher=false) {
    const username=typeof input.username==='string'?input.username.trim().toLowerCase():'';
    const name=typeof input.name==='string'?input.name.trim():'';
    if(!/^[a-z0-9_]{3,32}$/.test(username)) throw authError(400,'用户名需要 3–32 位字母、数字或下划线');
    if(!name||name.length>40) throw authError(400,'请填写 1–40 字的姓名');
    if(typeof input.password!=='string'||input.password.length<12||input.password.length>128) throw authError(400,'密码需要 12–128 个字符');
    if(teacher&&!this.validSetup(input.token)) throw authError(403,'初始化链接无效、已过期或已使用');
    if(!teacher&&this.inviteOnly&&!this.validInvite(input.inviteCode)) throw authError(403,'请填写有效且未使用的小组测试邀请码');
    const salt=randomBytes(16).toString('hex');
    const hash=(await passwordHash(input.password,salt)).toString('hex');
    // Recheck the one-use token inside the transaction after the asynchronous KDF.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(teacher&&!this.validSetup(input.token)) throw authError(403,'初始化链接无效、已过期或已使用');
      if(!teacher&&this.inviteOnly&&!this.validInvite(input.inviteCode)) throw authError(403,'邀请码已使用或无效');
      if(this.db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw authError(409,'用户名已被使用');
      const user={id:randomUUID(),username,name,role:teacher?'teacher':'student'};
      this.db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(user.id,username,name,user.role,salt,hash,Date.now());
      if(teacher)this.db.prepare('DELETE FROM setup').run();
      if(!teacher&&this.inviteOnly)this.db.prepare('UPDATE invites SET used_by=? WHERE code_hash=?').run(user.id,digest(input.inviteCode.trim()));
      this.db.exec('COMMIT');
      return user;
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async login(input) {
    if(typeof input.username!=='string'||typeof input.password!=='string'||input.password.length>128) throw authError(400,'请填写用户名和密码');
    const user=this.db.prepare('SELECT * FROM users WHERE username=?').get(input.username.trim().toLowerCase());
    const hash=await passwordHash(input.password,user?.salt||'00000000000000000000000000000000');
    if(!user||!timingSafeEqual(hash,Buffer.from(user.password_hash,'hex'))) throw authError(401,'用户名或密码错误');
    return publicUser(user);
  }
  createSession(user) {
    const now=Date.now(), token=randomBytes(32).toString('base64url'), csrf=randomBytes(32).toString('base64url');
    this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest(token),user.id,csrf,now+sessionLifetime);
    return {token,csrf,user};
  }
  session(token) {
    if(typeof token!=='string'||token.length!==43)return null;
    const row=this.db.prepare('SELECT user_id,csrf FROM sessions WHERE token_hash=? AND expires_at>?').get(digest(token),Date.now());
    return row?{user:this.user(row.user_id),csrf:row.csrf}:null;
  }
  logout(token) { if(token)this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token)); }
}
