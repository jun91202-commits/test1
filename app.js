'use strict';
/* ============================================================
   AssetFlow — app.js
   100% Client-Side | LocalStorage | Zero Network Leakage
   ============================================================ */

/* ────────────────────────────────────────────
   CONFIG
   ──────────────────────────────────────────── */
const CONFIG = {
  STORAGE_ASSETS: 'af_assets_v1',
  STORAGE_HISTORY: 'af_history_v1',
  // Target asset allocation (%) — used for macro rebalancing advice
  TARGET: { '주식': 50, '현금': 20, '부동산': 20, '암호화폐': 10 },
  REBALANCE_THRESHOLD: 5,   // % deviation to trigger macro alert
  MICRO_WEIGHT_ALERT: 20,  // individual asset % of total to trigger micro alert
  LOSS_ALERT_PCT: -15,  // % return to trigger loss alert
  VERSION: '1.0.0'
};

/* ────────────────────────────────────────────
   STATE — single source of truth
   ──────────────────────────────────────────── */
const S = {
  assets: [],
  history: {},    // { 'YYYY-MM': { 주식: N, 현금: N, ... } }
  errors: [],    // parse errors
  dismissedErrors: new Set(),
  privacy: false,
  filter: 'all',
  sortCol: null,
  sortDir: 'asc',
  chartMode: 'area',
  feedTab: 'macro',
  feedOpen: false,
  donutChart: null,
  histChart: null
};

/* ────────────────────────────────────────────
   UTILS
   ──────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

const KRW = (v) => {
  if (v === null || v === undefined || isNaN(v)) return '-';
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency', currency: 'KRW', maximumFractionDigits: 0
  }).format(v);
};

const PCT = (v) => {
  if (v === null || v === undefined || isNaN(v)) return '-';
  return `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
};

const NUM = (v) => {
  if (v === null || v === undefined || isNaN(v)) return '-';
  return new Intl.NumberFormat('ko-KR').format(v);
};

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => new Date().toISOString().slice(0, 10);
const month = () => new Date().toISOString().slice(0, 7);

/* ────────────────────────────────────────────
   STORAGE MODULE
   Partial update (patchAsset) avoids full re-serialization cost.
   ──────────────────────────────────────────── */
const Storage = {
  load() {
    try {
      const a = localStorage.getItem(CONFIG.STORAGE_ASSETS);
      const h = localStorage.getItem(CONFIG.STORAGE_HISTORY);
      if (a) S.assets = JSON.parse(a);
      if (h) S.history = JSON.parse(h);
    } catch (e) { console.warn('[Storage] load failed:', e); }
  },

  saveAll() {
    try {
      localStorage.setItem(CONFIG.STORAGE_ASSETS, JSON.stringify(S.assets));
      localStorage.setItem(CONFIG.STORAGE_HISTORY, JSON.stringify(S.history));
    } catch (e) { console.warn('[Storage] saveAll failed:', e); }
  },

  /** Partial update — only touches a single asset's changed fields in localStorage.
   *  State (S.assets) must be updated before calling this. */
  patchAsset(id, diff) {
    const idx = S.assets.findIndex(a => a.id === id);
    if (idx === -1) return;
    Object.assign(S.assets[idx], diff);
    try {
      localStorage.setItem(CONFIG.STORAGE_ASSETS, JSON.stringify(S.assets));
    } catch (e) { console.warn('[Storage] patch failed:', e); }
  },

  clear() {
    localStorage.removeItem(CONFIG.STORAGE_ASSETS);
    localStorage.removeItem(CONFIG.STORAGE_HISTORY);
  }
};

/* ────────────────────────────────────────────
   CSV PARSER — Custom regex-based (no PapaParse)
   Keeps bundle minimal for Netlify/GitHub Pages.
   ──────────────────────────────────────────── */
