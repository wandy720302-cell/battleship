// 上班模式：一鍵蓋上假 VSCode。底下遊戲照跑，只是你看起來在寫 TypeScript。
// 唯一的偷看管道是狀態列的錯誤數：輪到你時會從 0 變 1。

const FILES = {
  'userService.ts': {
    icon: 'TS', color: '#3178c6', lang: 'ts', dir: 'src/services',
    body: `import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { CreateUserDto, UpdateUserDto } from '../dto/user.dto';
import { hashPassword } from '../utils/crypto';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  async findAll(page = 1, limit = 20): Promise<{ data: User[]; total: number }> {
    const [data, total] = await this.users.findAndCount({
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });
    return { data, total };
  }

  async findOne(id: string): Promise<User | null> {
    return this.users.findOne({ where: { id } });
  }

  async create(dto: CreateUserDto): Promise<User> {
    const existing = await this.users.findOne({ where: { email: dto.email } });
    if (existing) {
      throw new Error(\`Email already registered: \${dto.email}\`);
    }
    const user = this.users.create({
      ...dto,
      password: await hashPassword(dto.password),
    });
    return this.users.save(user);
  }

  async update(id: string, dto: UpdateUserDto): Promise<User> {
    const user = await this.findOne(id);
    if (!user) throw new Error('User not found');
    // TODO: audit log for role changes
    Object.assign(user, dto);
    return this.users.save(user);
  }

  async remove(id: string): Promise<void> {
    const result = await this.users.softDelete(id);
    if (!result.affected) {
      throw new Error('User not found');
    }
  }
}
`,
  },
  'date.ts': {
    icon: 'TS', color: '#3178c6', lang: 'ts', dir: 'src/utils',
    body: `const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

export function diffDays(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);
}

// ISO week number (Monday-based), per ISO 8601
export function isoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
}

export function formatRelative(from: Date, to: Date = new Date()): string {
  const days = diffDays(from, to);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return \`\${days} days ago\`;
  if (days < 30) return \`\${Math.floor(days / 7)} weeks ago\`;
  return from.toLocaleDateString();
}
`,
  },
  'package.json': {
    icon: '{}', color: '#cbcb41', lang: 'json', dir: '',
    body: `{
  "name": "crm-backend",
  "version": "2.4.1",
  "private": true,
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "lint": "eslint \\"{src,test}/**/*.ts\\" --fix",
    "test": "jest",
    "test:e2e": "jest --config ./test/jest-e2e.json"
  },
  "dependencies": {
    "@nestjs/common": "^10.3.0",
    "@nestjs/core": "^10.3.0",
    "@nestjs/typeorm": "^10.0.1",
    "class-validator": "^0.14.1",
    "pg": "^8.11.3",
    "typeorm": "^0.3.20"
  },
  "devDependencies": {
    "@types/jest": "^29.5.11",
    "@types/node": "^20.11.5",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.2",
    "typescript": "^5.3.3"
  }
}
`,
  },
};

const TREE = [
  { name: 'crm-backend', depth: 0, open: true, folder: true },
  { name: '.github', depth: 1, folder: true },
  { name: 'node_modules', depth: 1, folder: true },
  { name: 'src', depth: 1, open: true, folder: true },
  { name: 'controllers', depth: 2, folder: true },
  { name: 'dto', depth: 2, folder: true },
  { name: 'entities', depth: 2, folder: true },
  { name: 'services', depth: 2, open: true, folder: true },
  { name: 'auth.service.ts', depth: 3, file: null },
  { name: 'userService.ts', depth: 3, file: 'userService.ts' },
  { name: 'utils', depth: 2, open: true, folder: true },
  { name: 'crypto.ts', depth: 3, file: null },
  { name: 'date.ts', depth: 3, file: 'date.ts' },
  { name: 'app.module.ts', depth: 2, file: null },
  { name: 'main.ts', depth: 2, file: null },
  { name: 'test', depth: 1, folder: true },
  { name: '.env', depth: 1, file: null },
  { name: '.eslintrc.js', depth: 1, file: null },
  { name: 'package.json', depth: 1, file: 'package.json' },
  { name: 'README.md', depth: 1, file: null },
  { name: 'tsconfig.json', depth: 1, file: null },
];

const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const KEYWORDS = /\b(import|export|from|const|let|var|function|return|if|else|throw|new|await|async|class|constructor|private|readonly|public|extends|implements|interface|type|null|undefined|true|false|this|typeof|of|in|for|while)\b/g;

