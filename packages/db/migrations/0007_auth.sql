-- 登入認證＋基本角色（角色化流程第一批，見 docs/gap-analysis-2607.md）
-- 薄權限層：角色決定看得到哪些頁面（頁面級），細粒度資料權限留待後續
-- 密碼 scrypt 雜湊存 DB；session 以隨機 token 存 DB、cookie 帶 HttpOnly

CREATE TYPE user_role AS ENUM ('admin', 'gm', 'finance', 'sales', 'purchasing', 'employee');

CREATE TABLE users (
  id serial PRIMARY KEY,
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,               -- scrypt: s2$<salt b64>$<hash b64>
  role user_role NOT NULL,
  employee_id integer REFERENCES employees(id),  -- 連結員工主檔（報銷「我是誰」）
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