const Parser = {
  /**
   * Parses a CSV string into assets + errors.
   * Skips fatally invalid rows but continues with the rest.
   */
  parseCSV(text) {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
    if (lines.length < 2) return { assets: [], errors: ['CSV 파일이 비어있거나 헤더가 없습니다.'] };

    const header = this._split(lines[0]).map(h => h.trim());
    const errors = [];
    const assets = [];

    // Flexible column detection
    const find = (...keys) => header.findIndex(h =>
      keys.some(k => h === k || h.toLowerCase() === k.toLowerCase())
    );

    const C = {
      구분: find('자산구분', 'category', 'type', '분류'),
      명: find('자산명', '종목명', 'name', '상품명'),
      코드: find('종목코드', 'ticker', 'code', '코드'),
      수량: find('수량', 'quantity', 'qty'),
      매입가: find('매입단가', '매입가', 'purchase_price', '취득가'),
      현재가: find('현재가', 'current_price', 'price'),
      평가액: find('평가금액', 'total_value', 'market_value', '평가액'),
      수익률: find('수익률', 'return', 'return_pct'),
      메모: find('메모', 'note', 'memo', '비고', 'description')
    };

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const row = this._split(lines[i]);
      const lineNum = i + 1;

      const get = (key, def = '') => {
        const idx = C[key];
        return idx >= 0 && row[idx] !== undefined ? row[idx].trim() : def;
      };
      const getNum = (key) => {
        const raw = get(key, '');
        if (!raw) return null;
        const n = parseFloat(raw.replace(/,/g, ''));
        return isNaN(n) ? null : n;
      };

      const cat = get('구분');
      if (!cat) {
        errors.push(`⚠️ ${lineNum}행: 자산구분 값이 없습니다. 해당 행을 건너뜁니다.`);
        continue;
      }

      const VALID_CATS = ['주식', '현금', '부동산', '암호화폐', '부채'];
      if (!VALID_CATS.includes(cat)) {
        errors.push(`⚠️ ${lineNum}행 [${esc(cat)}]: 유효하지 않은 자산구분 (주식/현금/부동산/암호화폐/부채 중 하나여야 함)`);
      }

      const qtyRaw = get('수량', '1');
      const qty = parseFloat(qtyRaw.replace(/,/g, ''));
      if (qtyRaw && isNaN(qty)) {
        errors.push(`⚠️ ${lineNum}행 [${esc(get('명'))}]: 수량 값 "${esc(qtyRaw)}" 형식 오류. 해당 행을 건너뜁니다.`);
        continue;
      }

      const buyPrice = getNum('매입가') ?? 0;
      const curPrice = getNum('현재가') ?? 0;
      let totalVal = getNum('평가액');
      let retPct = getNum('수익률');

      // Auto-calculate missing fields
      if (totalVal === null && curPrice && !isNaN(qty)) totalVal = qty * curPrice;
      if (totalVal === null) totalVal = 0;
      if (retPct === null && buyPrice > 0 && curPrice) retPct = ((curPrice - buyPrice) / buyPrice) * 100;
      if (retPct === null) retPct = 0;

      assets.push({
        id: uid(),
        자산구분: cat,
        자산명: get('명', `자산${i}`),
        종목코드: get('코드'),
        수량: isNaN(qty) ? 1 : qty,
        매입단가: buyPrice,
        현재가: curPrice,
        평가금액: totalVal,
        수익률: retPct,
        메모: get('메모')
      });
    }

    return { assets, errors };
  },

  /** RFC 4180-compliant CSV line splitter — handles quoted fields and embedded commas */
  _split(line) {
    const result = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) {
        result.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    result.push(cur);
    return result;
  },

  /** Parse JSON backup file */
  parseJSON(text) {
    try {
      const data = JSON.parse(text);
      // Official backup format
      if (data.version && Array.isArray(data.assets)) {
        return { assets: data.assets, history: data.history || {}, errors: [] };
      }
      // Raw array
      if (Array.isArray(data)) {
        return { assets: data.map(a => ({ id: a.id || uid(), ...a })), history: {}, errors: [] };
      }
      return { assets: [], history: {}, errors: ['JSON 형식을 인식할 수 없습니다. 올바른 백업 파일인지 확인하세요.'] };
    } catch (e) {
      return { assets: [], history: {}, errors: [`JSON 파싱 오류: ${e.message}`] };
    }
  }
};

/* ────────────────────────────────────────────
   CALCULATOR MODULE
   ──────────────────────────────────────────── */