// 夠像就好的 tokenizer。單趟掃描：每段原文只被一個 regex 碰一次，
// 不然後面的 regex 會去改前面塞進去的 <span class="..."> 標籤。
function tokenize(s, re, classOf) {
  let out = '', last = 0;
  for (const m of s.matchAll(re)) {
    out += esc(s.slice(last, m.index));
    out += `<span class="${classOf(m)}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}

const TS_TOKEN = new RegExp(
  '(\\/\\/.*$)|(`[^`]*`|\'[^\']*\'|"[^"]*")|(@\\w+)|' + KEYWORDS.source +
  '|\\b([A-Z][A-Za-z0-9]*)\\b|\\b([a-z_][A-Za-z0-9_]*)(?=\\()|\\b(\\d+)\\b', 'g');
const tsClass = m =>
  m[1] ? 'tk-cmt' : m[2] ? 'tk-str' : m[3] ? 'tk-dec' : m[4] ? 'tk-kw'
  : m[5] ? 'tk-type' : m[6] ? 'tk-fn' : 'tk-num';

const JSON_TOKEN = /("[^"]*")(?=\s*:)|("[^"]*")|\b(\d+(?:\.\d+)?)\b|\b(true|false|null)\b/g;
const jsonClass = m => m[1] ? 'tk-prop' : m[2] ? 'tk-str' : m[3] ? 'tk-num' : 'tk-kw';

function highlight(code, lang) {
  const [re, cls] = lang === 'json' ? [JSON_TOKEN, jsonClass] : [TS_TOKEN, tsClass];
  return code.split('\n').map(line => tokenize(line, re, cls));
}

export function initBossMode({ onEnter, onExit }) {
  const root = document.createElement('div');
  root.id = 'bossMode';
  root.hidden = true;
  root.innerHTML = `
    <div class="vs-title">
      <span class="vs-title-left">
        <span class="vs-logo"></span>
        <span class="vs-menu">File</span><span class="vs-menu">Edit</span><span class="vs-menu">Selection</span>
        <span class="vs-menu">View</span><span class="vs-menu">Go</span><span class="vs-menu">Run</span>
        <span class="vs-menu">Terminal</span><span class="vs-menu">Help</span>
      </span>
      <span class="vs-title-center" id="vsTitleText">userService.ts - crm-backend - Visual Studio Code</span>
      <span class="vs-title-right"><span>&#8212;</span><span>&#9633;</span><span>&#10005;</span></span>
    </div>
    <div class="vs-body">
      <div class="vs-activity">
        <span class="vs-act active" title="Explorer">&#9783;</span>
        <span class="vs-act" title="Search">&#9906;</span>
        <span class="vs-act" title="Source Control">&#9095;</span>
        <span class="vs-act" title="Run">&#9655;</span>
        <span class="vs-act" title="Extensions">&#9638;</span>
        <span class="vs-act vs-act-bottom" title="Accounts">&#9711;</span>
        <span class="vs-act" title="Settings">&#9881;</span>
      </div>
      <div class="vs-sidebar">
        <div class="vs-sidebar-head">EXPLORER</div>
        <div class="vs-tree" id="vsTree"></div>
      </div>
      <div class="vs-editor">
        <div class="vs-tabs" id="vsTabs"></div>
        <div class="vs-crumbs" id="vsCrumbs"></div>
        <div class="vs-code-wrap">
          <div class="vs-gutter" id="vsGutter"></div>
          <pre class="vs-code" id="vsCode"></pre>
          <div class="vs-minimap" id="vsMinimap"></div>
        </div>
      </div>
    </div>
    <div class="vs-status">
      <span class="vs-st vs-st-remote">&#8859;</span>
      <span class="vs-st">&#9095; master*</span>
      <span class="vs-st" id="vsProblems"><span class="vs-err">&#8855;</span> 0 <span class="vs-warn">&#9651;</span> 0</span>
      <span class="vs-st-spacer"></span>
      <span class="vs-st" id="vsCursor">Ln 18, Col 42</span>
      <span class="vs-st">Spaces: 2</span>
      <span class="vs-st">UTF-8</span>
      <span class="vs-st">LF</span>
      <span class="vs-st" id="vsLang">TypeScript</span>
      <span class="vs-st">&#9788; Prettier</span>
      <span class="vs-st">&#128276;</span>
    </div>`;
  document.body.appendChild(root);

  const open = ['userService.ts', 'date.ts', 'package.json'];
  let active = 'userService.ts';
  let armed = false;
  let signal = false;
  const savedTitle = document.title;
  const favicon = document.querySelector('link[rel="icon"]');
  const savedIcon = favicon?.href;
  const VS_ICON = 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0078d4"/><path d="M22 6 10 16l12 10z" fill="#fff"/><path d="M22 6v20l6-3V9z" fill="#c5e3ff"/></svg>`);

  function renderTree() {
    const el = root.querySelector('#vsTree');
    el.innerHTML = TREE.map(n => {
      const pad = 8 + n.depth * 12;
      if (n.folder) {
        return `<div class="vs-node" style="padding-left:${pad}px"><span class="vs-chev">${n.open ? '&#9662;' : '&#9656;'}</span>${esc(n.name)}</div>`;
      }
      const f = n.file && FILES[n.file];
      const badge = f ? `<span class="vs-fic" style="color:${f.color}">${f.icon}</span>` : '<span class="vs-fic">&#8801;</span>';
      const cls = n.file === active ? 'vs-node vs-file active' : 'vs-node vs-file';
      return `<div class="${cls}" data-file="${n.file || ''}" style="padding-left:${pad + 14}px">${badge}${esc(n.name)}</div>`;
    }).join('');
  }

  function renderTabs() {
    root.querySelector('#vsTabs').innerHTML = open.map(name => {
      const f = FILES[name];
      return `<span class="vs-tab ${name === active ? 'active' : ''}" data-file="${name}">
        <span class="vs-fic" style="color:${f.color}">${f.icon}</span>${esc(name)}<span class="vs-tab-x">&#10005;</span></span>`;
    }).join('');
  }

  function renderFile() {
    const f = FILES[active];
    const lines = highlight(f.body.replace(/\n$/, ''), f.lang);
    root.querySelector('#vsCode').innerHTML = lines.map((l, i) =>
      `<div class="vs-line${i === 17 && active === 'userService.ts' ? ' cur' : ''}">${l || ' '}</div>`).join('');
    root.querySelector('#vsGutter').innerHTML = lines.map((_, i) => `<div>${i + 1}</div>`).join('');
    root.querySelector('#vsMinimap').innerHTML = lines.map(l => {
      const w = Math.min(100, Math.max(4, l.replace(/<[^>]+>/g, '').length * 1.6));
      return `<div style="width:${w}%"></div>`;
    }).join('');
    root.querySelector('#vsCrumbs').innerHTML =
      (f.dir ? f.dir.split('/').map(esc).join('<span class="vs-crumb-sep">&#8250;</span>') + '<span class="vs-crumb-sep">&#8250;</span>' : '')
      + `<span class="vs-fic" style="color:${f.color}">${f.icon}</span>${esc(active)}`;
    root.querySelector('#vsLang').textContent = f.lang === 'json' ? 'JSON' : 'TypeScript';
    root.querySelector('#vsTitleText').textContent = `${active} - crm-backend - Visual Studio Code`;
    if (armed) document.title = `${active} - crm-backend - Visual Studio Code`;
  }

  function renderAll() { renderTree(); renderTabs(); renderFile(); }

  root.addEventListener('click', e => {
    const t = e.target.closest('[data-file]');
    if (!t || !t.dataset.file) return;
    active = t.dataset.file;
    if (!open.includes(active)) open.push(active);
    renderAll();
  });

  function setSignal(on) {
    signal = on;
    root.querySelector('#vsProblems').innerHTML =
      `<span class="vs-err">&#8855;</span> ${on ? 1 : 0} <span class="vs-warn">&#9651;</span> 0`;
  }

  function enter() {
    if (armed) return;
    armed = true;
    root.hidden = false;
    document.title = `${active} - crm-backend - Visual Studio Code`;
    if (favicon) favicon.href = VS_ICON;
    onEnter?.();
  }

  function exit() {
    if (!armed) return;
    armed = false;
    root.hidden = true;
    document.title = savedTitle;
    if (favicon && savedIcon) favicon.href = savedIcon;
    onExit?.();
  }

  // 熱鍵由 main.js 統一管（Esc 要在幾種上班模式之間協調）。
  renderAll();
  setSignal(false);
  return { enter, exit, toggle: () => (armed ? exit() : enter()), setSignal, get active() { return armed; } };
}