const Calc = {
  nonDebt: () => S.assets.filter(a => a.자산구분 !== '부채'),
  debts: () => S.assets.filter(a => a.자산구분 === '부채'),
  total: () => Calc.nonDebt().reduce((s, a) => s + (a.평가금액 || 0), 0),
  totalDebt: () => Math.abs(Calc.debts().reduce((s, a) => s + (a.평가금액 || 0), 0)),
  netWorth: () => Calc.total() - Calc.totalDebt(),
  debtRatio: () => { const t = Calc.total(); return t > 0 ? (Calc.totalDebt() / t) * 100 : 0; },

  byCategory() {
    const r = {};
    Calc.nonDebt().forEach(a => { r[a.자산구분] = (r[a.자산구분] || 0) + (a.평가금액 || 0); });
    return r;
  },

  weight(asset) {
    const t = Calc.total();
    return t > 0 ? ((asset.평가금액 || 0) / t) * 100 : 0;
  },

  needsRebalance(asset) {
    return Calc.weight(asset) >= CONFIG.MICRO_WEIGHT_ALERT ||
      asset.수익률 <= CONFIG.LOSS_ALERT_PCT;
  },

  /** Generate Type-C Composite Rebalancing Advice */
  advice() {
    const total = Calc.total();
    if (total === 0) return { macro: [], micro: [] };
    const byCat = Calc.byCategory();
    const macro = [], micro = [];

    // ── Macro: category-level advice ──
    Object.entries(CONFIG.TARGET).forEach(([cat, target]) => {
      const cur = ((byCat[cat] || 0) / total) * 100;
      const diff = cur - target;
      if (Math.abs(diff) < CONFIG.REBALANCE_THRESHOLD) return;
      const amount = Math.abs((diff / 100) * total);
      if (diff > 0) {
        macro.push({
          type: 'sell', severity: diff > 10 ? 'high' : 'medium',
          text: `${cat}이(가) 목표 배분 대비 +${diff.toFixed(1)}% 초과.\n${KRW(amount)} 매도를 권장합니다.`
        });
      } else {
        macro.push({
          type: 'buy', severity: Math.abs(diff) > 10 ? 'high' : 'medium',
          text: `${cat}이(가) 목표 배분 대비 ${diff.toFixed(1)}% 부족.\n${KRW(amount)} 추가 매수를 권장합니다.`
        });
      }
    });

    if (!macro.length) {
      macro.push({ type: 'info', severity: 'low', text: '자산 배분이 목표 범위 내에 있습니다. ✓' });
    }

    // ── Micro: individual asset advice ──
    Calc.nonDebt().forEach(a => {
      const w = Calc.weight(a);
      if (w >= CONFIG.MICRO_WEIGHT_ALERT) {
        micro.push({
          type: 'warning', severity: w >= 30 ? 'high' : 'medium',
          text: `${esc(a.자산명)}이(가) 전체 포트폴리오의 ${w.toFixed(1)}%를 차지합니다.\n리스크 분산을 검토하세요.`
        });
      }
      if (a.수익률 <= CONFIG.LOSS_ALERT_PCT) {
        micro.push({
          type: 'warning', severity: a.수익률 <= -25 ? 'high' : 'medium',
          text: `${esc(a.자산명)} 손실률 ${a.수익률.toFixed(1)}%.\n손절 또는 추가 매수 전략을 검토하세요.`
        });
      }
    });

    if (!micro.length) {
      micro.push({ type: 'info', severity: 'low', text: '위험 수준을 초과하는 개별 자산이 없습니다. ✓' });
    }

    return { macro, micro };
  },

  /** Save current month snapshot into history */
  snapshot() {
    S.history[month()] = Calc.byCategory();
    Storage.saveAll();
  }
};

/* ────────────────────────────────────────────
   SAMPLE DATA — 가상 1억원 포트폴리오
   ──────────────────────────────────────────── */
function loadSampleData() {
  S.assets = [
    { id: uid(), 자산구분: '주식', 자산명: '삼성전자', 종목코드: '005930', 수량: 200, 매입단가: 65000, 현재가: 72000, 평가금액: 14400000, 수익률: 10.77, 메모: '국내 반도체' },
    { id: uid(), 자산구분: '주식', 자산명: 'Apple (AAPL)', 종목코드: 'AAPL', 수량: 20, 매입단가: 185000, 현재가: 220000, 평가금액: 4400000, 수익률: 18.92, 메모: '미국 빅테크' },
    { id: uid(), 자산구분: '주식', 자산명: 'NVIDIA (NVDA)', 종목코드: 'NVDA', 수량: 8, 매입단가: 400000, 현재가: 850000, 평가금액: 6800000, 수익률: 112.50, 메모: 'AI 반도체' },
    { id: uid(), 자산구분: '주식', 자산명: 'SK하이닉스', 종목코드: '000660', 수량: 120, 매입단가: 120000, 현재가: 108000, 평가금액: 12960000, 수익률: -10.00, 메모: 'HBM 메모리' },
    { id: uid(), 자산구분: '주식', 자산명: 'LG에너지솔루션', 종목코드: '373220', 수량: 10, 매입단가: 430000, 현재가: 380000, 평가금액: 3800000, 수익률: -11.63, 메모: '2차전지' },
    { id: uid(), 자산구분: '주식', 자산명: '카카오', 종목코드: '035720', 수량: 100, 매입단가: 54000, 현재가: 38000, 평가금액: 3800000, 수익률: -29.63, 메모: '국내 IT' },
    { id: uid(), 자산구분: '현금', 자산명: 'KB 정기예금', 종목코드: '', 수량: 1, 매입단가: 15000000, 현재가: 15000000, 평가금액: 15000000, 수익률: 3.50, 메모: '12개월 만기' },
    { id: uid(), 자산구분: '현금', 자산명: '토스뱅크 파킹통장', 종목코드: '', 수량: 1, 매입단가: 5000000, 현재가: 5000000, 평가금액: 5000000, 수익률: 2.30, 메모: '수시 입출금' },
    { id: uid(), 자산구분: '부동산', 자산명: '마포 전세보증금', 종목코드: '', 수량: 1, 매입단가: 20000000, 현재가: 20000000, 평가금액: 20000000, 수익률: 0.00, 메모: '2026.06 만기' },
    { id: uid(), 자산구분: '암호화폐', 자산명: 'Bitcoin (BTC)', 종목코드: 'BTC', 수량: 0.10, 매입단가: 60000000, 현재가: 85000000, 평가금액: 8500000, 수익률: 41.67, 메모: '장기보유' },
    { id: uid(), 자산구분: '암호화폐', 자산명: 'Ethereum (ETH)', 종목코드: 'ETH', 수량: 0.50, 매입단가: 3000000, 현재가: 4200000, 평가금액: 2100000, 수익률: 40.00, 메모: '디파이' },
    { id: uid(), 자산구분: '부채', 자산명: '학자금 대출', 종목코드: '', 수량: 1, 매입단가: -5000000, 현재가: -5000000, 평가금액: -5000000, 수익률: 0.00, 메모: '연 2.5%' }
  ];

  // 6개월 샘플 히스토리 생성
  const base = { '주식': 46160000, '현금': 20000000, '부동산': 20000000, '암호화폐': 10600000 };
  const factors = [0.74, 0.80, 0.86, 0.91, 0.96, 1.00];
  S.history = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    const key = d.toISOString().slice(0, 7);
    S.history[key] = {};
    Object.entries(base).forEach(([cat, val]) => {
      const noise = 0.96 + Math.random() * 0.08;
      S.history[key][cat] = Math.round(val * factors[5 - i] * noise);
    });
  }

  S.errors = [];
  S.dismissedErrors = new Set();
  Storage.saveAll();
}

/* ────────────────────────────────────────────
   EXPORT FUNCTIONS
   ──────────────────────────────────────────── */
function exportBackup() {
  const data = {
    version: CONFIG.VERSION,
    exportedAt: new Date().toISOString(),
    assets: S.assets,
    history: S.history
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  _download(blob, `my_asset_history_${today()}.json`);
}

function downloadTemplate() {
  const BOM = '\uFEFF';
  const rows = [
    '자산구분,자산명,종목코드,수량,매입단가,현재가,평가금액,수익률,메모',
    '주식,삼성전자,005930,100,65000,72000,7200000,10.77,=GOOGLEFINANCE("KRX:005930") 로 현재가 채우기',
    '주식,Apple (AAPL),AAPL,10,185000,220000,2200000,18.92,=GOOGLEFINANCE("NASDAQ:AAPL")',
    '현금,KB 정기예금,,1,15000000,15000000,15000000,3.5,12개월 만기',
    '부동산,마포 전세보증금,,1,20000000,20000000,20000000,0,2년 계약',
    '암호화폐,Bitcoin (BTC),BTC,0.1,60000000,85000000,8500000,41.67,장기보유',
    '부채,신용대출,,1,-3000000,-3000000,-3000000,0,연 4.5% 금리'
  ];
  const blob = new Blob([BOM + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  _download(blob, 'assetflow_template.csv');
}

function _download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ────────────────────────────────────────────
   RENDERER MODULE
   ──────────────────────────────────────────── */
const R = {
  init() {
    const hasData = S.assets.length > 0;
    $('screen-onboarding').classList.toggle('hidden', hasData);
    $('screen-dashboard').classList.toggle('hidden', !hasData);
    $('export-btn').style.visibility = 'visible';
    $('feed-toggle-btn').style.visibility = hasData ? 'visible' : 'hidden';

    $('header-date').textContent = new Date().toLocaleDateString('ko-KR', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
    });

    if (hasData) this.dashboard();
  },

  dashboard() {
    this.cards();
    this.donut();
    this.history();
    this.table();
    this.feed();
  },

  /* ── Summary Cards ── */
  cards() {
    const t = Calc.total();
    const n = Calc.netWorth();
    const td = Calc.totalDebt();
    const dr = Calc.debtRatio();

    $('val-total').textContent = KRW(t);
    $('sub-total').textContent = `${Calc.nonDebt().length}개 자산 보유`;
    $('val-networth').textContent = KRW(n);
    $('sub-networth').textContent = `부채 ${KRW(td)} 차감`;

    const debtEl = $('val-debt');
    debtEl.textContent = dr.toFixed(1) + '%';
    debtEl.className = 's-value' +
      (dr > 40 ? ' neg' : dr < 20 ? ' pos' : '');
    $('sub-debt').textContent = `부채 ${KRW(td)}`;
  },

  /* ── Donut Chart ── */
  donut() {
    const byCat = Calc.byCategory();
    const cats = Object.keys(byCat).filter(c => byCat[c] > 0);
    const vals = cats.map(c => byCat[c]);
    const COLORS = { '주식': '#38BDF8', '현금': '#4ADE80', '부동산': '#FB923C', '암호화폐': '#A78BFA' };
    const colors = cats.map(c => COLORS[c] || '#94A3B8');

    const ctx = $('donut-chart').getContext('2d');
    if (S.donutChart) { S.donutChart.destroy(); S.donutChart = null; }

    S.donutChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: cats,
        datasets: [{
          data: vals,
          backgroundColor: colors.map(c => c + '22'),
          borderColor: colors,
          borderWidth: 2,
          hoverOffset: 5
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '68%',
        animation: { duration: 200 },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const pct = Calc.total() > 0
                  ? ((ctx.raw / Calc.total()) * 100).toFixed(1) : 0;
                return ` ${KRW(ctx.raw)} (${pct}%)`;
              }
            }
          }
        }
      }
    });

    const total = Calc.total();
    $('donut-legend').innerHTML = cats.map((cat, i) => `
      <div class="legend-item">
        <div class="legend-left">
          <div class="legend-dot" style="background:${colors[i]}"></div>
          <span class="legend-name">${esc(cat)}</span>
        </div>
        <span class="legend-val sensitive-value">
          ${total > 0 ? ((vals[i] / total) * 100).toFixed(1) : 0}%
        </span>
      </div>`).join('');
  },

  /* ── History Chart (Stacked Area ↔ Grouped Bar) ── */
  history() {
    const ctx = $('history-chart').getContext('2d');
    if (S.histChart) { S.histChart.destroy(); S.histChart = null; }

    const keys = Object.keys(S.history).sort();
    if (!keys.length) return;

    const labels = keys.map(k => `${parseInt(k.slice(5))}월`);
    const CATS = ['주식', '현금', '부동산', '암호화폐'];
    const CM = {
      '주식': ['#38BDF8', 'rgba(56,189,248,0.28)'],
      '현금': ['#4ADE80', 'rgba(74,222,128,0.28)'],
      '부동산': ['#FB923C', 'rgba(251,146,60,0.28)'],
      '암호화폐': ['#A78BFA', 'rgba(167,139,250,0.28)']
    };

    const isArea = S.chartMode === 'area';

    const datasets = CATS.map(cat => ({
      label: cat,
      data: keys.map(k => S.history[k]?.[cat] || 0),
      backgroundColor: CM[cat][1],
      borderColor: CM[cat][0],
      borderWidth: 2,
      fill: isArea,
      tension: isArea ? 0.3 : 0,
      pointRadius: 3, pointHoverRadius: 5
    }));

    S.histChart = new Chart(ctx, {
      type: isArea ? 'line' : 'bar',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 200 },
        interaction: { mode: 'index' },
        plugins: {
          legend: {
            position: 'top', align: 'end',
            labels: { color: 'rgba(255,255,255,0.38)', font: { size: 11 }, boxWidth: 10, padding: 12 }
          },
          tooltip: {
            callbacks: { label: c => ` ${c.dataset.label}: ${KRW(c.raw)}` }
          }
        },
        scales: {
          x: {
            stacked: isArea,
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: 'rgba(255,255,255,0.28)', font: { size: 11 } }
          },
          y: {
            stacked: isArea,
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: {
              color: 'rgba(255,255,255,0.28)', font: { size: 11 },
              callback: v => {
                if (v >= 1e8) return (v / 1e8).toFixed(1) + '억';
                if (v >= 1e7) return (v / 1e7).toFixed(0) + '천만';
                if (v >= 1e4) return (v / 1e4).toFixed(0) + '만';
                return NUM(v);
              }
            }
          }
        }
      }
    });
  },

  /* ── Master Table ── */
  table(filter) {
    const f = filter !== undefined ? filter : S.filter;
    const total = Calc.total();

    let rows = [...S.assets];

    // Sort
    if (S.sortCol) {
      rows.sort((a, b) => {
        const va = a[S.sortCol], vb = b[S.sortCol];
        const d = S.sortDir === 'asc' ? 1 : -1;
        if (typeof va === 'number') return (va - vb) * d;
        return String(va ?? '').localeCompare(String(vb ?? ''), 'ko') * d;
      });
    }

    const tbody = $('table-body');
    tbody.classList.add('fading');

    setTimeout(() => {
      tbody.innerHTML = rows.map(a => {
        const w = total > 0 ? ((a.평가금액 || 0) / total) * 100 : 0;
        const rc = a.수익률 > 0 ? 'pos' : a.수익률 < 0 ? 'neg' : '';
        const isDebt = a.자산구분 === '부채';
        const show = f === 'all' ? true
          : f === 'stock' ? a.자산구분 === '주식'
            : f === 'loss' ? (a.수익률 < 0 && !isDebt)
              : f === 'rebalance' ? (Calc.needsRebalance(a) && !isDebt)
                : true;

        return `<tr data-id="${a.id}" ${show ? '' : 'style="display:none"'}>
          <td><span class="cat-badge cat-${esc(a.자산구분)}">${esc(a.자산구분)}</span></td>
          <td>${esc(a.자산명)}</td>
          <td class="td-code">${esc(a.종목코드) || '-'}</td>
          <td class="num-col">${NUM(a.수량)}</td>
          <td class="num-col sensitive-value">${a.매입단가 ? KRW(a.매입단가) : '-'}</td>
          <td class="num-col editable sensitive-value" data-field="현재가" data-raw="${a.현재가}">${a.현재가 ? KRW(a.현재가) : '-'}</td>
          <td class="num-col sensitive-value">${KRW(a.평가금액)}</td>
          <td class="num-col ${rc}">${PCT(a.수익률)}</td>
          <td class="num-col">${w.toFixed(1)}%</td>
          <td class="editable" data-field="메모" data-raw="${esc(a.메모 || '')}">${esc(a.메모) || '-'}</td>
        </tr>`;
      }).join('');

      tbody.classList.remove('fading');
    }, 150);
  },

  /* ── Rebalancing Feed ── */
  feed() {
    const adv = Calc.advice();
    const errors = S.errors.filter(e => !S.dismissedErrors.has(e));

    const macroItems = [
      ...errors.map(e => ({ type: 'error', text: e, key: e })),
      ...adv.macro
    ];
    const microItems = adv.micro;

    this._feedRender(S.feedTab === 'macro' ? macroItems : microItems);
    this._badge();
  },

  _feedRender(items) {
    const fc = $('feed-content');
    const TYPE_LABEL = { sell: '매도 권장', buy: '매수 권장', warning: '주의 필요', info: '정상' };

    if (!items.length) {
      fc.innerHTML = '<p class="feed-empty">알림이 없습니다.</p>';
      return;
    }

    fc.innerHTML = items.map(item => {
      if (item.type === 'error') {
        return `<div class="feed-item error-item">
          <div class="feed-error-head">
            <span>${esc(item.text)}</span>
            <button class="dismiss-btn" data-key="${esc(item.key || item.text)}" title="닫기">×</button>
          </div>
        </div>`;
      }
      return `<div class="feed-item ${item.severity || ''}">
        <div class="feed-item-type ${item.type}">${TYPE_LABEL[item.type] || item.type}</div>
        <div class="feed-item-text">${item.text.replace(/\n/g, '<br>')}</div>
      </div>`;
    }).join('');
  },

  _badge() {
    const adv = Calc.advice();
    const errors = S.errors.filter(e => !S.dismissedErrors.has(e));
    const high = errors.length
      + adv.macro.filter(a => a.severity === 'high').length
      + adv.micro.filter(a => a.severity === 'high').length;
    const badge = $('alert-badge');
    badge.textContent = high;
    badge.classList.toggle('hidden', high === 0);
  }
};

/* ────────────────────────────────────────────
   EVENT MODULE
   ──────────────────────────────────────────── */
const E = {
  init() {
    this._dropzone();
    this._headerImport();
    this._privacy();
    this._export();
    this._feed();
    this._chartToggle();
    this._filterChips();
    this._tableSort();
    this._inlineEdit();
    this._quickActions();
  },

  /* ── Dropzone ── */
  _dropzone() {
    const dz = $('dropzone');
    const fi = $('dropzone-file');

    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', e => {
      e.preventDefault(); dz.classList.remove('drag-over');
      if (e.dataTransfer.files[0]) this._processFile(e.dataTransfer.files[0]);
    });
    dz.addEventListener('click', () => fi.click());
    dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fi.click(); });
    fi.addEventListener('change', e => { if (e.target.files[0]) this._processFile(e.target.files[0]); e.target.value = ''; });
  },

  /* ── Header import button ── */
  _headerImport() {
    $('import-file').addEventListener('change', e => {
      if (e.target.files[0]) this._processFile(e.target.files[0]);
      e.target.value = '';
    });
  },

  /* ── Process uploaded file ── */
  _processFile(file) {
    const reader = new FileReader();
    reader.onerror = () => alert('파일을 읽는 중 오류가 발생했습니다.');
    reader.onload = (ev) => {
      const text = ev.target.result;
      let result;

      if (file.name.toLowerCase().endsWith('.json')) {
        result = Parser.parseJSON(text);
        if (result.history && Object.keys(result.history).length > 0) {
          S.history = result.history;
        }
      } else {
        result = Parser.parseCSV(text);
      }

      if (result.assets && result.assets.length > 0) {
        S.assets = result.assets;
        S.errors = result.errors || [];
        S.dismissedErrors = new Set();
        Calc.snapshot();
        R.init();
        if (S.errors.length > 0) this._openFeed(); // Auto-open feed on errors
      } else {
        const msgs = result.errors?.length ? result.errors : ['파일에서 유효한 자산 데이터를 찾을 수 없습니다.'];
        alert('파일 처리 오류:\n' + msgs.join('\n'));
      }
    };
    reader.readAsText(file, 'UTF-8');
  },

  /* ── Privacy Eye Toggle ── */
  _privacy() {
    $('privacy-toggle').addEventListener('click', () => {
      S.privacy = !S.privacy;
      document.body.classList.toggle('privacy-on', S.privacy);
      $('privacy-toggle').classList.toggle('active-privacy', S.privacy);

      // Swap SVG icon
      $('privacy-icon').innerHTML = S.privacy
        ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`
        : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
    });
  },

  /* ── Export ── */
  _export() {
    $('export-btn').addEventListener('click', exportBackup);
  },

  /* ── Feed Panel ── */
  _feed() {
    $('feed-toggle-btn').addEventListener('click', () => this._openFeed());
    $('feed-close-btn').addEventListener('click', () => this._closeFeed());
    $('overlay').addEventListener('click', () => this._closeFeed());

    // Tab switching
    document.querySelectorAll('.feed-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.feed-tab').forEach(t => {
          t.classList.remove('active');
          t.setAttribute('aria-selected', 'false');
        });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        S.feedTab = tab.dataset.tab;
        R.feed();
      });
    });

    // Dismiss errors via event delegation (avoids inline onclick)
    $('feed-content').addEventListener('click', e => {
      const btn = e.target.closest('.dismiss-btn');
      if (!btn) return;
      S.dismissedErrors.add(btn.dataset.key);
      R.feed();
    });
  },

  _openFeed() {
    S.feedOpen = true;
    $('feed-panel').classList.add('open');
    $('overlay').classList.remove('hidden');
    R.feed();
  },

  _closeFeed() {
    S.feedOpen = false;
    $('feed-panel').classList.remove('open');
    $('overlay').classList.add('hidden');
  },

  /* ── Chart Mode Toggle ── */
  _chartToggle() {
    $('btn-chart-area').addEventListener('click', () => {
      S.chartMode = 'area';
      $('btn-chart-area').classList.add('active');
      $('btn-chart-bar').classList.remove('active');
      R.history();
    });
    $('btn-chart-bar').addEventListener('click', () => {
      S.chartMode = 'bar';
      $('btn-chart-bar').classList.add('active');
      $('btn-chart-area').classList.remove('active');
      R.history();
    });
  },

  /* ── Filter Chips — 0.15s fade transition ── */
  _filterChips() {
    $('filter-chips').addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      S.filter = chip.dataset.filter;
      R.table(S.filter);
    });
  },

  /* ── Table Sort (column header click) ── */
  _tableSort() {
    document.querySelectorAll('#asset-table th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.col;
        S.sortDir = S.sortCol === col && S.sortDir === 'asc' ? 'desc' : 'asc';
        S.sortCol = col;
        document.querySelectorAll('#asset-table th').forEach(t => delete t.dataset.sort);
        th.dataset.sort = S.sortDir;
        R.table();
      });
    });
  },

  /* ── Inline Edit (event delegation on tbody — no re-attachment needed) ── */
  _inlineEdit() {
    $('table-body').addEventListener('dblclick', e => {
      const cell = e.target.closest('td.editable');
      if (cell) this._startEdit(cell);
    });
  },

  _startEdit(cell) {
    if (cell.querySelector('input.cell-input')) return; // Already editing

    const row = cell.closest('tr');
    const id = row.dataset.id;
    const field = cell.dataset.field;
    const rawVal = cell.dataset.raw || '';
    const origHTML = cell.innerHTML;
    let committed = false;

    const input = document.createElement('input');
    input.className = 'cell-input';
    input.type = field === '현재가' ? 'number' : 'text';
    input.value = rawVal;
    cell.innerHTML = '';
    cell.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      if (committed) return;
      committed = true;

      const newVal = input.value.trim();
      const asset = S.assets.find(a => a.id === id);
      if (!asset) { cell.innerHTML = origHTML; return; }

      let diff = {};
      if (field === '현재가') {
        const price = parseFloat(newVal.replace(/,/g, ''));
        if (!isNaN(price) && price >= 0) {
          diff = {
            현재가: price,
            평가금액: asset.수량 * price,
            수익률: asset.매입단가 > 0 ? ((price - asset.매입단가) / asset.매입단가) * 100 : 0
          };
        }
      } else {
        diff = { 메모: newVal };
      }

      if (Object.keys(diff).length) {
        /* Partial localStorage update — only this asset's fields */
        Storage.patchAsset(id, diff);
        const updated = S.assets.find(a => a.id === id);

        /* In-place DOM update — no full table re-render */
        cell.dataset.raw = field === '현재가' ? String(updated.현재가) : (updated.메모 || '');
        cell.textContent = field === '현재가' ? KRW(updated.현재가) : (updated.메모 || '-');

        if (field === '현재가') {
          const cells = row.cells;
          const total = Calc.total();
          const w = total > 0 ? ((updated.평가금액 || 0) / total) * 100 : 0;
          const rc = updated.수익률 > 0 ? 'pos' : updated.수익률 < 0 ? 'neg' : '';

          // 평가금액 (index 6)
          cells[6].textContent = KRW(updated.평가금액);
          // 수익률 (index 7)
          cells[7].className = `num-col ${rc}`;
          cells[7].textContent = PCT(updated.수익률);
          // 비중 (index 8)
          cells[8].textContent = w.toFixed(1) + '%';
        }

        /* Update aggregate views (no table re-render) */
        Calc.snapshot();
        R.cards();
        R.donut();
        R.history();
        R.feed();
      } else {
        cell.innerHTML = origHTML;
      }
    };

    const cancel = () => {
      if (committed) return;
      committed = true;
      cell.innerHTML = origHTML;
    };

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
  },

  /* ── Quick Actions (onboarding) ── */
  _quickActions() {
    $('btn-template').addEventListener('click', downloadTemplate);
    $('btn-sample').addEventListener('click', () => {
      loadSampleData();
      R.init();
    });
  }
};

/* ────────────────────────────────────────────
   BOOTSTRAP
   ──────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // ============================================================
  // ☀️/🌙 THEME TOGGLE LOGIC (다크/라이트 모드 전환)
  // ============================================================
  const themeToggleBtn = document.getElementById('theme-toggle');
  const themeIcon = document.getElementById('theme-icon');

  // 1. 저장된 테마 상태 불러오기 (기본값: 다크 모드)
  const savedTheme = localStorage.getItem('theme_mode') || 'dark';

  if (savedTheme === 'light') {
    document.body.classList.add('light-mode');
    if (themeIcon) themeIcon.textContent = '☀️';
  } else {
    document.body.classList.remove('light-mode');
    if (themeIcon) themeIcon.textContent = '🌙';
  }

  // 2. 테마 버튼 클릭 이벤트 등록
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      // light-mode 클래스 토글
      const isLight = document.body.classList.toggle('light-mode');

      // 아이콘 변경 및 브라우저 저장(LocalStorage)
      if (isLight) {
        if (themeIcon) themeIcon.textContent = '☀️';
        localStorage.setItem('theme_mode', 'light');
      } else {
        if (themeIcon) themeIcon.textContent = '🌙';
        localStorage.setItem('theme_mode', 'dark');
      }

      // (선택 사항) Chart.js 차트가 있다면 테마 변경 시 차트 재렌더링 시도
      if (typeof renderCharts === 'function') {
        try { renderCharts(); } catch (e) { /* 차트 미생성 시 무시 */ }
      }
    });
  }
  Storage.load();
  R.init();
  E.init();
});
